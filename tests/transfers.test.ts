import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { downloadResponse, resumableFile } from '../src/main/cloud/transfers'
import { GoogleDriveProvider } from '../src/main/cloud/gdrive'
import { OneDriveProvider } from '../src/main/cloud/onedrive'
import { HttpError, TokenStore } from '../src/main/cloud/provider'

const roots: string[] = []
function source() { const root = fs.mkdtempSync(path.join(os.tmpdir(),'saveme-transfer-')); roots.push(root); const file = path.join(root,'data'); fs.writeFileSync(file,'abcdefghijkl'); return file }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); roots.splice(0).forEach(root => fs.rmSync(root,{ recursive: true,force: true })) })
const tokens: TokenStore = { load: () => 'refresh',save: () => {} }

it('resumes at the server-confirmed offset after an interrupted chunk, using bounded buffers', async () => {
  const file = source(), sent: number[] = [], sizes: number[] = []
  let interrupted = false
  const result = await resumableFile(file,4,{}, {
    start: async () => 'session',
    send: async (_url,bytes,offset,size) => {
      sent.push(offset); sizes.push(bytes.length)
      if (!interrupted) { interrupted = true; throw new TypeError('connection lost after acceptance') }
      expect(bytes.toString()).toBe(offset === 4 ? 'efgh' : 'ijkl')
      return { offset: offset + bytes.length,ref: offset + bytes.length === size ? '@uploaded' : undefined }
    },
    status: async () => ({ offset: 4 })
  })
  expect(result).toBe('@uploaded'); expect(sent).toEqual([0,4,8]); expect(Math.max(...sizes)).toBe(4)
})

it('starts a fresh upload session after the previous session expires', async () => {
  const file = source(); let sessions = 0
  const ref = await resumableFile(file,4,{}, {
    start: async () => String(++sessions),
    send: async (session,bytes,offset) => { if (session === '1') throw new TypeError('offline'); return { offset: offset + bytes.length,ref: '@done' } },
    status: async () => { throw new HttpError(404,'expired') }
  })
  expect(ref).toBe('@done'); expect(sessions).toBe(2)
})

it('rejects stalled or invalid server upload offsets rather than looping', async () => {
  const file = source()
  await expect(resumableFile(file,4,{}, { start: async () => 'session',send: async () => ({ offset: 0 }),status: async () => ({ offset: 0 }) })).rejects.toThrow('no progress')
  await expect(resumableFile(file,4,{}, { start: async () => 'session',send: async () => ({ offset: 9999 }),status: async () => ({ offset: 0 }) })).rejects.toThrow('invalid upload offset')
})

it('propagates cancellation without querying or restarting the upload', async () => {
  const file = source(), controller = new AbortController(), status = vi.fn()
  controller.abort(new Error('cancelled'))
  await expect(resumableFile(file,4,{ signal: controller.signal },{ start: async () => 'session',send: vi.fn(),status })).rejects.toThrow('cancelled')
  expect(status).not.toHaveBeenCalled()
})

it('detects truncated streamed downloads', async () => {
  const file = source() + '.download'
  await expect(downloadResponse(new Response('abc',{ headers: { 'Content-Length': '8' } }),file)).rejects.toThrow('Incomplete download')
})

it('unions duplicate Google Drive folders and addresses the exact archive by its stable ID', async () => {
  const tree: Record<string,{ id: string; name: string; mimeType: string; size?: string }[]> = {
    root: [{ id: 'rootA',name: 'SaveMe',mimeType: 'application/vnd.google-apps.folder' },{ id: 'rootB',name: 'SaveMe',mimeType: 'application/vnd.google-apps.folder' }],
    rootA: [{ id: 'gameA',name: 'game',mimeType: 'application/vnd.google-apps.folder' }],
    rootB: [{ id: 'gameB',name: 'game',mimeType: 'application/vnd.google-apps.folder' }],
    gameA: [{ id: 'archiveA',name: 'one.zip',mimeType: 'application/zip',size: '3' }],
    gameB: [{ id: 'archiveB',name: 'two.zip',mimeType: 'application/zip',size: '3' }]
  }
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'access',expires_in: 3600 })
    if (init?.method === 'DELETE') return new Response('',{ status: 404 })
    if (url.pathname.endsWith('/files/archiveB')) return new Response('two')
    const query = url.searchParams.get('q') ?? '', parent = query.match(/'([^']+)' in parents/)?.[1] ?? ''
    const name = query.match(/name='([^']+)'/)?.[1]
    return Response.json({ files: (tree[parent] ?? []).filter(f => !name || f.name === name) })
  })
  vi.stubGlobal('fetch',request)
  const provider = new GoogleDriveProvider('id','secret',tokens,() => {},'SaveMe')
  const entries = await provider.list('game')
  expect(entries.map(e => e.ref).sort()).toEqual(['@archiveA','@archiveB'])
  expect((await provider.get('@archiveB'))?.toString()).toBe('two')
  await expect(provider.remove('@archiveB')).resolves.toBeUndefined()
  const deletion = request.mock.calls.find(([,init]) => init?.method === 'DELETE')
  expect(String(deletion?.[0])).toContain('/files/archiveB')
})

it('creates OneDrive metadata parents and handles another PC creating them concurrently', async () => {
  let lookup = 0
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/token')) return Response.json({ access_token: 'access',expires_in: 3600 })
    if (init?.method === 'POST' && url.endsWith('/children')) return new Response('name conflict',{ status: 409 })
    if (init?.method === 'PUT') return Response.json({ id: 'record' })
    if (++lookup % 2 === 1) return new Response('',{ status: 404 })
    return Response.json({ id: 'folder' + lookup,folder: {} })
  })
  vi.stubGlobal('fetch',request)
  const provider = new OneDriveProvider('id',tokens,() => {},'')
  await provider.put('game/_v2/record.json',Buffer.from('{}'))
  expect(request.mock.calls.filter(([url,init]) => init?.method === 'POST' && String(url).endsWith('/children'))).toHaveLength(2)
  expect(request.mock.calls.filter(([,init]) => init?.method === 'PUT')).toHaveLength(1)
})
