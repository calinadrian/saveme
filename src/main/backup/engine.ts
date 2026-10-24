import { Catalog, Game, GameIndex, SnapshotMeta } from '../../shared/types'
import { isTransient, readJson, StorageProvider, writeJson } from '../cloud/provider'
import { KnownFolders, Portable } from '../detect/paths'
import { Db } from '../store/db'
import { snapshotsToPrune } from './retention'
import { buildZip, collectFiles, extractZip, localState, sameHashes } from './snapshot'

type Trigger = SnapshotMeta['trigger']

export interface EngineDeps {
  db: Db
  folders: KnownFolders
  provider: () => StorageProvider | undefined
  isRunning: (gameId: string) => boolean
  notify: (title: string, body: string, gameId?: string) => void
  changed: () => void
  rescan?: () => Promise<void>
}

const CATALOG = 'catalog.json'
const RETRY_DELAYS = [30_000, 120_000, 600_000, 1_800_000]

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

const newest = (index?: GameIndex): SnapshotMeta | undefined =>
  index?.snapshots.reduce<SnapshotMeta | undefined>((a, s) => (!a || s.createdAt > a.createdAt ? s : a), undefined)

export class BackupEngine {
  saveMeBytes = 0
  active?: string
  private processing = false
  private retryTimer?: NodeJS.Timeout
  private retries = 0

  constructor(private deps: EngineDeps) {}

  private get db(): Db {
    return this.deps.db
  }

  private get machine(): { name: string; id: string } {
    return { name: this.db.machine, id: this.db.data.machineId }
  }

  private connected(): StorageProvider | undefined {
    const p = this.deps.provider()
    return p?.isConnected() ? p : undefined
  }

  private update(game: Game, patch: Partial<Game>): void {
    Object.assign(game, patch)
    this.db.save()
    this.deps.changed()
  }

  get queue(): string[] {
    return this.db.data.queue.map((q) => q.gameId)
  }

  enqueue(gameId: string, trigger: Trigger): void {
    const game = this.db.data.games[gameId]
    if (!game?.tracked) return
    if (!this.db.data.queue.some((q) => q.gameId === gameId)) {
      this.db.data.queue.push({ gameId, trigger })
      if (game.status !== 'cloud-newer') this.update(game, { status: 'pending' })
      this.db.save()
    }
    void this.kick()
  }

  /** Works through the queue one game at a time. Transient failures keep the job and retry later. */
  async kick(): Promise<void> {
    if (this.processing || !this.connected()) return
    this.processing = true
    clearTimeout(this.retryTimer)
    try {
      while (this.db.data.queue.length) {
        const job = this.db.data.queue[0]
        const game = this.db.data.games[job.gameId]
        if (game) {
          try {
            await this.backup(game, job.trigger as Trigger)
            this.retries = 0
          } catch (e) {
            if (isTransient(e)) {
              const delay = RETRY_DELAYS[Math.min(this.retries++, RETRY_DELAYS.length - 1)]
              this.update(game, { status: 'pending', error: 'Offline, will retry' })
              this.retryTimer = setTimeout(() => void this.kick(), delay)
              return
            }
            this.update(game, { status: 'error', error: (e as Error).message })
            this.db.log({ kind: 'error', gameId: game.id, message: `${game.name}: ${(e as Error).message}` })
          }
        }
        this.db.data.queue.shift()
        this.db.save()
      }
    } finally {
      this.processing = false
      this.active = undefined
      this.deps.changed()
    }
  }

  async index(gameId: string): Promise<GameIndex | undefined> {
    const p = this.connected()
    return p ? readJson<GameIndex>(p, `${gameId}/index.json`) : undefined
  }

