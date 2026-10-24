import { Quota } from '../../shared/types'
import { OAuthSession } from './oauth'
import { checkOk, RemoteEntry, StorageProvider, TokenStore } from './provider'

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

  isConnected(): boolean {
    return this.session.hasRefreshToken
  }

  account(): string | undefined {
    return this.tokens.load('onedrive:account')
  }

  async connect(): Promise<void> {
    await this.session.signIn(this.openExternal)
    await this.quota()
  }

  async disconnect(): Promise<void> {
    this.session.signOut()
    this.tokens.save('onedrive:account', undefined)
  }

  private async fetch(url: string, init: RequestInit = {}, what = 'OneDrive', allow404 = false): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await this.session.token()}`)
    const res = await fetch(url, { ...init, headers })
    if (allow404 && res.status === 404) return res
    return checkOk(res, what)
  }

  async put(path: string, data: Buffer): Promise<void> {
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
    const res = await this.fetch(`${APPROOT}:/${this.enc(path)}:/content`, {}, 'Download', true)
    if (res.status === 404) return undefined
    return Buffer.from(await res.arrayBuffer())
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    let url: string | undefined = this.enc(dir) ? `${APPROOT}:/${this.enc(dir)}:/children?$select=name,size&$top=999` : `${APPROOT}/children?$select=name,size&$top=999`
    const out: RemoteEntry[] = []
    while (url) {
      const res = await this.fetch(url, {}, 'List', true)
      if (res.status === 404) return out
      const body = (await res.json()) as { value: { name: string; size: number }[]; '@odata.nextLink'?: string }
      out.push(...body.value.map((v) => ({ name: v.name, size: v.size })))
      url = body['@odata.nextLink']
    }
    return out
  }

  async remove(path: string): Promise<void> {
    await this.fetch(`${APPROOT}:/${this.enc(path)}`, { method: 'DELETE' }, 'Delete', true)
  }

  async quota(): Promise<Quota> {
    const res = await this.fetch(`${GRAPH}/me/drive?$select=quota,owner`)
    const body = (await res.json()) as { quota: { total: number; used: number }; owner?: { user?: { displayName?: string; email?: string } } }
    const account = body.owner?.user?.email ?? body.owner?.user?.displayName
    if (account) this.tokens.save('onedrive:account', account)
    return { totalBytes: body.quota.total, usedBytes: body.quota.used, account }
  }
}
