import { afterEach, expect, it, vi } from 'vitest'
import { OAuthSession } from '../src/main/cloud/oauth'
import { GoogleDriveProvider } from '../src/main/cloud/gdrive'
import { OneDriveProvider } from '../src/main/cloud/onedrive'
import { isTransient, TokenStore } from '../src/main/cloud/provider'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const cfg = { clientId: 'test', scope: 'test', authUrl: 'https://example.invalid/auth', tokenUrl: 'https://example.invalid/token', redirectHost: 'localhost' }

it('retries token-request timeouts without treating deliberate cancellation as a network failure', () => {
  expect(isTransient(new DOMException('Token request timed out', 'TimeoutError'))).toBe(true)
  expect(isTransient(new DOMException('Cancelled', 'AbortError'))).toBe(false)
})

it('shares token refreshes across parallel listing requests', async () => {
  let release!: (response: Response) => void
  const request = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
  vi.stubGlobal('fetch', request)
  const session = new OAuthSession(cfg, () => 'refresh', () => {})
  const tokens = Promise.all([session.token(), session.token(), session.token(), session.token()])
  expect(request).toHaveBeenCalledOnce()
  release(Response.json({ access_token: 'access', expires_in: 3600 }))
  expect(await tokens).toEqual(['access', 'access', 'access', 'access'])
})

it('does not restore a signed-out session when an older token refresh finishes', async () => {
  let release!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve })))
  let refresh: string | undefined = 'refresh'
  const save = vi.fn((value: string | undefined) => { refresh = value })
  const session = new OAuthSession(cfg, () => refresh, save)
  const pending = session.token()
  session.signOut()
  release(Response.json({ access_token: 'access', refresh_token: 'late-refresh', expires_in: 3600 }))
  await expect(pending).rejects.toThrow('Sign-in changed')
  expect(refresh).toBeUndefined()
  expect(save).toHaveBeenCalledTimes(1)
})

it.each(['gdrive', 'onedrive'] as const)('cancels an in-flight %s listing through its abort signal', async kind => {
  const values: Record<string, string> = { [kind]: 'refresh' }
  const store: TokenStore = { load: key => values[key], save: (key, value) => { if (value) values[key] = value; else delete values[key] } }
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/token')) return Response.json({ access_token: 'access', expires_in: 3600 })
    if (url.includes('fields=files%28id%29')) return Response.json({ files: [{ id: 'root-folder' }] })
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
  })
  vi.stubGlobal('fetch', request)
  const provider = kind === 'gdrive' ? new GoogleDriveProvider('id', 'secret', store, () => {}, 'SaveMe') : new OneDriveProvider('id', store, () => {}, '')
  const controller = new AbortController()
  const listing = provider.list('', controller.signal)
  await vi.waitFor(() => expect(request.mock.calls.some(([url]) => String(url).includes(kind === 'gdrive' ? 'pageSize=1000' : '/children'))).toBe(true))
  controller.abort(new Error('cancelled scan'))
  await expect(listing).rejects.toThrow('cancelled scan')
  expect(request.mock.calls.at(-1)?.[1]?.signal).toBe(controller.signal)
})
