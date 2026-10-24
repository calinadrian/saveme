import fs from 'node:fs'
import crypto from 'node:crypto'
import fg from 'fast-glob'
import { Game, SaveRoot } from '../../shared/types'
import { InstalledGame, LauncherInfo } from './launchers'
import { ManifestGame, When } from './manifest'
import { KnownFolders, norm } from './paths'

export interface ResolveContext {
  folders: KnownFolders
  base?: string
  root?: string
  storeGameId?: number
}

/** Substitute manifest placeholders. Returns undefined if the path needs info we don't have. */
export function resolveTemplate(template: string, ctx: ResolveContext): string | undefined {
  let missing = false
  const glob = (s: string): string => fg.convertPathToPattern(s)
  const out = template.replace(/<(\w+)>/g, (_, token: string) => {
    switch (token) {
      case 'base':
        if (!ctx.base) missing = true
        return ctx.base ? glob(ctx.base) : ''
      case 'root':
        if (!ctx.root) missing = true
        return ctx.root ? glob(ctx.root) : ''
      case 'game':
        if (!ctx.base) missing = true
        return ctx.base ? glob(ctx.base.split('/').pop()!) : ''
      case 'storeUserId':
        return '*'
      case 'storeGameId':
        return ctx.storeGameId ? String(ctx.storeGameId) : '*'
      case 'osUserName':
        return glob(ctx.folders.osUserName)
      case 'home':
      case 'winAppData':
      case 'winLocalAppData':
      case 'winLocalAppDataLow':
      case 'winDocuments':
      case 'winPublic':
      case 'winProgramData':
      case 'winDir':
        return glob(ctx.folders[token])
      default:
        missing = true
        return ''
    }
  })
  // Values were escaped for glob use above, so only collapse slashes here (norm() would turn `\(` into `/(`).
  return missing ? undefined : out.replace(/\/{2,}/g, '/')
}

/** Part of a glob pattern before the first wildcard, as a directory. */
export function literalPrefix(pattern: string): string {
  const idx = pattern.search(/[*?[{]/)
  if (idx === -1) return pattern
  return pattern.slice(0, pattern.lastIndexOf('/', idx))
}

function unescape(p: string): string {
  return p.replace(/\\(.)/g, '$1')
}

function tooBroad(dir: string, folders: KnownFolders): boolean {
  const d = norm(dir).toLowerCase()
  if (/^[a-z]:\/?$/.test(d)) return true
  const roots = [folders.home, folders.winAppData, folders.winLocalAppData, folders.winLocalAppDataLow, folders.winDocuments,
    folders.winPublic, folders.winProgramData, folders.winDir, folders.home + '/AppData', folders.home + '/Saved Games']
  return roots.some((r) => norm(r).toLowerCase() === d)
}

/** Not saves: churn that would trigger pointless backups (logs, crash dumps, caches). */
const IGNORED_FILE = /(^|\/)(desktop\.ini|thumbs\.db)$|\.(log|dmp|tmp)$|\/(logs?|crashes|crashreports?|webcache[^/]*|shadercache|cache)\//i

/** Expand a resolved pattern to concrete files (directories are walked recursively). */
export function expandFiles(pattern: string, folders: KnownFolders, strict = false): string[] {
  const prefix = unescape(literalPrefix(pattern))
  if (!prefix || !fs.existsSync(prefix)) return []
  const hasGlob = /[*?[{]/.test(pattern)
  let matches: string[]
  if (hasGlob) {
    matches = fg.sync(pattern, { onlyFiles: false, caseSensitiveMatch: false, dot: true, absolute: true, suppressErrors: !strict, markDirectories: true })
  } else {
    matches = [prefix + (fs.statSync(prefix).isDirectory() ? '/' : '')]
  }
  const files: string[] = []
  for (const m of matches) {
    if (m.endsWith('/')) {
      if (tooBroad(m, folders)) continue
      const base = fg.convertPathToPattern(m.slice(0, -1))
      files.push(...fg.sync(base + '/**/*', { dot: true, absolute: true, suppressErrors: !strict }))
    } else {
      files.push(m)
    }
  }
  return [...new Set(files.map(norm))].filter((f) => !IGNORED_FILE.test(f))
}

export function gameId(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return `${slug || 'game'}-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 6)}`
}

function storeMatches(when: When[] | undefined, store?: string): boolean {
  if (!when?.length || !store) return true
  return when.some((w) => !w.store || w.store === store)
}

const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function matchInstall(m: ManifestGame, installs: InstalledGame[], byFolder: Map<string, InstalledGame>, byName: Map<string, InstalledGame>): InstalledGame | undefined {
  if (m.steamId) {
    const hit = installs.find((g) => g.steamId === m.steamId)
    if (hit) return hit
  }
  if (m.gogId) {
    const hit = installs.find((g) => g.gogId === m.gogId)
    if (hit) return hit
  }
  for (const dir of m.installDir) {
    const hit = byFolder.get(dir.toLowerCase())
    if (hit) return hit
  }
  return byName.get(normName(m.name))
}

export interface ScanResult {
  game: Omit<Game, 'tracked' | 'status'>
  files: string[]
}

/** Builds the save roots of one game and lists its current files. */
export function resolveGame(m: Pick<ManifestGame, 'files'>, folders: KnownFolders, install?: InstalledGame, steamRoot?: string): { roots: SaveRoot[]; files: string[] } {
  const ctx: ResolveContext = {
    folders,
    base: install?.installDir,
    root: install?.store === 'steam' ? steamRoot : undefined,
    storeGameId: install?.steamId ?? install?.gogId
  }
  const roots: SaveRoot[] = []
  const files = new Set<string>()
  for (const f of m.files) {
    if (!storeMatches(f.when, install?.store)) continue
    const resolved = resolveTemplate(f.path, ctx)
    if (!resolved) continue
    const found = expandFiles(resolved, folders)
    if (!found.length) continue
    roots.push({ template: f.path, resolved })
    found.forEach((x) => files.add(x))
  }
  return { roots, files: [...files] }
}

export function scanGames(manifest: ManifestGame[], launchers: LauncherInfo, folders: KnownFolders, onProgress?: (done: number, total: number) => void): ScanResult[] {
  const byFolder = new Map(launchers.games.map((g) => [g.installDir.split('/').pop()!.toLowerCase(), g]))
  const byName = new Map(launchers.games.map((g) => [normName(g.name), g]))
  const results: ScanResult[] = []
  manifest.forEach((m, i) => {
    if (onProgress && i % 500 === 0) onProgress(i, manifest.length)
    const install = matchInstall(m, launchers.games, byFolder, byName)
    const { roots, files } = resolveGame(m, folders, install, launchers.steamRoot)
    if (!files.length) return
    let size = 0
    for (const f of files) {
      try {
        size += fs.statSync(f).size
      } catch {
        // vanished
      }
    }
    results.push({
      game: {
        id: gameId(m.name),
        name: m.name,
        store: install?.store,
        steamId: install?.steamId ?? m.steamId,
        installDir: install?.installDir,
        roots,
        sizeBytes: size,
        fileCount: files.length
      },
      files
    })
  })
  onProgress?.(manifest.length, manifest.length)
  return results
}
