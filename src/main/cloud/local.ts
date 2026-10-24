import fs from 'node:fs'
import path from 'node:path'
import { Quota } from '../../shared/types'
import { RemoteEntry, StorageProvider } from './provider'

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
    const full = path.join(this.root, p)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    const tmp = full + '.part'
    await fs.promises.writeFile(tmp, data)
    await fs.promises.rename(tmp, full)
  }

  async get(p: string): Promise<Buffer | undefined> {
    try {
      return await fs.promises.readFile(path.join(this.root, p))
    } catch {
      return undefined
    }
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    try {
      const entries = await fs.promises.readdir(path.join(this.root, dir), { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, size: e.isFile() ? fs.statSync(path.join(this.root, dir, e.name)).size : 0 }))
    } catch {
      return []
    }
  }

  async remove(p: string): Promise<void> {
    await fs.promises.rm(path.join(this.root, p), { force: true })
  }

  async quota(): Promise<Quota> {
    const s = await fs.promises.statfs(this.folder!)
    return { totalBytes: s.blocks * s.bsize, usedBytes: (s.blocks - s.bavail) * s.bsize, account: this.folder }
  }
}
