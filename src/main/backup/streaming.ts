import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import yauzl from 'yauzl'
import { OperationProgress, SnapshotMeta } from '../../shared/types'
import { Portable } from '../detect/paths'
import { META_ENTRY, SnapshotBusyError, toZipName, fromZipName } from './snapshot'

export type Progress = (stage: OperationProgress['stage'], completed: number, total?: number, unit?: 'bytes' | 'files') => void
export interface StagedState { hashes: Record<string, string>; paths: Record<string, string>; sizeBytes: number }
const signature = (s: fs.Stats): string => `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`

export async function freeSpace(directory: string, needed: number): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true })
  const s = await fs.promises.statfs(directory)
  if (s.bavail * s.bsize < needed + 16 * 1024 * 1024) throw Object.assign(new Error('Not enough temporary disk space. Free some space and retry.'), { code: 'ENOSPC' })
}

export async function hashStream(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Hash-only comparisons and disk-staged capture share the same consistency checks. */
export async function capture(files: string[], portable: Portable, directory?: string, progress: Progress = () => {}): Promise<StagedState> {
  const state: StagedState = { hashes: {}, paths: {}, sizeBytes: 0 }
  const before = await Promise.all(files.map(f => fs.promises.stat(f)))
  const total = before.reduce((n, s) => n + s.size, 0)
  if (directory) await freeSpace(directory, total * 2 + files.length * 512)
  let completed = 0
  for (const [i, file] of files.entries()) {
    const hash = crypto.createHash('sha256'), key = portable.toPortable(file)
    if (Object.hasOwn(state.hashes, key)) throw new Error('Duplicate portable save path')
    if (directory) {
      const staged = path.join(directory, `${i}.save`)
      await pipeline(fs.createReadStream(file), new Transform({ transform(chunk, _encoding, done) {
        hash.update(chunk); completed += chunk.length; progress('reading', completed, total); done(null, chunk)
      } }), fs.createWriteStream(staged, { flags: 'wx' }))
      state.paths[key] = staged
    } else {
      for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); completed += chunk.length; progress('reading', completed, total) }
    }
    if (signature(before[i]) !== signature(await fs.promises.stat(file))) throw new SnapshotBusyError(file)
    state.hashes[key] = hash.digest('hex'); state.sizeBytes += before[i].size
  }
  for (const [i, file] of files.entries()) if (signature(before[i]) !== signature(await fs.promises.stat(file))) throw new SnapshotBusyError(file)
  progress('reading', total, total)
  return state
}

export async function zipFiles(state: StagedState, metadata: unknown, output: string, progress: Progress = () => {}): Promise<void> {
  const archive = new yazl.ZipFile()
  const saving = pipeline(archive.outputStream, fs.createWriteStream(output, { flags: 'wx' }))
  archive.on('error', error => (archive.outputStream as Readable).destroy(error))
  const manifest = Buffer.from(JSON.stringify(metadata))
  if (manifest.length > 16 * 1024 * 1024) { archive.outputStream.emit('error', new Error('Save file manifest exceeds the supported metadata size')); await saving; return }
  archive.addBuffer(manifest, META_ENTRY)
  let completed = 0
  for (const [key, file] of Object.entries(state.paths)) {
    archive.addReadStreamLazy(toZipName(key), { compressionLevel: 6 }, done => {
      const stream = fs.createReadStream(file)
      stream.on('data', bytes => { completed += bytes.length; progress('compressing', completed, state.sizeBytes) })
      done(null, stream)
    })
  }
  archive.end()
  await saving
  progress('compressing', state.sizeBytes, state.sizeBytes)
}

export function validateEntryName(name: string): string {
  const parts = name.split('/')
  if (parts.length < 2 || parts.some(p => !p || p === '.' || p === '..' || /[\\:<>"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new Error(`Unsafe path in snapshot: ${name}`)
  return fromZipName(name)
}

export interface StagedRestoreFile { target: string; staged: string }

/** Sequential extraction enforces actual byte limits as well as declared entry sizes. */
export async function inspectArchive(archive: string, snapshot: Pick<SnapshotMeta, 'files' | 'sizeBytes'>, directory: string, portable?: Portable, progress: Progress = () => {}): Promise<StagedRestoreFile[]> {
  await freeSpace(directory, snapshot.sizeBytes)
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value!)))
  const files: StagedRestoreFile[] = [], names = new Set<string>(), keys = new Set<string>(), targets = new Set<string>()
  let total = 0, metaBytes = 0
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', (entry: yauzl.Entry) => { void (async () => {
        if (names.has(entry.fileName)) throw new Error('Duplicate entry in snapshot')
        names.add(entry.fileName)
        if (names.size > Object.keys(snapshot.files).length + 1024) throw new Error('Snapshot contains too many entries')
        if (entry.fileName.endsWith('/')) { validateEntryName(entry.fileName.slice(0, -1) + '/_'); zip.readEntry(); return }
        const metadata = entry.fileName === META_ENTRY
        const key = metadata ? '' : validateEntryName(entry.fileName)
        if (metadata ? entry.uncompressedSize > 16 * 1024 * 1024 : !Object.hasOwn(snapshot.files, key) || entry.uncompressedSize > snapshot.sizeBytes) throw new Error('Snapshot entry exceeds its declared size or is unexpected')
        if (!metadata && keys.has(key)) throw new Error('Duplicate portable path in snapshot')
        let target = ''
        if (portable && !metadata) {
          target = portable.fromPortable(key) ?? ''
          if (!target || !path.isAbsolute(target)) throw new Error(`Cannot resolve snapshot destination: ${entry.fileName}`)
          const canonical = path.resolve(target).toLowerCase()
          if (targets.has(canonical)) throw new Error('Duplicate snapshot destination')
          targets.add(canonical)
        }
        const input = await new Promise<fs.ReadStream>((res, rej) => zip.openReadStream(entry, (error, stream) => error ? rej(error) : res(stream as fs.ReadStream)))
        const hash = crypto.createHash('sha256'), staged = path.join(directory, `${files.length}.extracted`)
        const check = new Transform({ transform(chunk, _encoding, done) {
          if (metadata) metaBytes += chunk.length; else total += chunk.length
          if (total > snapshot.sizeBytes || metaBytes > 16 * 1024 * 1024) { done(new Error('Snapshot exceeds its declared size')); return }
          hash.update(chunk); progress('verifying', total, snapshot.sizeBytes); done(null, chunk)
        } })
        // Metadata is bounded and discarded; save bytes go straight to disk.
        if (metadata) await pipeline(input,check,new Writable({ write(_chunk,_encoding,done) { done() } }))
        else {
          await pipeline(input, check, fs.createWriteStream(staged, { flags: 'wx' }))
          if (hash.digest('hex') !== snapshot.files[key]) throw new Error(`Snapshot integrity check failed: ${entry.fileName}`)
          keys.add(key); files.push({ target, staged })
        }
        zip.readEntry()
      })().catch(reject) })
      zip.readEntry()
    })
    if (!files.length || keys.size !== Object.keys(snapshot.files).length || total !== snapshot.sizeBytes) throw new Error('Snapshot is incomplete or has an incorrect size')
    progress('verifying', total, total)
    return files
  } finally { zip.close() }
}