  /** Takes a snapshot and uploads it if anything changed. Returns the new snapshot, if one was made. */
  async backup(game: Game, trigger: Trigger): Promise<SnapshotMeta | undefined> {
    const provider = this.connected()
    if (!provider) throw new Error('No cloud storage connected')
    this.active = game.id
    this.update(game, { status: 'backing-up' })

    const portable = new Portable(this.deps.folders, game.installDir)
    const files = collectFiles(game, this.deps.folders)
    const state = await localState(files, portable)
    const fileCount = Object.keys(state.hashes).length
    if (!fileCount) {
      this.update(game, { status: game.lastSnapshotId ? 'synced' : 'never', fileCount: 0, sizeBytes: 0 })
      return undefined
    }
    if (sameHashes(state.hashes, game.lastHashes)) {
      this.update(game, { status: game.newerSnapshot ? 'cloud-newer' : 'synced', error: undefined })
      return undefined
    }

    const index: GameIndex = (await this.index(game.id)) ?? { gameId: game.id, name: game.name, snapshots: [] }
    const latest = newest(index)
    if (latest && sameHashes(latest.files, state.hashes)) {
      // Already in the cloud (e.g. restored, or identical on another PC).
      this.update(game, { status: 'synced', lastSnapshotId: latest.id, lastHashes: state.hashes, lastBackupAt: latest.createdAt, newerSnapshot: undefined, error: undefined })
      return undefined
    }
    if (!game.lastSnapshotId && latest && trigger !== 'pre-restore') {
      // First time on this PC and the cloud already has saves: never let a fresh local save look newer.
      this.update(game, { status: 'cloud-newer', newerSnapshot: latest })
      this.deps.notify(`${game.name}: saves found in the cloud`, `From ${latest.machine}, ${new Date(latest.createdAt).toLocaleString()}. Open SaveMe to restore or keep this PC's save.`, game.id)
      return undefined
    }
    if (latest && latest.id !== game.lastSnapshotId && latest.machineId !== this.machine.id) {
      this.db.log({ kind: 'info', gameId: game.id, message: `${game.name}: also played on ${latest.machine}. Both versions are kept in history.` })
    }

    const createdAt = new Date().toISOString()
    const meta: SnapshotMeta = {
      id: `${createdAt.replace(/[:.]/g, '-')}_${this.machine.name.replace(/[^A-Za-z0-9-]/g, '')}`,
      gameId: game.id,
      createdAt,
      machine: this.machine.name,
      machineId: this.machine.id,
      trigger,
      sizeBytes: state.sizeBytes,
      zipBytes: 0,
      files: state.hashes
    }
    const zip = await buildZip(state, { ...meta, game: game.name, roots: game.roots.map((r) => r.template) })
    meta.zipBytes = zip.length
    await provider.put(`${game.id}/${meta.id}.zip`, zip)

    index.name = game.name
    index.snapshots.push(meta)
    const pruned = snapshotsToPrune(index.snapshots, this.db.data.settings.retention)
    for (const s of pruned) await provider.remove(`${game.id}/${s.id}.zip`)
    index.snapshots = index.snapshots.filter((s) => !pruned.includes(s))
    await writeJson(provider, `${game.id}/index.json`, index)
    await this.updateCatalog(provider, index)

    this.update(game, {
      status: 'synced',
      lastSnapshotId: meta.id,
      lastHashes: state.hashes,
      lastBackupAt: createdAt,
      sizeBytes: state.sizeBytes,
      fileCount,
      newerSnapshot: undefined,
      error: undefined
    })
    this.db.log({ kind: 'backup', gameId: game.id, message: `${game.name} backed up (${formatBytes(zip.length)}, ${fileCount} files)` })
    if (trigger === 'game-exit' || trigger === 'file-change') {
      this.deps.notify(`${game.name} saved to ${provider.label}`, `${formatBytes(zip.length)} · ${fileCount} files`, game.id)
    }
    return meta
  }

