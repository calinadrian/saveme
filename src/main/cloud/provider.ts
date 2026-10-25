import { ProviderKind, Quota } from '../../shared/types'

export interface RemoteEntry {
  name: string
  size: number
  ref?: string
  directory?: boolean
}

export interface TransferOptions {
  signal?: AbortSignal
  progress?: (completed: number, total: number) => void
}

/**
 * Cloud storage, addressed by paths relative to the SaveMe folder
 * (e.g. `catalog.json`, `elden-ring-1a2b3c/index.json`).
 */
export interface StorageProvider {
  readonly kind: ProviderKind
  readonly label: string
  isConnected(): boolean
  /** Interactive sign-in (opens the browser). */
  connect(): Promise<void>
  disconnect(): Promise<void>
  account(): string | undefined
  put(path: string, data: Buffer): Promise<void>
  get(path: string): Promise<Buffer | undefined>
  list(dir: string, signal?: AbortSignal): Promise<RemoteEntry[]>
  remove(path: string): Promise<void>
  quota(): Promise<Quota>
  /** Archives use files, never whole-archive buffers. Returned references are stable object IDs. */
  putFile(path: string, file: string, options?: TransferOptions): Promise<string>
  getFile(ref: string, file: string, options?: TransferOptions): Promise<boolean>
}

export interface TokenStore {
  load(key: string): string | undefined
  save(key: string, value: string | undefined): void
}

export async function readJson<T>(p: StorageProvider, path: string): Promise<T | undefined> {
  const buf = await p.get(path)
  return buf ? (JSON.parse(buf.toString('utf8')) as T) : undefined
}

export async function writeJson(p: StorageProvider, path: string, value: unknown): Promise<void> {
  await p.put(path, Buffer.from(JSON.stringify(value, null, 1)))
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

/** Errors worth retrying later: offline, timeouts, rate limits, server errors. */
export function isTransient(e: unknown): boolean {
  if (e instanceof Error && e.name === 'TimeoutError') return true
  if (e instanceof HttpError) return e.status === 429 || e.status >= 500
  return e instanceof TypeError || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'SAVEME_BUSY', 'EBUSY', 'EACCES', 'EPERM', 'ENOENT'].includes((e as { code?: string })?.code ?? '')
}

export async function checkOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new HttpError(res.status, `${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  return res
}
