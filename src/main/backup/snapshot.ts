import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { unzipSync, zipSync, Zippable } from 'fflate'
import { Game } from '../../shared/types'
import { expandFiles, literalPrefix } from '../detect/scanner'
import { KnownFolders, Portable } from '../detect/paths'

export const META_ENTRY = 'saveme.json'

/** Current save files of a game on this PC. */
export function collectFiles(game: Pick<Game, 'roots'>, folders: KnownFolders): string[] {
  const all = new Set<string>()
  for (const r of game.roots) expandFiles(r.resolved, folders).forEach((f) => all.add(f))
  return [...all].sort()
}

/** Folders worth watching for changes (glob-free prefixes of the save roots). */
export function watchDirs(game: Pick<Game, 'roots'>): string[] {
  return [...new Set(game.roots.map((r) => literalPrefix(r.resolved).replace(/\\(.)/g, '$1')))]
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
  sizeBytes: number
}

export async function localState(files: string[], portable: Portable): Promise<LocalState> {
  const state: LocalState = { hashes: {}, paths: {}, sizeBytes: 0 }
  for (const f of files) {
    try {
      const key = portable.toPortable(f)
      state.hashes[key] = await hashFile(f)
      state.paths[key] = f
      state.sizeBytes += (await fs.promises.stat(f)).size
    } catch {
      // file disappeared between listing and hashing (game still writing): skip it
    }
  }
  return state
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
  for (const [key, abs] of Object.entries(state.paths)) {
    entries[toZipName(key)] = [await fs.promises.readFile(abs), { level: 6 }]
  }
  return Buffer.from(zipSync(entries))
}

/** Writes snapshot files back to their locations on this PC. Returns the files written. */
export async function extractZip(zip: Buffer, portable: Portable): Promise<string[]> {
  const entries = unzipSync(new Uint8Array(zip))
  const written: string[] = []
  for (const [name, data] of Object.entries(entries)) {
    if (name === META_ENTRY || name.endsWith('/')) continue
    const target = portable.fromPortable(fromZipName(name))
    if (!target) continue // e.g. <base> for a game not installed here
    if (target.split('/').includes('..')) throw new Error(`Unsafe path in snapshot: ${name}`)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(target, data)
    written.push(target)
  }
  return written
}