  private async updateCatalog(provider: StorageProvider, index: GameIndex): Promise<void> {
    const catalog: Catalog = (await readJson<Catalog>(provider, CATALOG)) ?? { updatedAt: '', games: [] }
    const latest = newest(index)
    const entry = {
      id: index.gameId,
      name: index.name,
      snapshots: index.snapshots.length,
      bytes: index.snapshots.reduce((n, s) => n + s.zipBytes, 0),
      lastBackupAt: latest?.createdAt,
      lastSnapshotId: latest?.id,
      lastMachine: latest?.machineId
    }
    catalog.games = [...catalog.games.filter((g) => g.id !== index.gameId), entry]
    catalog.updatedAt = new Date().toISOString()
    await writeJson(provider, CATALOG, catalog)
    this.saveMeBytes = catalog.games.reduce((n, g) => n + g.bytes, 0)
  }

  async restore(gameId: string, snapshotId: string): Promise<void> {
    const provider = this.connected()
    const game = this.db.data.games[gameId]
    if (!provider || !game) throw new Error('Not connected')
    if (this.deps.isRunning(gameId)) throw new Error(`Close ${game.name} before restoring`)
    const index = await this.index(gameId)
    const snap = index?.snapshots.find((s) => s.id === snapshotId)
    if (!snap) throw new Error('Snapshot not found')

    // Safety net: whatever is on disk now goes to the cloud first (skipped if it is already there).
    if (game.roots.length) await this.backup(game, 'pre-restore')

    const zip = await provider.get(`${gameId}/${snapshotId}.zip`)
    if (!zip) throw new Error('Snapshot file missing in the cloud')
    const written = await extractZip(zip, new Portable(this.deps.folders, game.installDir))
    this.update(game, { status: 'synced', lastSnapshotId: snap.id, lastHashes: snap.files, lastBackupAt: snap.createdAt, newerSnapshot: undefined, error: undefined })
    this.db.log({ kind: 'restore', gameId, message: `${game.name} restored to ${new Date(snap.createdAt).toLocaleString()} from ${snap.machine} (${written.length} files)` })
    if (!game.roots.length) await this.deps.rescan?.()
  }

  /** Marks the cloud's newer save as seen and keeps the local one (it will be uploaded next). */
  keepLocal(gameId: string): void {
    const game = this.db.data.games[gameId]
    if (!game) return
    this.update(game, { status: 'pending', newerSnapshot: undefined, lastSnapshotId: game.newerSnapshot?.id ?? game.lastSnapshotId, lastHashes: undefined })
    this.enqueue(gameId, 'manual')
  }

  /** Looks for saves uploaded by other PCs. */
  async checkRemote(): Promise<void> {
    const provider = this.connected()
    if (!provider) return
    const catalog = await readJson<Catalog>(provider, CATALOG)
    if (!catalog) return
    this.saveMeBytes = catalog.games.reduce((n, g) => n + g.bytes, 0)
    for (const entry of catalog.games) {
      let game = this.db.data.games[entry.id]
      if (game && entry.lastSnapshotId === game.lastSnapshotId) continue
      if (entry.lastMachine === this.machine.id) continue
      const latest = newest(await this.index(entry.id))
      if (!latest) continue
      if (!game) {
        // Backed up on another PC, nothing found here yet: offer it for restore.
        game = { id: entry.id, name: entry.name, roots: [], tracked: true, status: 'cloud-newer', sizeBytes: 0, fileCount: 0, newerSnapshot: latest }
        this.db.data.games[entry.id] = game
        this.update(game, {})
        continue
      }
      if (game.newerSnapshot?.id === latest.id) continue
      const local = await localState(collectFiles(game, this.deps.folders), new Portable(this.deps.folders, game.installDir))
      if (sameHashes(local.hashes, latest.files)) {
        this.update(game, { status: 'synced', lastSnapshotId: latest.id, lastHashes: local.hashes, lastBackupAt: latest.createdAt })
        continue
      }
      this.update(game, { status: 'cloud-newer', newerSnapshot: latest })
      this.deps.notify(`Newer ${game.name} save in the cloud`, `From ${latest.machine}, ${new Date(latest.createdAt).toLocaleString()}. Click to restore.`, game.id)
    }
  }
}
