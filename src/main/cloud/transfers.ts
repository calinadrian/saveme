import fs from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpError, isTransient, TransferOptions } from './provider'

export function transferSignal(options: TransferOptions = {}): AbortSignal {
  return options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
}

export async function copyFile(source: string, target: string, options: TransferOptions = {}): Promise<void> {
  const total = (await fs.promises.stat(source)).size
  let completed = 0
  await pipeline(fs.createReadStream(source), new Transform({ transform(chunk, _encoding, done) {
    completed += chunk.length; options.progress?.(completed, total); done(null, chunk)
  } }), fs.createWriteStream(target, { flags: 'wx' }), { signal: options.signal })
  options.progress?.(total, total)
}

export async function downloadResponse(response: Response, file: string, options: TransferOptions = {}): Promise<void> {
  if (!response.body) throw new Error('Storage returned an empty response')
  const total = Number(response.headers.get('content-length')) || 0
  let completed = 0
  await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk, _encoding, done) {
    completed += chunk.length; options.progress?.(completed, total); done(null, chunk)
  } }), fs.createWriteStream(file, { flags: 'wx' }), { signal: options.signal })
  if (total && completed !== total) throw new Error('Incomplete download')
  options.progress?.(completed, total || completed)
}

/** Time out stalled transfers, while allowing large downloads that keep making progress. */
export async function downloadFile(request: (signal: AbortSignal) => Promise<Response>, file: string, options: TransferOptions = {}): Promise<boolean> {
  const idle = new AbortController()
  let timer: NodeJS.Timeout
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException('Download stalled', 'TimeoutError')), 120_000); timer.unref() }
  const signal = options.signal ? AbortSignal.any([options.signal,idle.signal]) : idle.signal
  reset()
  try {
    const response = await request(signal)
    if (response.status === 404) return false
    await downloadResponse(response,file,{ signal,progress: (n,t) => { reset(); options.progress?.(n,t) } })
    return true
  } finally { clearTimeout(timer!) }
}

/** Bounded buffers, server-confirmed offsets, and fresh sessions after expiration. */
export async function resumableFile(file: string, chunkSize: number, options: TransferOptions, protocol: {
  start: (size: number) => Promise<string>
  send: (url: string, bytes: Buffer, start: number, size: number) => Promise<{ offset: number; ref?: string }>
  status: (url: string, size: number) => Promise<{ offset: number; ref?: string }>
}): Promise<string | undefined> {
  options.signal?.throwIfAborted()
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('Invalid upload chunk size')
  const handle = await fs.promises.open(file, 'r')
  try {
    const size = (await handle.stat()).size
    for (let restart = 0; restart < 2; restart++) {
      const url = await protocol.start(size)
      let offset = 0, failures = 0, noProgress = 0
      while (offset < size || size === 0) {
        options.signal?.throwIfAborted()
        const length = Math.min(chunkSize, size - offset)
        const bytes = Buffer.allocUnsafe(length)
        let read = 0
        while (read < length) {
          const n = (await handle.read(bytes, read, length - read, offset + read)).bytesRead
          if (!n) throw new Error('Staged archive changed during upload')
          read += n
        }
        let state: { offset: number; ref?: string }
        try { state = await protocol.send(url, bytes, offset, size); failures = 0 }
        catch (error) {
          if (options.signal?.aborted || (!isTransient(error) && !(error instanceof HttpError && error.status === 404))) throw error
          if (++failures > 3) throw error
          try { state = await protocol.status(url, size) }
          catch (statusError) {
            if (statusError instanceof HttpError && statusError.status === 404 && restart === 0) break
            throw statusError
          }
        }
        if (!Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > size) throw new Error('Storage returned an invalid upload offset')
        if (state.offset <= offset) { if (++noProgress > 3) throw new Error('Storage upload made no progress') } else noProgress = 0
        offset = state.offset
        options.progress?.(offset, size)
        if (offset === size) return state.ref
      }
    }
    throw new Error('Upload session expired; retry this backup')
  } finally { await handle.close() }
}
