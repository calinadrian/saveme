import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { unzipSync, zipSync, Zippable } from 'fflate'
import { Game, SnapshotMeta } from '../../shared/types'
import { expandFiles, literalPrefix } from '../detect/scanner'
import { isUnder, KnownFolders, Portable } from '../detect/paths'

export const META_ENTRY = 'saveme.json'

/** Current save files of a game on this PC. */
export function collectFiles(game: Pick<Game, 'roots'>, folders: KnownFolders): string[] {
  const all = new Set<string>()
  for (const r of game.roots) expandFiles(r.resolved, folders, true).forEach((f) => all.add(f))
  return [...all].sort()
}

/** Glob-free start of each save root: what to open in Explorer. */
export function watchDirs(game: Pick<Game, 'roots'>): string[] {
  return [...new Set(game.roots.map((r) => literalPrefix(r.resolved).replace(/\\(.)/g, '$1')))]
}

/**
 * Folders that actually hold the saves. For wildcard roots like `Steam/userdata/<id>/123/remote`
 * the glob-free prefix (`Steam/userdata`) is far too broad to watch, so use the matched files' folders.
 */
export function saveDirs(game: Pick<Game, 'roots'>, folders: KnownFolders): string[] {
  const dirs = new Set<string>()
  for (const r of game.roots) {
    if (!/[*?[{]/.test(r.resolved)) {
      dirs.add(r.resolved.replace(/\\(.)/g, '$1'))
      continue
    }
    for (const f of expandFiles(r.resolved, folders)) dirs.add(f.slice(0, f.lastIndexOf('/')))
  }
  // Keep only the outermost folders; chokidar watches subfolders itself.
  const sorted = [...dirs].sort((a, b) => a.length - b.length)
  return sorted.filter((d, i) => !sorted.slice(0, i).some((p) => isUnder(d, p)))
}

const hashCache = new Map<string, { size: number; mtimeMs: number; hash: string }>()

export async function hashFile(file: string): Promise<string> {
  const st = await fs.promises.stat(file)
  const cached = hashCache.get(file)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.hash
  const hash = await new Promise<string>((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
  hashCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, hash })
  return hash
}

export interface LocalState {
  /** portable path -> sha256 */
  hashes: Record<string, string>
  /** portable path -> absolute path */
  paths: Record<string, string>
  bytes: Record<string, Buffer>
  sizeBytes: number
}

export async function localState(files: string[], portable: Portable): Promise<LocalState> {
  const state: LocalState = { hashes: {}, paths: {}, bytes: {}, sizeBytes: 0 }
  const signatures = new Map<string, string>()
  const signature = (s: fs.Stats): string => `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`
  for (const f of files) {
    const before = await fs.promises.stat(f)
    const data = await fs.promises.readFile(f)
    const after = await fs.promises.stat(f)
    if (signature(before) !== signature(after) || data.length !== after.size) throw new SnapshotBusyError(f)
    const key = portable.toPortable(f)
    state.hashes[key] = crypto.createHash('sha256').update(data).digest('hex')
    state.paths[key] = f
    state.bytes[key] = data
    state.sizeBytes += data.length
    signatures.set(f, signature(after))
  }
  for (const [f, sig] of signatures) if (signature(await fs.promises.stat(f)) !== sig) throw new SnapshotBusyError(f)
  return state
}

export class SnapshotBusyError extends Error {
  readonly code = 'SAVEME_BUSY'
  constructor(file: string) { super(`Save files are changing: ${file}. Will retry when they are quiet.`) }
}

export function sameHashes(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  if (!a || !b) return false
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

/** `<winAppData>/Foo/a.sav` <-> `winAppData/Foo/a.sav` so archives open cleanly in Explorer. */
export function toZipName(portable: string): string {
  return portable.replace(/^<drive:([A-Z])>/, 'drive-$1').replace(/^<([^>]+)>/, '$1')
}

export function fromZipName(name: string): string {
  return name.replace(/^drive-([A-Z])\//, '<drive:$1>/').replace(/^([A-Za-z]+)\//, '<$1>/')
}

export async function buildZip(state: LocalState, meta: unknown): Promise<Buffer> {
  const entries: Zippable = { [META_ENTRY]: Buffer.from(JSON.stringify(meta, null, 1)) }
  for (const [key, data] of Object.entries(state.bytes)) {
    entries[toZipName(key)] = [data, { level: 6 }]
  }
  return Buffer.from(zipSync(entries))
}

/** Validated bytes and their resolved destination on this PC. */
export interface RestoreFile { target: string; data: Buffer }

/** Validate every entry before touching any live save. The cloud index supplies the expected hashes. */
export function prepareRestore(zip: Buffer, portable: Portable, snapshot: Pick<SnapshotMeta, 'files' | 'sizeBytes'>): RestoreFile[] {
  const files: RestoreFile[] = []
  const seen = new Set<string>()
  const targets = new Set<string>()
  let total = 0
  let expanded = 0
  const entries = unzipSync(new Uint8Array(zip), { filter: (entry) => {
    expanded += entry.originalSize
    if (expanded > snapshot.sizeBytes + 16 * 1024 * 1024 || (entry.name !== META_ENTRY && entry.originalSize > snapshot.sizeBytes)) throw new Error('Snapshot entry exceeds its declared size')
    return true
  } })
  for (const [name, data] of Object.entries(entries)) {
    if (name === META_ENTRY || name.endsWith('/')) continue
    const parts = name.split('/')
    if (parts.length < 2 || parts.some(p => !p || p === '.' || p === '..' || /[\\:<>"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new Error(`Unsafe path in snapshot: ${name}`)
    const key = fromZipName(name)
    const target = portable.fromPortable(key)
    if (!target) throw new Error(`Cannot resolve snapshot destination: ${name}. Install the game or choose its save location first.`)
    if (!path.isAbsolute(target)) throw new Error(`Snapshot destination is not absolute: ${name}`)
    const canonical = path.resolve(target).toLowerCase()
    if (targets.has(canonical)) throw new Error(`Duplicate snapshot destination: ${name}`)
    if (!Object.hasOwn(snapshot.files, key) || crypto.createHash('sha256').update(data).digest('hex') !== snapshot.files[key]) throw new Error(`Snapshot integrity check failed: ${name}`)
    targets.add(canonical)
    seen.add(key)
    total += data.length
    files.push({ target, data: Buffer.from(data) })
  }
  if (!files.length || seen.size !== Object.keys(snapshot.files).length || total !== snapshot.sizeBytes) throw new Error('Snapshot is incomplete or has an incorrect size')
  return files
}
