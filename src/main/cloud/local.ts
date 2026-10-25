import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Quota } from '../../shared/types'
import { RemoteEntry, StorageProvider, TransferOptions } from './provider'
import { copyFile } from './transfers'

/** Any folder (external drive, NAS, synced folder) used as the backup target. Also the test double. */
export class LocalFolderProvider implements StorageProvider {
  readonly kind = 'local' as const
  readonly label = 'Local folder'

  constructor(
    private folder: string | undefined,
    private base = 'SaveMe'
  ) {}

  private get root(): string {
    if (!this.folder) throw new Error('No backup folder chosen')
    return path.join(this.folder, this.base)
  }

  private target(relative: string): string {
    const full = path.resolve(this.root, relative)
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid storage path')
    return full
  }

  isConnected(): boolean {
    return !!this.folder
  }

  account(): string | undefined {
    return this.folder && path.join(this.folder, this.base)
  }

  async connect(): Promise<void> {
    fs.mkdirSync(this.root, { recursive: true })
  }

  async disconnect(): Promise<void> {
    this.folder = undefined
  }

  async put(p: string, data: Buffer): Promise<void> {
    const full = this.target(p)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    const tmp = full + `.${crypto.randomUUID()}.part`
    await fs.promises.writeFile(tmp, data)
    await fs.promises.rename(tmp, full)
  }

  async get(p: string): Promise<Buffer | undefined> {
    try {
      return await fs.promises.readFile(this.target(p))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    }
  }

  async list(dir: string, signal?: AbortSignal): Promise<RemoteEntry[]> {
    signal?.throwIfAborted()
    try {
      const entries = await fs.promises.readdir(path.join(this.root, dir), { withFileTypes: true })
      return await Promise.all(entries.map(async e => {
        signal?.throwIfAborted()
        return { name: e.name, size: e.isFile() ? (await fs.promises.stat(path.join(this.root, dir, e.name))).size : 0, ref: [dir, e.name].filter(Boolean).join('/'), directory: e.isDirectory() }
      }))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
  }

  async remove(p: string): Promise<void> {
    await fs.promises.rm(this.target(p), { force: true })
  }

  async putFile(p: string, file: string, options: TransferOptions = {}): Promise<string> {
    const full = this.target(p), temporary = `${full}.${crypto.randomUUID()}.part`
    await fs.promises.mkdir(path.dirname(full), { recursive: true })
    try {
      await copyFile(file, temporary, options)
      await fs.promises.rename(temporary, full)
      return p
    } finally { await fs.promises.rm(temporary, { force: true }) }
  }

  async getFile(ref: string, file: string, options: TransferOptions = {}): Promise<boolean> {
    try { await copyFile(this.target(ref), file, options); return true }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
  }

  async quota(): Promise<Quota> {
    const s = await fs.promises.statfs(this.folder!)
    return { totalBytes: s.blocks * s.bsize, usedBytes: (s.blocks - s.bavail) * s.bsize, account: this.folder }
  }
}
