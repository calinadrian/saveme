import { Quota } from '../../shared/types'
import { OAuthSession } from './oauth'
import { checkOk, HttpError, RemoteEntry, StorageProvider, TokenStore, TransferOptions } from './provider'
import { downloadFile, resumableFile, transferSignal } from './transfers'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const APPROOT = `${GRAPH}/me/drive/special/approot`
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024
/** Upload session chunks must be a multiple of 320 KiB. */
const CHUNK = 320 * 1024 * 32


/** OneDrive app folder (`Apps/SaveMe`) through Microsoft Graph. */
export class OneDriveProvider implements StorageProvider {
  readonly kind = 'onedrive' as const
  readonly label = 'OneDrive'
  private session: OAuthSession
  private directories = new Map<string, string>()

  constructor(
    clientId: string,
    private tokens: TokenStore,
    private openExternal: (url: string) => void,
    /** Subfolder inside Apps/SaveMe ('' = the app folder itself). */
    private base: string
  ) {
    this.session = new OAuthSession(
      {
        authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        clientId,
        scope: 'Files.ReadWrite.AppFolder User.Read offline_access',
        redirectHost: 'localhost'
      },
      () => tokens.load('onedrive'),
      (t) => tokens.save('onedrive', t)
    )
  }

  /** Path inside the app folder, with the chosen subfolder in front, URL-encoded per segment. */
  private enc(path: string): string {
    return [...this.base.split('/'), ...path.split('/')].filter(Boolean).map(encodeURIComponent).join('/')
  }

  private item(ref: string): string { return ref.startsWith('@') ? `${GRAPH}/me/drive/items/${encodeURIComponent(ref.slice(1))}` : `${APPROOT}:/${this.enc(ref)}:` }

  isConnected(): boolean {
    return this.session.hasRefreshToken
  }

  account(): string | undefined {
    return this.tokens.load('onedrive:account')
  }

  async connect(): Promise<void> {
    await this.session.signIn(this.openExternal)
    this.directories.clear()
    await this.quota()
  }

  async disconnect(): Promise<void> {
    this.directories.clear()
    this.session.signOut()
    this.tokens.save('onedrive:account', undefined)
  }

