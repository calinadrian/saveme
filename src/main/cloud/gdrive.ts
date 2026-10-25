import { Quota } from '../../shared/types'
import { OAuthSession } from './oauth'
import { checkOk, HttpError, RemoteEntry, StorageProvider, TokenStore, TransferOptions } from './provider'
import { downloadFile, resumableFile, transferSignal } from './transfers'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER = 'application/vnd.google-apps.folder'

const q = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/**
 * Google Drive with the `drive.file` scope: SaveMe only sees the files it created,
 * stored under the chosen folder in My Drive (`base`, e.g. "SaveMe" or "Backups/Games").
 */
export class GoogleDriveProvider implements StorageProvider {
  readonly kind = 'gdrive' as const
  readonly label = 'Google Drive'
  private session: OAuthSession
  private ids = new Map<string, string>()

  constructor(
    clientId: string,
    clientSecret: string,
    private tokens: TokenStore,
    private openExternal: (url: string) => void,
    private base: string
  ) {
    this.session = new OAuthSession(
      {
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientId,
        clientSecret,
        scope: 'https://www.googleapis.com/auth/drive.file',
        redirectHost: '127.0.0.1',
        extraAuthParams: { access_type: 'offline', prompt: 'consent' }
      },
      () => tokens.load('gdrive'),
      (t) => tokens.save('gdrive', t)
    )
  }

  isConnected(): boolean {
    return this.session.hasRefreshToken
  }

  account(): string | undefined {
    return this.tokens.load('gdrive:account')
  }

  async connect(): Promise<void> {
    await this.session.signIn(this.openExternal)
    this.ids.clear()
    await this.quota()
  }

  async disconnect(): Promise<void> {
    this.session.signOut()
    this.tokens.save('gdrive:account', undefined)
    this.ids.clear()
  }

