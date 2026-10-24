import { Quota } from '../../shared/types'
import { OAuthSession } from './oauth'
import { checkOk, RemoteEntry, StorageProvider, TokenStore } from './provider'

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
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await this.session.token()}`)
    return checkOk(await fetch(url, { ...init, headers }), what)
  }

  private async findChild(parentId: string, name: string, folder?: boolean): Promise<string | undefined> {
    const query = [`name='${q(name)}'`, `'${parentId}' in parents`, 'trashed=false']
    if (folder) query.push(`mimeType='${FOLDER}'`)
    const res = await this.fetch(`${API}/files?` + new URLSearchParams({ q: query.join(' and '), fields: 'files(id)', pageSize: '1', spaces: 'drive' }))
    const body = (await res.json()) as { files: { id: string }[] }
    return body.files[0]?.id
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
  private async folderId(dir: string, create: boolean): Promise<string | undefined> {
    const parts = [...this.base.split('/'), ...dir.split('/')].filter(Boolean)
    let key = ''
    let id = 'root'
    for (const part of parts) {
      key = key ? `${key}/${part}` : part
      const cached = this.ids.get(key)
      if (cached) {
        id = cached
        continue
      }
      const found: string | undefined = (await this.findChild(id, part, true)) ?? (create ? await this.createFolder(id, part) : undefined)
      if (!found) return undefined
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
    const [dir, name] = this.split(path)
    const parent = await this.folderId(dir, false)
    return parent ? this.findChild(parent, name) : undefined
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
    const res = await this.fetch(`${API}/files/${id}?alt=media`, {}, 'Download')
    return Buffer.from(await res.arrayBuffer())
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const parent = await this.folderId(dir, false)
    if (!parent) return []
    const out: RemoteEntry[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({ q: `'${parent}' in parents and trashed=false`, fields: 'nextPageToken,files(name,size)', pageSize: '1000' })
      if (pageToken) params.set('pageToken', pageToken)
      const body = (await (await this.fetch(`${API}/files?${params}`)).json()) as { nextPageToken?: string; files: { name: string; size?: string }[] }
      out.push(...body.files.map((f) => ({ name: f.name, size: Number(f.size ?? 0) })))
      pageToken = body.nextPageToken
    } while (pageToken)
    return out
  }

  async remove(path: string): Promise<void> {
    const id = await this.fileId(path)
    if (id) await this.fetch(`${API}/files/${id}`, { method: 'DELETE' }, 'Delete')
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
