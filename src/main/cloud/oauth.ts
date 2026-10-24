import http from 'node:http'
import crypto from 'node:crypto'
import { AddressInfo } from 'node:net'
import { checkOk } from './provider'

export interface OAuthConfig {
  authUrl: string
  tokenUrl: string
  clientId: string
  clientSecret?: string
  scope: string
  /** Host used in the redirect URI. Google wants 127.0.0.1, Microsoft accepts localhost on any port. */
  redirectHost: string
  extraAuthParams?: Record<string, string>
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>SaveMe</title>
<body style="font-family:system-ui;background:#0f1115;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>SaveMe is connected</h2><p>You can close this tab.</p></div>`

/** Authorization code flow with PKCE and a loopback redirect. */
export async function authorize(cfg: OAuthConfig, openExternal: (url: string) => void): Promise<TokenResponse> {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const state = crypto.randomBytes(16).toString('hex')

  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://${cfg.redirectHost}:${port}`

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Sign-in timed out')), 5 * 60 * 1000)
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri)
        const got = url.searchParams.get('code')
        const err = url.searchParams.get('error')
        if (!got && !err) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(err ? `Sign-in failed: ${err}` : DONE_PAGE)
        clearTimeout(timeout)
        if (err) reject(new Error(`Sign-in failed: ${err}`))
        else if (url.searchParams.get('state') !== state) reject(new Error('Sign-in failed: state mismatch'))
        else resolve(got!)
      })
      const auth = new URL(cfg.authUrl)
      const params: Record<string, string> = {
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: cfg.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...cfg.extraAuthParams
      }
      for (const [k, v] of Object.entries(params)) auth.searchParams.set(k, v)
      openExternal(auth.toString())
    })

    return await tokenRequest(cfg, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    })
  } finally {
    server.close()
  }
}

export async function tokenRequest(cfg: OAuthConfig, body: Record<string, string>): Promise<TokenResponse> {
  const form = new URLSearchParams({ client_id: cfg.clientId, ...body })
  if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret)
  if (body.grant_type === 'refresh_token') form.set('scope', cfg.scope)
  const res = await fetch(cfg.tokenUrl, {
    signal: AbortSignal.timeout(20_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  })
  await checkOk(res, 'Token request')
  return (await res.json()) as TokenResponse
}

/** Keeps an access token fresh using a stored refresh token. */
export class OAuthSession {
  private access?: { token: string; expiresAt: number }
  private refreshing?: Promise<string>
  private generation = 0

  constructor(
    private cfg: OAuthConfig,
    private loadRefresh: () => string | undefined,
    private saveRefresh: (token: string | undefined) => void
  ) {}

  get hasRefreshToken(): boolean {
    return !!this.loadRefresh()
  }

  async signIn(openExternal: (url: string) => void): Promise<void> {
    const generation = ++this.generation
    this.refreshing = undefined
    const tokens = await authorize(this.cfg, openExternal)
    if (generation !== this.generation) throw new Error('Sign-in was cancelled')
    this.accept(tokens)
  }

  signOut(): void {
    this.generation++
    this.refreshing = undefined
    this.access = undefined
    this.saveRefresh(undefined)
  }

  async token(): Promise<string> {
    if (this.access && Date.now() < this.access.expiresAt - 60_000) return this.access.token
    if (this.refreshing) return this.refreshing
    const refresh = this.loadRefresh()
    if (!refresh) throw new Error('Not signed in')
    const generation = this.generation
    const work = tokenRequest(this.cfg, { grant_type: 'refresh_token', refresh_token: refresh }).then(tokens => {
      if (generation !== this.generation) throw new Error('Sign-in changed during token refresh')
      this.accept(tokens)
      return this.access!.token
    })
    this.refreshing = work
    try { return await work }
    finally { if (this.refreshing === work) this.refreshing = undefined }
  }

  private accept(t: TokenResponse): void {
    this.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 }
    if (t.refresh_token) this.saveRefresh(t.refresh_token)
  }
}
