import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtworkStore, steamArtworkUrls } from '../src/main/artwork'

const dirs: string[] = []
const tmp = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'saveme-art-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
const url = (id = 42, file = 'header_alt_assets_5.jpg') => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/hash/${file}`
const metadata = (id = 42) => Response.json({ [id]: { success: true, data: { header_image: url(id), capsule_image: url(id, 'capsule.jpg') } } })
const image = () => new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'Content-Type': 'image/jpeg' } })

describe('game artwork', () => {
  it('uses hashed and alternate filenames returned by Steam, with an exact host/path boundary', () => {
    expect(steamArtworkUrls({ 42: { success: true, data: {
      header_image: url(), capsule_image: 'https://shared.akamai.steamstatic.com.evil.test/steam/apps/42/header.jpg',
      capsule_imagev5: 'https://shared.akamai.steamstatic.com/steam/apps/43/header.jpg'
    } } }, 42)).toEqual([url()])
    expect(steamArtworkUrls({ 42: { success: false } }, 42)).toEqual([])
  })

  it('deduplicates concurrent lookups and serves the persisted image after restart without requests', async () => {
    const dir = await tmp()
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(image())
    const store = new ArtworkStore(dir, request)
    const [a, b] = await Promise.all([store.get(42), store.get(42)])
    expect(a).toBe('data:image/jpeg;base64,/9j/2Q==')
    expect(b).toBe(a)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][0]).toBe(url())
    const offline = vi.fn<typeof fetch>().mockRejectedValue(Error('offline'))
    expect(await new ArtworkStore(dir, offline).get(42)).toBe(a)
    expect(offline).not.toHaveBeenCalled()
  })

  it('keeps stale artwork available when Steam is offline', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, '42.json'), JSON.stringify({ checkedAt: 1, data: 'data:image/png;base64,YQ==' }))
    const request = vi.fn<typeof fetch>().mockRejectedValue(Error('offline'))
    expect(await new ArtworkStore(dir, request).get(42)).toBe('data:image/png;base64,YQ==')
  })

  it('rejects non-image responses and tries the official capsule when the header fails', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response('<html>error</html>')).mockResolvedValueOnce(image())
    expect(await new ArtworkStore(await tmp(), request).get(42)).toMatch(/^data:image\/jpeg;/)
    expect(request.mock.calls[2][0]).toBe(url(42, 'capsule.jpg'))
  })

  it('does not request invalid game IDs and retries after temporary metadata failures', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(metadata()).mockResolvedValueOnce(image())
    const store = new ArtworkStore(await tmp(), request)
    for (const id of [undefined, 0, -1, 1.5, NaN]) expect(await store.get(id)).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
    expect(await store.get(42)).toBeUndefined()
    expect(await store.get(42)).toMatch(/^data:image\/jpeg;/)
  })

  it('limits metadata/image work to four games at once', async () => {
    let active = 0, peak = 0
    const request = vi.fn<typeof fetch>(async (input) => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      const text = String(input)
      return text.includes('appdetails') ? metadata(Number(new URL(text).searchParams.get('appids'))) : image()
    })
    const store = new ArtworkStore(await tmp(), request)
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.get(i + 1)))
    expect(results.every(Boolean)).toBe(true)
    expect(peak).toBeLessThanOrEqual(4)
  })
})
