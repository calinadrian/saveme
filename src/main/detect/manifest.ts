import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export const MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml'

export interface When {
  os?: string
  store?: string
}

/** Compact, Windows-only form of a Ludusavi manifest entry. */
export interface ManifestGame {
  name: string
  files: { path: string; when?: When[] }[]
  installDir: string[]
  steamId?: number
  gogId?: number
}

interface RawEntry {
  files?: Record<string, { when?: When[]; tags?: string[] } | null>
  installDir?: Record<string, unknown>
  steam?: { id?: number }
  gog?: { id?: number }
}

const NON_WINDOWS_PATH = /<(xdgData|xdgConfig)>|^<home>\/(Library|\.)/

function appliesToWindows(when?: When[]): boolean {
  return !when?.length || when.some((w) => !w.os || w.os === 'windows')
}

export function compactManifest(raw: Record<string, RawEntry>): ManifestGame[] {
  const out: ManifestGame[] = []
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry?.files) continue
    const files = Object.entries(entry.files)
      .filter(([p, info]) => !NON_WINDOWS_PATH.test(p) && appliesToWindows(info?.when))
      .map(([p, info]) => ({ path: p, when: info?.when?.filter((w) => !w.os || w.os === 'windows') }))
    if (!files.length) continue
    out.push({
      name,
      files,
      installDir: Object.keys(entry.installDir ?? {}),
      steamId: entry.steam?.id,
      gogId: entry.gog?.id
    })
  }
  return out
}

/**
 * Downloads the manifest when it changed (ETag) and keeps a compact JSON copy.
 * Falls back to the cached copy when offline.
 */
export async function loadManifest(dir: string, maxAgeMs = 7 * 24 * 3600 * 1000): Promise<ManifestGame[]> {
  const jsonFile = path.join(dir, 'manifest.json')
  const metaFile = path.join(dir, 'manifest.meta.json')
  let meta: { etag?: string; checkedAt?: number } = {}
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  } catch {
    // first run
  }
  const cached = fs.existsSync(jsonFile)
  if (!cached || !meta.checkedAt || Date.now() - meta.checkedAt > maxAgeMs) {
    try {
      const res = await fetch(MANIFEST_URL, { headers: cached && meta.etag ? { 'If-None-Match': meta.etag } : {} })
      if (res.status === 200) {
        const raw = yaml.load(await res.text()) as Record<string, RawEntry>
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(jsonFile, JSON.stringify(compactManifest(raw)))
        meta.etag = res.headers.get('etag') ?? undefined
      } else if (res.status !== 304 && !cached) {
        throw new Error(`Manifest download failed: HTTP ${res.status}`)
      }
      meta.checkedAt = Date.now()
      fs.writeFileSync(metaFile, JSON.stringify(meta))
    } catch (e) {
      if (!cached) throw e
    }
  }
  return JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
}
