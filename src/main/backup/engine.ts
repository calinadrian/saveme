import crypto from 'node:crypto'
import { AppState, Catalog, Game, GameIndex, SnapshotMeta } from '../../shared/types'
import { isTransient, readJson, StorageProvider, writeJson } from '../cloud/provider'
import { KnownFolders, Portable } from '../detect/paths'
import { Db } from '../store/db'
import { snapshotsToPrune } from './retention'
import { buildZip, collectFiles, localState, prepareRestore, sameHashes, SnapshotBusyError } from './snapshot'
import { applyRestore, RecoveryRequiredError } from './restore'
import { measureBackupUsage, USAGE_TIMEOUT_MS } from './usage'

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
  index?.snapshots.reduce<SnapshotMeta | undefined>((a, s) => (!a || s.createdAt >= a.createdAt ? s : a), undefined)

export class BackupEngine {
  saveMeBytes = 0
  backupUsage: NonNullable<AppState['backupUsage']> = { status: 'unavailable' }
  private usageTask?: Promise<void>
  private usageController?: AbortController
  private usageGeneration = 0
  active?: string
  operation?: AppState['operation']
  recoveryRequired?: string
  private tail: Promise<unknown> = Promise.resolve()
  private processing = false
  private retryTimer?: NodeJS.Timeout
  private retries = 0
  private stopping = false

  constructor(private deps: EngineDeps) {}

