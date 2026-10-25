import { StorageProvider } from '../cloud/provider'

export const USAGE_TIMEOUT_MS = 20_000
const WORKERS = 4

/** Read-only, bounded parallel work. Never occupies the backup/restore coordinator. */
export async function measureBackupUsage(provider: StorageProvider, signal: AbortSignal, progress: (completed: number, total: number) => void): Promise<number> {
  if (provider.kind === 'local') await provider.quota()
  signal.throwIfAborted()
  const roots = (await provider.list('', signal)).filter(entry => /^[\w-]+$/.test(entry.name))
  let next = 0, completed = 0, bytes = 0
  progress(0, roots.length)
  await Promise.all(Array.from({ length: Math.min(WORKERS, roots.length) }, async () => {
    while (next < roots.length) {
      signal.throwIfAborted()
      const entry = roots[next++]
      const files = await provider.list(entry.ref ?? entry.name, signal)
      signal.throwIfAborted()
      for (const file of files) {
        if (!/\.zip(?:\.[\w-]+)?(?:\.part)?$/.test(file.name)) continue
        if (!Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(bytes + file.size)) throw new Error('Storage returned an invalid backup size')
        bytes += file.size
      }
      progress(++completed, roots.length)
    }
  }))
  return bytes
}