  private async fetch(url: string, init: RequestInit = {}, what = 'Google Drive'): Promise<Response> {
    init.signal ??= AbortSignal.timeout(30_000)
    init.signal?.throwIfAborted()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await this.session.token()}`)
    init.signal?.throwIfAborted()
    return checkOk(await fetch(url, { ...init, headers }), what)
  }

  private async findChild(parentId: string, name: string, folder?: boolean, signal?: AbortSignal): Promise<string | undefined> {
    const query = [`name='${q(name)}'`, `'${parentId}' in parents`, 'trashed=false']
    if (folder) query.push(`mimeType='${FOLDER}'`)
    const res = await this.fetch(`${API}/files?` + new URLSearchParams({ q: query.join(' and '), fields: 'files(id)', pageSize: '1', spaces: 'drive' }), { signal })
    const body = (await res.json()) as { files: { id: string }[] }
    return body.files[0]?.id
  }

  private async children(parent: string, name?: string, signal?: AbortSignal): Promise<{ id: string; name: string; size?: string; mimeType: string }[]> {
    const out: { id: string; name: string; size?: string; mimeType: string }[] = []
    let token: string | undefined
    do {
      const params = new URLSearchParams({ q: `'${q(parent)}' in parents and trashed=false${name ? ` and name='${q(name)}'` : ''}`, fields: 'nextPageToken,files(id,name,size,mimeType)', pageSize: '1000' })
      if (token) params.set('pageToken', token)
      const body = await (await this.fetch(`${API}/files?${params}`, { signal })).json() as { files: typeof out; nextPageToken?: string }
      out.push(...body.files); token = body.nextPageToken
    } while (token)
    return out
  }

  private async folderIds(dir: string, signal?: AbortSignal): Promise<string[]> {
    if (dir.startsWith('@')) return [dir.slice(1)]
    let ids = ['root']
    for (const part of [...this.base.split('/'), ...dir.split('/')].filter(Boolean)) {
      const next: string[] = []
      for (const id of ids) next.push(...(await this.children(id, part, signal)).filter(f => f.mimeType === FOLDER).map(f => f.id))
      ids = [...new Set(next)]
    }
    return ids
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const res = await this.fetch(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] })
    })
    return ((await res.json()) as { id: string }).id
  }

  /** Folder id for a dir relative to the backup folder ('' = the backup folder itself), creating folders when asked. */
  private async folderId(dir: string, create: boolean, signal?: AbortSignal): Promise<string | undefined> {
    const parts = [...this.base.split('/'), ...dir.split('/')].filter(Boolean)
    let key = ''
    let id = 'root'
    for (const part of parts) {
      signal?.throwIfAborted()
      key = key ? `${key}/${part}` : part
      const cached = this.ids.get(key)
      if (cached) {
        id = cached
        continue
      }
      const found: string | undefined = (await this.findChild(id, part, true, signal)) ?? (create ? await this.createFolder(id, part) : undefined)
      if (!found) return undefined
      signal?.throwIfAborted()
      this.ids.set(key, found)
      id = found
    }
    return id
  }

  private split(path: string): [string, string] {
    const i = path.lastIndexOf('/')
    return i === -1 ? ['', path] : [path.slice(0, i), path.slice(i + 1)]
  }

  private async fileId(path: string): Promise<string | undefined> {
    if (path.startsWith('@')) return path.slice(1)
    const [dir, name] = this.split(path)
    for (const parent of await this.folderIds(dir)) {
      const found = (await this.children(parent, name)).sort((a, b) => a.id.localeCompare(b.id))[0]
      if (found) return found.id
    }
    return undefined
  }

  async put(path: string, data: Buffer): Promise<void> {
    const [dir, name] = this.split(path)
    const parent = (await this.folderId(dir, true))!
    const existing = await this.findChild(parent, name)
    // Resumable upload works for any size: one request opens the session, one sends the bytes.
    const init = await this.fetch(
      existing ? `${UPLOAD}/files/${existing}?uploadType=resumable` : `${UPLOAD}/files?uploadType=resumable`,
      {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(data.length) },
        body: JSON.stringify(existing ? {} : { name, parents: [parent] })
      },
      'Upload start'
    )
    const location = init.headers.get('location')
    if (!location) throw new Error('Google Drive did not return an upload URL')
    await this.fetch(location, { method: 'PUT', body: new Uint8Array(data) }, 'Upload')
  }

  async get(path: string): Promise<Buffer | undefined> {
    const id = await this.fileId(path)
    if (!id) return undefined
    try {
      const res = await this.fetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, {}, 'Download')
      return Buffer.from(await res.arrayBuffer())
    } catch (e) { if (e instanceof HttpError && e.status === 404) return undefined; throw e }
  }

  async list(dir: string, signal?: AbortSignal): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = []
    for (const parent of await this.folderIds(dir, signal)) out.push(...(await this.children(parent, undefined, signal)).map(f => ({ name: f.name, size: Number(f.size ?? 0), ref: `@${f.id}`, directory: f.mimeType === FOLDER })))
    return out
  }

  async putFile(path: string, file: string, options: TransferOptions = {}): Promise<string> {
    const [dir, name] = this.split(path)
    const parent = (await this.folderId(dir, true))!
    const decode = async (response: Response, size: number): Promise<{ offset: number; ref?: string }> => {
      if (response.status === 308) return { offset: Number(response.headers.get('range')?.match(/-(\d+)$/)?.[1] ?? -1) + 1 }
      await checkOk(response, 'Upload')
      const body = await response.json() as { id: string }
      return { offset: size, ref: `@${body.id}` }
    }
    const ref = await resumableFile(file, 8 * 1024 * 1024, options, {
      start: async size => {
        const response = await this.fetch(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
          method: 'POST', signal: transferSignal(options), headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(size) }, body: JSON.stringify({ name, parents: [parent] })
        })
        const url = response.headers.get('location')
        if (!url) throw new Error('Storage did not return an upload session')
        return url
      },
      send: async (url, bytes, start, size) => {
        const headers = { Authorization: `Bearer ${await this.session.token()}`, 'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${size}` }
        return decode(await fetch(url, { method: 'PUT', headers, body: new Uint8Array(bytes), signal: transferSignal(options) }), size)
      },
      status: async (url, size) => decode(await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${await this.session.token()}`, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }, signal: transferSignal(options) }), size)
    })
    if (!ref) throw new Error('Storage did not confirm the uploaded file')
    return ref
  }

  async getFile(ref: string, file: string, options: TransferOptions = {}): Promise<boolean> {
    const id = await this.fileId(ref)
    if (!id) return false
    try { return await downloadFile(signal => this.fetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, { signal }), file, options) }
    catch (e) { if (e instanceof HttpError && e.status === 404) return false; throw e }
  }

  async remove(path: string): Promise<void> {
    const id = await this.fileId(path)
    if (id) {
      try { await this.fetch(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Delete') }
      catch (e) { if (!(e instanceof HttpError) || e.status !== 404) throw e }
    }
  }

  async quota(): Promise<Quota> {
    const res = await this.fetch(`${API}/about?fields=storageQuota,user(emailAddress)`)
    const body = (await res.json()) as { storageQuota: { limit?: string; usage?: string }; user?: { emailAddress?: string } }
    if (body.user?.emailAddress) this.tokens.save('gdrive:account', body.user.emailAddress)
    return {
      totalBytes: body.storageQuota.limit ? Number(body.storageQuota.limit) : undefined,
      usedBytes: Number(body.storageQuota.usage ?? 0),
      account: body.user?.emailAddress
    }
  }
}