  /** One local coordinator for file writes, metadata updates, and destination changes. */
  exclusive<T>(operation: NonNullable<AppState['operation']>, work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.recoveryRequired) throw new Error(this.recoveryRequired)
      this.operation = operation
      this.active = operation.kind === 'backup' ? operation.gameId : undefined
      this.deps.changed()
      try { return await work() }
      finally { this.operation = undefined; this.active = undefined; this.deps.changed() }
    })
    this.tail = result.catch(() => {})
    return result
  }

  async drain(): Promise<void> { await this.tail }

  stop(): void { this.stopping = true; clearTimeout(this.retryTimer); this.invalidateBackupUsage() }

  invalidateBackupUsage(): void {
    this.usageGeneration++
    this.usageController?.abort(new Error('Backup storage changed'))
    this.usageController = undefined
    this.usageTask = undefined
    this.backupUsage = { status: 'unavailable' }
    this.deps.changed()
  }

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
    if (this.stopping || !game?.tracked) return
    if (!this.db.data.queue.some((q) => q.gameId === gameId)) {
      this.db.data.queue.push({ gameId, trigger })
      if (game.status !== 'cloud-newer') this.update(game, { status: 'pending' })
      this.db.save()
    }
    void this.kick()
  }

  /** Works through the queue one game at a time. Transient failures keep the job and retry later. */
  async kick(): Promise<void> {
    if (this.stopping || this.processing || !this.connected()) return
    this.processing = true
    clearTimeout(this.retryTimer)
    try {
      while (!this.stopping && this.db.data.queue.length) {
        const job = this.db.data.queue[0]
        const game = this.db.data.games[job.gameId]
        if (game?.tracked) {
          try {
            await this.backup(game, job.trigger as Trigger)
            this.retries = 0
          } catch (e) {
            if (!this.connected()) {
              this.update(game, { status: 'pending', error: 'Connect storage to resume this backup' })
              return
            }
            if (isTransient(e)) {
              const delay = RETRY_DELAYS[Math.min(this.retries++, RETRY_DELAYS.length - 1)]
              this.update(game, { status: 'pending', error: e instanceof SnapshotBusyError ? e.message : 'Storage unavailable, will retry' })
              if (this.stopping) return
              this.retryTimer = setTimeout(() => void this.kick(), delay)
              this.retryTimer.unref()
              return
            }
            this.update(game, { status: 'error', error: (e as Error).message })
            this.db.log({ kind: 'error', gameId: game.id, message: `${game.name}: ${(e as Error).message}` })
            this.deps.notify(`${game.name}: backup failed`, (e as Error).message, game.id)
          }
        }
        this.db.data.queue.shift()
        this.db.save()
      }
      if (!this.stopping) {
        await this.exclusive({ kind: 'checking' }, () => this.maintainHistory())
        void this.refreshBackupUsage()
      }
    } catch (e) {
      this.db.log({ kind: 'error', message: `Background backup work stopped: ${(e as Error).message}` })
    } finally {
      this.processing = false
      this.deps.changed()
    }
  }

  async index(gameId: string): Promise<GameIndex | undefined> {
    if (!/^[\w-]+$/.test(gameId)) throw new Error('Invalid game ID')
    const p = this.connected()
    const index = p ? await readJson<GameIndex>(p, `${gameId}/index.json`) : undefined
    if (index && (index.gameId !== gameId || !Array.isArray(index.snapshots) || index.snapshots.some(s =>
      !s || !/^[\w-]+$/.test(s.id) || !s.files || typeof s.files !== 'object' || Array.isArray(s.files) ||
      !Number.isSafeInteger(s.sizeBytes) || s.sizeBytes < 0 || !Number.isFinite(Date.parse(s.createdAt))
    ))) throw new Error('Backup history is invalid; no saves were changed')
    return index
  }

  /** Takes a snapshot and uploads it if anything changed. Returns the new snapshot, if one was made. */
  async backup(game: Game, trigger: Trigger): Promise<SnapshotMeta | undefined> {
    return this.exclusive({ kind: 'backup', gameId: game.id }, async () => {
      if (!game.tracked) return undefined
      if (this.deps.isRunning(game.id)) throw new SnapshotBusyError(`${game.name} is running`)
      try { return await this.backupInternal(game, trigger) }
      catch (e) { this.update(game, { status: isTransient(e) ? 'pending' : 'error', error: (e as Error).message }); throw e }
    })
  }

  private async backupInternal(game: Game, trigger: Trigger, protectedId?: string): Promise<SnapshotMeta | undefined> {
    const provider = this.connected()
    if (!provider) throw new Error('No cloud storage connected')
    this.update(game, { status: 'backing-up' })

    const portable = new Portable(this.deps.folders, game.installDir)
    const files = collectFiles(game, this.deps.folders)
    const state = await localState(files, portable)
    const after = collectFiles(game, this.deps.folders)
    if (files.length !== after.length || files.some((f, i) => f !== after[i])) throw new SnapshotBusyError(game.name)
    const fileCount = Object.keys(state.hashes).length
    if (!fileCount) {
      if (game.lastHashes && Object.keys(game.lastHashes).length) throw new Error('Previously backed-up save files are missing. Check the save folder before retrying.')
      this.update(game, { status: game.newerSnapshot ? 'cloud-newer' : 'never', fileCount: 0, sizeBytes: 0 })
      return undefined
    }
    if (sameHashes(state.hashes, game.lastHashes)) {
      await this.maintainHistory()
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
      id: `${createdAt.replace(/[:.]/g, '-')}_${this.machine.name.replace(/[^A-Za-z0-9-]/g, '')}_${crypto.randomUUID()}`,
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
    if (this.deps.isRunning(game.id)) throw new SnapshotBusyError(`${game.name} is running`)
    meta.zipBytes = zip.length
    await provider.put(`${game.id}/${meta.id}.zip`, zip)
    this.invalidateBackupUsage()

    index.name = game.name
    index.snapshots.push(meta)
    const pruned = snapshotsToPrune(index.snapshots, this.db.data.settings.retention).filter(s => s.id !== protectedId && s.id !== meta.id)
    index.snapshots = index.snapshots.filter((s) => !pruned.includes(s))
    await writeJson(provider, `${game.id}/index.json`, index)
    this.db.data.maintenance[game.id] = [...new Set([...(this.db.data.maintenance[game.id] ?? []), ...pruned.map(s => s.id)])]
    this.db.flush()
    await this.maintainHistory()

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

  /** Count stored archives, including files awaiting cleanup, rather than guessing from the policy. */
  refreshBackupUsage(): Promise<void> {
    if (this.usageTask) return this.usageTask
    const provider = this.connected()
    if (!provider || this.stopping) { this.backupUsage = { status: 'unavailable' }; this.deps.changed(); return Promise.resolve() }
    const generation = ++this.usageGeneration
    const controller = new AbortController()
    this.usageController = controller
    this.backupUsage = { status: 'loading' }
    this.deps.changed()
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abort, { once: true })
    })
    const timer = setTimeout(() => controller.abort(new Error('Storage check timed out')), USAGE_TIMEOUT_MS)
    const current = (): boolean => generation === this.usageGeneration && this.connected() === provider
    const task = (async () => {
      try {
        const bytes = await Promise.race([measureBackupUsage(provider, controller.signal, (completed, total) => {
          if (!current() || controller.signal.aborted) return
          this.backupUsage = { status: 'loading', completed, total }
          this.deps.changed()
        }), cancelled])
        if (current()) this.backupUsage = { status: 'ready', bytes }
      } catch {
        controller.abort()
        if (current()) this.backupUsage = { status: 'unavailable' }
      } finally {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        if (generation === this.usageGeneration) {
          this.usageTask = undefined
          this.usageController = undefined
          this.deps.changed()
        }
      }
    })()
    this.usageTask = task
    return task
  }

  /** Persisted, best-effort maintenance: metadata failure must never cause archive deletion. */
  private async maintainHistory(): Promise<void> {
    const provider = this.connected()
    if (!provider) return
    for (const [gameId, pending] of Object.entries(this.db.data.maintenance)) {
      try {
        const index = await this.index(gameId)
        if (!index) throw new Error('Committed history is unavailable')
        await this.updateCatalog(provider, index)
        for (const id of pending) if (!index.snapshots.some(s => s.id === id)) await provider.remove(`${gameId}/${id}.zip`)
        delete this.db.data.maintenance[gameId]
        this.db.save()
      } catch (e) {
        this.db.log({ kind: 'error', gameId, message: `Backup history maintenance will retry: ${(e as Error).message}` })
      }
    }
  }

  async restore(gameId: string, snapshotId: string): Promise<void> {
    await this.exclusive({ kind: 'restore', gameId }, async () => {
      try { await this.restoreInternal(gameId, snapshotId) }
      catch (e) {
        if (e instanceof RecoveryRequiredError) { this.recoveryRequired = e.message; this.stop() }
        const game = this.db.data.games[gameId]
        if (game) this.update(game, { status: 'error', error: `Restore failed: ${(e as Error).message}` })
        this.db.log({ kind: 'error', gameId, message: `Restore failed: ${(e as Error).message}` })
        throw e
      }
    })
    if (!this.db.data.games[gameId]?.roots.length) await this.deps.rescan?.()
  }

  private async restoreInternal(gameId: string, snapshotId: string): Promise<void> {
    const provider = this.connected()
    const game = this.db.data.games[gameId]
    if (!provider || !game) throw new Error('Not connected')
    if (this.deps.isRunning(gameId)) throw new Error(`Close ${game.name} before restoring`)
    const index = await this.index(gameId)
    const snap = index?.snapshots.find((s) => s.id === snapshotId)
    if (!snap) throw new Error('Snapshot not found')

    const zip = await provider.get(`${gameId}/${snapshotId}.zip`)
    if (!zip) throw new Error('Snapshot file missing in the cloud')
    const files = prepareRestore(zip, new Portable(this.deps.folders, game.installDir), snap)
    if (game.roots.length) await this.backupInternal(game, 'pre-restore', snapshotId)
    const written = await applyRestore(files, this.db.recoveryDirectory, () => {
      if (this.deps.isRunning(gameId)) throw new Error(`Close ${game.name} before restoring`)
    })
    this.update(game, { status: 'synced', lastSnapshotId: snap.id, lastHashes: snap.files, lastBackupAt: snap.createdAt, newerSnapshot: undefined, error: undefined })
    this.db.log({ kind: 'restore', gameId, message: `${game.name} restored to ${new Date(snap.createdAt).toLocaleString()} from ${snap.machine} (${written.length} files)` })
  }

  /** Marks the cloud's newer save as seen and keeps the local one (it will be uploaded next). */
  async keepLocal(gameId: string): Promise<void> {
    await this.exclusive({ kind: 'backup', gameId }, async () => {
      const game = this.db.data.games[gameId]
      if (!game) return
      this.update(game, { status: 'pending', newerSnapshot: undefined, lastSnapshotId: game.newerSnapshot?.id ?? game.lastSnapshotId, lastHashes: undefined })
      this.enqueue(gameId, 'manual')
    })
  }

  /** Looks for saves uploaded by other PCs. */
  async checkRemote(): Promise<void> {
    return this.exclusive({ kind: 'checking' }, () => this.checkRemoteInternal())
  }

  private async checkRemoteInternal(): Promise<void> {
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
        this.update(game, { status: 'synced', lastSnapshotId: latest.id, lastHashes: local.hashes, lastBackupAt: latest.createdAt, newerSnapshot: undefined, error: undefined })
        continue
      }
      this.update(game, { status: 'cloud-newer', newerSnapshot: latest })
      this.deps.notify(`Newer ${game.name} save in the cloud`, `From ${latest.machine}, ${new Date(latest.createdAt).toLocaleString()}. Click to restore.`, game.id)
    }
  }
}
