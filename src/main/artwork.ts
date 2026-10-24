import fs from 'node:fs/promises'
import path from 'node:path'

const WEEK = 7 * 24 * 3600_000
const MAX_BYTES = 3 * 1024 * 1024
type CachedArt = { checkedAt: number; data: string }

/** Steam uses hashed asset paths, and some headers have alternate filenames. */
export function steamArtworkUrls(value: unknown, steamId: number): string[] {
  const entry = (value as Record<string, { success?: boolean; data?: Record<string, unknown> }> | null)?.[steamId]
  if (!entry?.success) return []
  return [...new Set(['header_image', 'capsule_image', 'capsule_imagev5'].flatMap(key => {
    const raw = entry.data?.[key]
    if (typeof raw !== 'string') return []
    try {
      const url = new URL(raw)
      return url.protocol === 'https:' && url.hostname.endsWith('.steamstatic.com') && !url.username && !url.password && url.pathname.includes(`/steam/apps/${steamId}/`) ? [url.href] : []
    } catch { return [] }
  }))]
}

/** Disk cache for offline starts. Only the Steam app ID is sent to Steam. */
export class ArtworkStore {
  private pending = new Map<number, Promise<string | undefined>>()
  private active = 0
  private waiting: (() => void)[] = []

  constructor(private dir: string, private request: typeof fetch = fetch) {}

  get(steamId?: number): Promise<string | undefined> {
    if (!Number.isSafeInteger(steamId) || !steamId || steamId < 1) return Promise.resolve(undefined)
    let job = this.pending.get(steamId)
    if (!job) {
      job = this.resolve(steamId).finally(() => this.pending.delete(steamId))
      this.pending.set(steamId, job)
    }
    return job
  }

  private async resolve(steamId: number): Promise<string | undefined> {
    const file = path.join(this.dir, `${steamId}.json`)
    let cached: CachedArt | undefined
    try {
      const stored = JSON.parse(await fs.readFile(file, 'utf8')) as CachedArt
      if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(stored.data) && stored.data.length < MAX_BYTES * 1.4) cached = stored
      if (cached && Date.now() - cached.checkedAt < WEEK) return cached.data
    } catch { /* first load or an incomplete cache */ }

    if (this.active >= 4) await new Promise<void>(resolve => this.waiting.push(resolve))
    else this.active++
    try {
      const response = await this.request(`https://store.steampowered.com/api/appdetails?appids=${steamId}&l=english`, { signal: AbortSignal.timeout(8000) })
      if (!response.ok) return cached?.data
      const urls = steamArtworkUrls(await response.json(), steamId)
      for (const url of urls) {
        try {
          const image = await this.request(url, { signal: AbortSignal.timeout(8000), redirect: 'error' })
          const mime = image.headers.get('content-type')?.split(';')[0]
          if (!image.ok || !mime || !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) continue
          if (Number(image.headers.get('content-length')) > MAX_BYTES) { await image.body?.cancel(); continue }
          const reader = image.body?.getReader()
          if (!reader) continue
          const chunks: Uint8Array[] = []
          let size = 0
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > MAX_BYTES) { await reader.cancel(); break }
            chunks.push(chunk.value)
          }
          if (!size || size > MAX_BYTES) continue
          const data = `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`
          try {
            await fs.mkdir(this.dir, { recursive: true })
            await fs.writeFile(file + '.tmp', JSON.stringify({ checkedAt: Date.now(), data }))
            await fs.rename(file + '.tmp', file)
          } catch { /* display still works when the cache is unwritable */ }
          return data
        } catch { /* try the next official image format */ }
      }
      return cached?.data
    } catch {
      return cached?.data
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}