  private async fetch(url: string, init: RequestInit = {}, what = 'OneDrive', allow404 = false): Promise<Response> {
    init.signal ??= AbortSignal.timeout(30_000)
    init.signal?.throwIfAborted()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await this.session.token()}`)
    init.signal?.throwIfAborted()
    const res = await fetch(url, { ...init, headers })
    if (allow404 && res.status === 404) return res
    return checkOk(res, what)
  }

  async put(path: string, data: Buffer): Promise<void> {
    await this.ensureParent(path)
    if (data.length <= SIMPLE_UPLOAD_LIMIT) {
      await this.fetch(`${APPROOT}:/${this.enc(path)}:/content`, { method: 'PUT', body: new Uint8Array(data) }, 'Upload')
      return
    }
    const session = await this.fetch(
      `${APPROOT}:/${this.enc(path)}:/createUploadSession`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) },
      'Upload start'
    )
    const { uploadUrl } = (await session.json()) as { uploadUrl: string }
    for (let start = 0; start < data.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, data.length)
      // The upload URL is pre-authorized; it must not carry the bearer token.
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${start}-${end - 1}/${data.length}` },
        body: new Uint8Array(data.subarray(start, end))
      })
      await checkOk(res, 'Upload')
    }
  }

  async get(path: string): Promise<Buffer | undefined> {
    const res = await this.fetch(`${this.item(path)}/content`, {}, 'Download', true)
    if (res.status === 404) return undefined
    return Buffer.from(await res.arrayBuffer())
  }

  async list(dir: string, signal?: AbortSignal): Promise<RemoteEntry[]> {
    let url: string | undefined = dir ? `${this.item(dir)}/children?$select=id,name,size,folder&$top=999` : this.enc('') ? `${this.item('')}/children?$select=id,name,size,folder&$top=999` : `${APPROOT}/children?$select=id,name,size,folder&$top=999`
    const out: RemoteEntry[] = []
    while (url) {
      const res = await this.fetch(url, { signal }, 'List', true)
      if (res.status === 404) return out
      const body = (await res.json()) as { value: { id: string; name: string; size: number; folder?: unknown }[]; '@odata.nextLink'?: string }
      out.push(...body.value.map((v) => ({ name: v.name, size: v.size, ref: `@${v.id}`, directory: !!v.folder })))
      url = body['@odata.nextLink']
    }
    return out
  }

  async remove(path: string): Promise<void> {
    const url = path.startsWith('@') ? this.item(path) : `${APPROOT}:/${this.enc(path)}`
    await this.fetch(url, { method: 'DELETE' }, 'Delete', true)
  }

  async putFile(path: string, file: string, options: TransferOptions = {}): Promise<string> {
    await this.ensureParent(path, options.signal)
    const decode = async (response: Response, size: number): Promise<{ offset: number; ref?: string }> => {
      await checkOk(response, 'Upload')
      const body = await response.json() as { id?: string; nextExpectedRanges?: string[] }
      return body.id ? { offset: size, ref: `@${body.id}` } : { offset: Number(body.nextExpectedRanges?.[0]?.split('-')[0]) }
    }
    const ref = await resumableFile(file, CHUNK, options, {
      start: async () => {
        const response = await this.fetch(`${APPROOT}:/${this.enc(path)}:/createUploadSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }), signal: transferSignal(options) })
        return ((await response.json()) as { uploadUrl: string }).uploadUrl
      },
      send: async (url, bytes, start, size) => decode(await fetch(url, { method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${size}` }, body: new Uint8Array(bytes), signal: transferSignal(options) }), size),
      status: async (url, size) => decode(await fetch(url, { signal: transferSignal(options) }), size)
    })
    if (!ref) throw new Error('Storage did not confirm the uploaded file')
    return ref
  }

  async getFile(ref: string, file: string, options: TransferOptions = {}): Promise<boolean> {
    return downloadFile(signal => this.fetch(`${this.item(ref)}/content`, { signal }, 'Download', true),file,options)
  }

  /** Graph upload paths require parents to exist; concurrent folder creation uses fail/re-read. */
  private async ensureParent(relative: string, signal?: AbortSignal): Promise<void> {
    const parts = [...this.base.split('/'), ...relative.split('/').slice(0,-1)].filter(Boolean)
    let parent = APPROOT, key = ''
    for (const name of parts) {
      key += '/' + name
      const cached = this.directories.get(key)
      if (cached) { parent = `${GRAPH}/me/drive/items/${encodeURIComponent(cached)}`; continue }
      const url = `${parent}:/${encodeURIComponent(name)}`
      let found = await this.fetch(url,{ signal },'Find folder',true)
      if (found.status === 404) {
        try {
          found = await this.fetch(`${parent}/children`,{ method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) },'Create folder')
        } catch (e) { if (!(e instanceof HttpError) || e.status !== 409) throw e; found = await this.fetch(url,{ signal },'Find folder') }
      }
      const folder = await found.json() as { id: string; folder?: unknown }
      if (!folder.id || !folder.folder) throw new Error('Backup parent is not a folder')
      this.directories.set(key,folder.id); parent = `${GRAPH}/me/drive/items/${encodeURIComponent(folder.id)}`
    }
  }

  async quota(): Promise<Quota> {
    const res = await this.fetch(`${GRAPH}/me/drive?$select=quota,owner`)
    const body = (await res.json()) as { quota: { total: number; used: number }; owner?: { user?: { displayName?: string; email?: string } } }
    const account = body.owner?.user?.email ?? body.owner?.user?.displayName
    if (account) this.tokens.save('onedrive:account', account)
    return { totalBytes: body.quota.total, usedBytes: body.quota.used, account }
  }
}
