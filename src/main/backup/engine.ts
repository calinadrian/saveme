import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AppState, Game, GameIndex, SnapshotMeta, RestorePreview, VerificationResult } from '../../shared/types'
import { isTransient, StorageProvider } from '../cloud/provider'
import { KnownFolders, Portable } from '../detect/paths'
import { Db } from '../store/db'
import { snapshotsToPrune } from './retention'
import { collectFiles, sameHashes, SnapshotBusyError } from './snapshot'
import { capture, freeSpace, inspectArchive, Progress, zipFiles } from './streaming'
import { applyRestore, RecoveryRequiredError } from './restore'
import { measureBackupUsage, USAGE_TIMEOUT_MS } from './usage'
import { History, SnapshotRecord, validId, HistoryView } from './history'

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
const RETRY_DELAYS = [30_000, 120_000, 600_000, 1_800_000]
export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[unit]
}
const newest = (index?: GameIndex): SnapshotMeta | undefined => index?.snapshots.at(-1)

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
  private controller?: AbortController
  private lastProgress = 0
  constructor(private deps: EngineDeps) {}
  private get db(): Db { return this.deps.db }
  private get machine(): { name: string; id: string } { return { name: this.db.machine, id: this.db.data.machineId } }
  private connected(): StorageProvider | undefined { const p = this.deps.provider(); return p?.isConnected() ? p : undefined }
  private history(): History {
    const provider = this.connected()
    if (!provider) throw new Error('Connect storage to continue')
    return new History(provider, this.machine.id)
  }
  private verificationKey(id: string): string {
    const p = this.connected(), s = this.db.data.settings
    return crypto.createHash('sha256').update(JSON.stringify([p?.kind, p?.account(), s.localFolder, s.remoteFolder, id])).digest('hex')
  }
  private update(game: Game, patch: Partial<Game>): void { Object.assign(game, patch); this.db.save(); this.deps.changed() }
  private progress: Progress = (stage, completed, total, unit = 'bytes') => {
    if (!this.operation) return
    const changed = this.operation.progress?.stage !== stage
    this.operation.progress = { stage, completed, total: total || undefined, unit }
    if (changed || completed === total || Date.now() - this.lastProgress >= 250) { this.lastProgress = Date.now(); this.deps.changed() }
  }
  exclusive<T>(operation: NonNullable<AppState['operation']>, work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.recoveryRequired) throw new Error(this.recoveryRequired)
      this.operation = operation
      this.active = operation.kind === 'backup' ? operation.gameId : undefined
      this.controller = new AbortController(); this.lastProgress = 0; this.deps.changed()
      try { return await work() }
      finally { this.operation = undefined; this.active = undefined; this.controller = undefined; this.deps.changed() }
    })
    this.tail = result.catch(() => {})
    return result
  }
  async drain(): Promise<void> { await this.tail }
  stop(): void {
    this.stopping = true; clearTimeout(this.retryTimer); this.invalidateBackupUsage()
    if (this.operation?.kind !== 'restore' && this.operation?.kind !== 'storage') this.controller?.abort(new Error('SaveMe is closing; the backup will retry next time'))
  }
  invalidateBackupUsage(): void {
    this.usageGeneration++; this.usageController?.abort(new Error('Backup storage changed'))
    this.usageController = undefined; this.usageTask = undefined; this.backupUsage = { status: 'unavailable' }; this.deps.changed()
  }
  get queue(): string[] { return this.db.data.queue.map(q => q.gameId) }
  enqueue(gameId: string, trigger: Trigger): void {
    const game = this.db.data.games[gameId]
    if (this.stopping || !game?.tracked) return
    if (!this.db.data.queue.some(q => q.gameId === gameId)) {
      this.db.data.queue.push({ gameId, trigger })
      if (game.status !== 'cloud-newer') this.update(game, { status: 'pending' })
      this.db.save()
    }
    void this.kick()
  }
  async kick(): Promise<void> {
    if (this.stopping || this.processing || !this.connected()) return
    this.processing = true; clearTimeout(this.retryTimer)
    try {
      while (!this.stopping && this.db.data.queue.length) {
        const job = this.db.data.queue[0], game = this.db.data.games[job.gameId]
        if (game?.tracked) {
          try { await this.backup(game, job.trigger as Trigger); this.retries = 0; this.update(game, { retryAt: undefined }) }
          catch (e) {
            if (this.stopping) return
            if (!this.connected()) { this.update(game, { status: 'pending', error: 'Connect storage to resume this backup' }); return }
            if (isTransient(e)) {
              const delay = RETRY_DELAYS[Math.min(this.retries++, RETRY_DELAYS.length - 1)]
              this.update(game, { status: 'pending', retryAt: Date.now() + delay, error: e instanceof SnapshotBusyError ? e.message : 'Storage unavailable, will retry' })
              this.retryTimer = setTimeout(() => void this.kick(), delay); this.retryTimer.unref(); return
            }
            this.update(game, { status: 'error', error: (e as Error).message })
            this.db.log({ kind: 'error', gameId: game.id, message: game.name + ': ' + (e as Error).message })
            this.deps.notify(game.name + ': backup failed', (e as Error).message, game.id)
          }
        }
        this.db.data.queue.shift(); this.db.save()
      }
      if (!this.stopping) { await this.exclusive({ kind: 'checking' }, () => this.maintainHistory()); void this.refreshBackupUsage() }
    } catch (e) { this.db.log({ kind: 'error', message: 'Background backup work stopped: ' + (e as Error).message }) }
    finally { this.processing = false; this.deps.changed() }
  }
  async index(gameId: string): Promise<GameIndex | undefined> {
    if (!validId(gameId)) throw new Error('Invalid game ID')
    if (!this.connected()) return undefined
    const view = await this.history().load(gameId)
    for (const s of view.index.snapshots) s.verification = this.db.data.verifications?.[this.verificationKey(s.id)]
    return view.records.size ? view.index : undefined
  }
  private async job<T>(work: (directory: string) => Promise<T>): Promise<T> {
    await freeSpace(this.db.stagingDirectory, 0)
    const directory = await fs.mkdtemp(path.join(this.db.stagingDirectory, 'job-'))
    try { return await work(directory) } finally { await fs.rm(directory, { recursive: true, force: true }) }
  }
  private async local(game: Game, directory?: string) {
    const files = collectFiles(game, this.deps.folders)
    const state = await capture(files, new Portable(this.deps.folders, game.installDir), directory, this.progress)
    const after = collectFiles(game, this.deps.folders)
    if (files.length !== after.length || files.some((f,i) => f !== after[i])) throw new SnapshotBusyError(game.name)
    return state
  }
  async backup(game: Game, trigger: Trigger): Promise<SnapshotMeta | undefined> {
    return this.exclusive({ kind: 'backup', gameId: game.id }, async () => {
      if (!game.tracked) return undefined
      if (this.deps.isRunning(game.id)) throw new SnapshotBusyError(game.name + ' is running')
      try { return await this.backupInternal(game, trigger) }
      catch (e) { this.update(game, { status: isTransient(e) ? 'pending' : 'error', error: (e as Error).message }); throw e }
    })
  }
  private async backupInternal(game: Game, trigger: Trigger, protectedId?: string): Promise<SnapshotMeta | undefined> {
    const history = this.history(), provider = history.provider
    this.update(game, { status: 'backing-up', error: undefined })
    return this.job(async directory => {
      const state = await this.local(game, directory), fileCount = Object.keys(state.hashes).length
      const view = await history.load(game.id), latest = newest(view.index)
      if (view.index.incomplete) throw new SnapshotBusyError('Backup storage is still syncing; waiting for complete history')
      if (!fileCount) {
        if (game.lastHashes && Object.keys(game.lastHashes).length) throw new Error('Previously backed-up save files are missing. Check the save folder before retrying.')
        this.update(game, { status: latest ? 'cloud-newer' : 'never', newerSnapshot: latest, fileCount: 0, sizeBytes: 0 }); return undefined
      }
      const matching = view.index.snapshots.find(s => sameHashes(s.files, state.hashes))
      const remote = view.index.snapshots.filter(s => view.index.heads?.includes(s.id) && s.id !== game.lastSnapshotId && s.machineId !== this.machine.id && !game.resolvedHeads?.includes(s.id)).at(-1)
      if (trigger !== 'pre-restore' && ((!game.lastSnapshotId && latest && !matching) || remote && !sameHashes(remote.files, state.hashes))) {
        const candidate = remote ?? latest!
        this.update(game, { status: 'cloud-newer', newerSnapshot: candidate })
        this.deps.notify(game.name + ': review saves from another PC', 'Restore a cloud version or keep this PC’s save. Both branches remain in history.', game.id)
        return undefined
      }
      if (matching && !game.resolvedHeads?.length) {
        this.update(game, { status: 'synced', lastSnapshotId: matching.id, lastHashes: state.hashes, lastBackupAt: matching.createdAt, newerSnapshot: undefined, error: undefined })
        await this.maintainHistory(game.id, protectedId); return undefined
      }
      const createdAt = new Date().toISOString()
      const parents = game.resolvedHeads ?? (game.lastSnapshotId && view.records.has(game.lastSnapshotId) ? [game.lastSnapshotId] : [])
      const meta: SnapshotMeta = { id: crypto.randomUUID(), gameId: game.id, createdAt, machine: this.machine.name, machineId: this.machine.id, trigger, sizeBytes: state.sizeBytes, zipBytes: 0, files: state.hashes, parents }
      const zip = path.join(directory, 'snapshot.zip')
      await zipFiles(state, { ...meta, game: game.name, roots: game.roots.map(r => r.template) }, zip, this.progress)
      if (this.deps.isRunning(game.id)) throw new SnapshotBusyError(game.name + ' is running')
      this.controller?.signal.throwIfAborted()
      meta.zipBytes = (await fs.stat(zip)).size
      const archive = await provider.putFile(game.id + '/' + meta.id + '.zip', zip, { signal: this.controller?.signal, progress: (n,t) => this.progress('uploading', n,t) })
      const record: SnapshotRecord = { format: 2, kind: 'snapshot', id: meta.id, clock: view.clock + 1, machineId: this.machine.id, snapshot: meta, name: game.name, archive, parents }
      await history.commit(game.id, record)
      this.invalidateBackupUsage()
      this.update(game, { status: 'synced', lastSnapshotId: meta.id, lastHashes: state.hashes, lastBackupAt: createdAt, sizeBytes: state.sizeBytes, fileCount, newerSnapshot: undefined, resolvedHeads: undefined, error: undefined })
      await this.maintainHistory(game.id, protectedId)
      this.db.log({ kind: 'backup', gameId: game.id, message: game.name + ' backed up (' + formatBytes(meta.zipBytes) + ', ' + fileCount + ' files)' })
      if (trigger === 'game-exit' || trigger === 'file-change') this.deps.notify(game.name + ' saved to ' + provider.label, formatBytes(meta.zipBytes) + ' · ' + fileCount + ' files', game.id)
      return meta
    })
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


  private async maintainHistory(onlyGame?: string, protectedId?: string): Promise<void> {
    if (!this.connected()) return
    const history = this.history()
    const ids = onlyGame ? [onlyGame] : [...new Set([...Object.keys(this.db.data.games), ...Object.keys(this.db.data.maintenance)])]
    let bytes = 0
    for (const gameId of ids) {
      try {
        let view = await history.load(gameId)
        bytes += view.index.snapshots.reduce((n,s) => n + s.zipBytes, 0)
        if (view.index.incomplete) continue
        const protectedIds = new Set([...(view.index.heads ?? []), protectedId])
        for (const s of view.index.snapshots) if (s.pinned) protectedIds.add(s.id)
        const prune = snapshotsToPrune(view.index.snapshots, this.db.data.settings.retention).filter(s => !protectedIds.has(s.id))
        for (const s of prune) { await history.event(view, s.id, 'prune'); view.clock++ }
        view = await history.load(gameId)
        this.db.data.maintenance[gameId] = [...view.pruned]
        this.db.flush()
        for (const id of view.pruned) {
          const record = view.records.get(id)
          if (record && view.available.has(record.archive) && id !== protectedId && !view.pins.get(id)?.length) await history.provider.remove(record.archive)
        }
        const removed = new Set(view.events.filter(e => e.kind === 'unpin').flatMap(e => e.observed ?? []))
        for (const e of view.events) if (e.kind === 'pin' && removed.has(e.id) && e.archive && view.available.has(e.archive)) await history.provider.remove(e.archive)
        delete this.db.data.maintenance[gameId]; this.db.save()
      } catch (e) { this.db.log({ kind: 'error', gameId, message: 'Backup history maintenance will retry: ' + (e as Error).message }) }
    }
    if (!onlyGame) this.saveMeBytes = bytes
    else this.saveMeBytes = Math.max(this.saveMeBytes, bytes)
  }
  private async download(history: History, view: HistoryView, snapshotId: string, directory: string): Promise<string> {
    const zip = path.join(directory, 'download.zip')
    const snap = view.index.snapshots.find(s => s.id === snapshotId)
    if (!snap) throw new Error('Snapshot not found')
    await freeSpace(directory, snap.zipBytes + snap.sizeBytes)
    const found = await history.provider.getFile(history.archive(view, snapshotId), zip, { signal: this.controller?.signal, progress: (n,t) => this.progress('downloading', n,t || snap.zipBytes) })
    if (!found) throw new Error('Snapshot file missing in storage; it may still be syncing')
    return zip
  }
  private async comparison(game: Game, snapshot: SnapshotMeta): Promise<RestorePreview> {
    const state = await this.local(game), hashes = state.hashes
    const portable = new Portable(this.deps.folders, game.installDir)
    for (const key of Object.keys(snapshot.files)) {
      const target = portable.fromPortable(key)
      if (!target) throw new Error('Cannot resolve snapshot destination: ' + key)
      if (!Object.hasOwn(hashes, key)) {
        try { const local = await capture([target], portable); Object.assign(hashes, local.hashes) }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      }
    }
    const preview: RestorePreview = { token: crypto.createHash('sha256').update(JSON.stringify(Object.entries(hashes).sort())).digest('hex'), added: [], replaced: [], unchanged: [], extra: [] }
    for (const [key,hash] of Object.entries(snapshot.files)) (hashes[key] === undefined ? preview.added : hashes[key] === hash ? preview.unchanged : preview.replaced).push(key)
    for (const key of Object.keys(hashes)) if (!Object.hasOwn(snapshot.files,key)) preview.extra.push(key)
    return preview
  }
  async previewRestore(gameId: string, snapshotId: string): Promise<RestorePreview> {
    return this.exclusive({ kind: 'preview', gameId }, async () => {
      const game = this.db.data.games[gameId], view = await this.history().load(gameId), snap = view.index.snapshots.find(s => s.id === snapshotId)
      if (!game || !snap) throw new Error('Snapshot not found')
      if (this.deps.isRunning(gameId)) throw new Error('Close the game before comparing saves')
      return this.comparison(game, snap)
    })
  }
  async restore(gameId: string, snapshotId: string, previewToken?: string): Promise<void> {
    await this.exclusive({ kind: 'restore', gameId }, async () => {
      try {
        const history = this.history(), game = this.db.data.games[gameId], view = await history.load(gameId)
        const snap = view.index.snapshots.find(s => s.id === snapshotId)
        if (!game || !snap) throw new Error('Snapshot not found')
        if (this.deps.isRunning(gameId)) throw new Error('Close ' + game.name + ' before restoring')
        if (previewToken && (await this.comparison(game,snap)).token !== previewToken) throw new Error('Local files changed. Review the restore comparison again.')
        await this.job(async directory => {
          const zip = await this.download(history,view,snapshotId,directory)
          const files = await inspectArchive(zip,snap,path.join(directory,'extracted'),new Portable(this.deps.folders,game.installDir),this.progress)
          if (game.roots.length) await this.backupInternal(game,'pre-restore',snapshotId)
          if (previewToken && (await this.comparison(game,snap)).token !== previewToken) throw new Error('Local files changed. Review the restore comparison again.')
          await applyRestore(files,this.db.recoveryDirectory,() => {
            if (this.deps.isRunning(gameId)) throw new Error('Close ' + game.name + ' before restoring')
          },(n,t) => this.progress('restoring',n,t,'files'))
        })
        const heads = (await history.load(gameId)).index.heads
        this.update(game,{ status: 'synced', lastSnapshotId: snap.id, lastHashes: snap.files, lastBackupAt: snap.createdAt, newerSnapshot: undefined, resolvedHeads: heads, error: undefined })
        this.db.log({ kind: 'restore', gameId, message: game.name + ' restored from ' + snap.machine })
      } catch (e) {
        if (e instanceof RecoveryRequiredError) { this.recoveryRequired = e.message; this.stop() }
        const game = this.db.data.games[gameId]
        if (game) this.update(game,{ status: 'error',error: 'Restore failed: ' + (e as Error).message })
        this.db.log({ kind: 'error',gameId,message: 'Restore failed: ' + (e as Error).message }); throw e
      }
    })
    if (!this.db.data.games[gameId]?.roots.length) await this.deps.rescan?.()
  }
  async verifySnapshot(gameId: string, snapshotId: string): Promise<VerificationResult> {
    return this.exclusive({ kind: 'verify', gameId }, async () => {
      const result: VerificationResult = { status: 'unavailable', checkedAt: new Date().toISOString() }
      try {
        const history = this.history(), view = await history.load(gameId), snap = view.index.snapshots.find(s => s.id === snapshotId)
        if (!snap) throw new Error('Snapshot not found')
        await this.job(async directory => {
          const zip = await this.download(history,view,snapshotId,directory)
          try { await inspectArchive(zip,snap,path.join(directory,'verified'),undefined,this.progress) }
          catch (e) { if (['ENOSPC','EACCES','EPERM','ENOENT','EIO'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; result.status = 'corrupt'; throw e }
        })
        result.status = 'verified'; result.bytes = snap.sizeBytes; result.fileCount = Object.keys(snap.files).length
      } catch { /* Typed results separate unavailable storage from invalid archives. */ }
      this.db.data.verifications ??= {}; this.db.data.verifications[this.verificationKey(snapshotId)] = result
      this.db.flush(); this.deps.changed(); return result
    })
  }
  async renameSnapshot(gameId: string, snapshotId: string, label: string): Promise<void> {
    if (typeof label !== 'string' || label.length > 100 || /[\x00-\x1f]/.test(label)) throw new Error('Use a name of up to 100 characters')
    await this.exclusive({ kind: 'history',gameId },async () => {
      const history = this.history(), view = await history.load(gameId)
      if (!view.index.snapshots.some(s => s.id === snapshotId)) throw new Error('Snapshot not found')
      await history.event(view,snapshotId,'rename',{ label: label.trim() })
    })
  }
  async pinSnapshot(gameId: string, snapshotId: string): Promise<void> {
    await this.exclusive({ kind: 'history',gameId },async () => {
      const history = this.history(),view = await history.load(gameId),snap = view.index.snapshots.find(s => s.id === snapshotId)
      if (!snap) throw new Error('Snapshot not found')
      if (view.pins.get(snapshotId)?.length) return
      await this.job(async directory => {
        const zip = await this.download(history,view,snapshotId,directory)
        await inspectArchive(zip,snap,path.join(directory,'verified'),undefined,this.progress)
        const archive = await history.provider.putFile(gameId + '/' + crypto.randomUUID() + '.pin.zip',zip,{ signal: this.controller?.signal,progress: (n,t) => this.progress('uploading',n,t) })
        await history.event(view,snapshotId,'pin',{ archive })
      })
      this.invalidateBackupUsage()
    })
  }
  async unpinSnapshot(gameId: string, snapshotId: string): Promise<void> {
    await this.exclusive({ kind: 'history',gameId },async () => {
      const history = this.history(),view = await history.load(gameId)
      await history.event(view,snapshotId,'unpin',{ observed: (view.pins.get(snapshotId) ?? []).map(p => p.id) })
      await this.maintainHistory(gameId); this.invalidateBackupUsage()
    })
  }
  async keepLocal(gameId: string): Promise<void> {
    await this.exclusive({ kind: 'history',gameId },async () => {
      const game = this.db.data.games[gameId]
      if (!game) throw new Error('Game not found')
      const view = await this.history().load(gameId)
      this.update(game,{ status: 'pending',newerSnapshot: undefined,resolvedHeads: view.index.heads,lastHashes: undefined })
      this.enqueue(gameId,'manual')
    })
  }
  async checkRemote(): Promise<void> {
    return this.exclusive({ kind: 'checking' },async () => {
      if (!this.connected()) return
      const history = this.history(), roots = await history.provider.list('')
      const ids = [...new Set(roots.filter(e => /^[\w-]+$/.test(e.name)).map(e => e.name))]
      let bytes = 0
      for (const id of ids) {
        const view = await history.load(id)
        bytes += view.index.snapshots.reduce((n,s) => n + s.zipBytes,0)
        let game = this.db.data.games[id]
        const candidates = view.index.snapshots.filter(s => view.index.heads?.includes(s.id) && s.id !== game?.lastSnapshotId && !game?.resolvedHeads?.includes(s.id))
        const latest = candidates.at(-1) ?? newest(view.index)
        if (!latest || game?.resolvedHeads?.includes(latest.id) || game?.lastSnapshotId === latest.id) continue
        if (!game) {
          game = { id,name: view.index.name,roots: [],tracked: true,status: 'cloud-newer',sizeBytes: 0,fileCount: 0,newerSnapshot: latest }
          this.db.data.games[id] = game; this.update(game,{}); continue
        }
        if (game.newerSnapshot?.id === latest.id || this.deps.isRunning(id)) continue
        const local = await this.local(game)
        if (sameHashes(local.hashes,latest.files)) {
          this.update(game,{ status: 'synced',lastSnapshotId: latest.id,lastHashes: local.hashes,lastBackupAt: latest.createdAt,newerSnapshot: undefined,error: undefined }); continue
        }
        this.update(game,{ status: 'cloud-newer',newerSnapshot: latest })
        this.deps.notify('Review ' + game.name + ' saves from another PC','Restore a cloud version or keep this PC’s save.',id)
      }
      this.saveMeBytes = bytes
      await this.maintainHistory()
    })
  }
}
