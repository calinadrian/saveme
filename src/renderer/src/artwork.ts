import { useEffect, useState } from 'react'
import type { Game } from '../../shared/types'
import minecraft from './assets/minecraft.jpg'
import { api } from './api'

type ArtworkGame = Pick<Game, 'id' | 'name' | 'steamId'>

/** Try alternate Steam artwork formats before showing the initials fallback. */
export function coverCandidates(game: ArtworkGame): string[] {
  if (game.name === 'Minecraft: Java Edition') return [minecraft]
  if (!game.steamId) return []
  return [
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${game.steamId}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.steamId}/header.jpg`,
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${game.steamId}/capsule_616x353.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.steamId}/library_600x900.jpg`
  ]
}

// Remember working artwork across list/detail navigation, but never cache failures.
const loaded = new Map<string, string>()

export function useCover(game?: ArtworkGame): string | undefined {
  const key = JSON.stringify([game?.id, game?.name, game?.steamId])
  const [result, setResult] = useState<{ key: string; url?: string }>()
  useEffect(() => {
    let cancelled = false
    let image: HTMLImageElement | undefined
    const clear = (): void => {
      if (image) image.onload = image.onerror = null
    }
    let attempt = 0
    const load = async (): Promise<void> => {
      const current = ++attempt
      clear()
      const cached = loaded.get(key)
      if (cached) {
        setResult({ key, url: cached })
        return
      }
      const candidates = game ? coverCandidates(game) : []
      if (game?.steamId) {
        try {
          const resolved = await api.artwork(game.id)
          if (cancelled || current !== attempt) return
          if (resolved) candidates.unshift(resolved)
        } catch { /* offline metadata: try the static CDN paths */ }
      }
      let index = 0
      const next = (): void => {
        if (cancelled || current !== attempt) return
        clear()
        const url = candidates[index++]
        if (!url) {
          setResult({ key })
          return
        }
        image = new Image()
        image.onload = () => {
          if (cancelled || current !== attempt) return
          loaded.set(key, url)
          setResult({ key, url })
        }
        image.onerror = next
        image.src = url
      }
      next()
    }
    load()
    window.addEventListener('online', load)
    return () => {
      cancelled = true
      clear()
      window.removeEventListener('online', load)
    }
  }, [key])
  return result?.key === key ? result.url : loaded.get(key)
}
