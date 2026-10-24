import fs from 'node:fs'
import path from 'node:path'
import { safeStorage, shell } from 'electron'
import { AppState, cleanFolder, Game, locationLabel, ProviderKind, Quota, remoteFolderFor, Settings } from '../shared/types'
import { BackupEngine } from './backup/engine'
import { recoverRestores } from './backup/restore'
import { validateRetention } from '../shared/settings'
import { watchDirs } from './backup/snapshot'
import { LocalFolderProvider } from './cloud/local'
import { GoogleDriveProvider } from './cloud/gdrive'
import { OneDriveProvider } from './cloud/onedrive'
import { StorageProvider, TokenStore } from './cloud/provider'
import { loadOAuthIds, OAuthIds, saveOAuthIds } from './config'
import { findInstalledGames } from './detect/launchers'
import { loadManifest } from './detect/manifest'
import { getKnownFolders, KnownFolders, norm } from './detect/paths'
import { gameId, resolveGame, scanGames } from './detect/scanner'
import { Db } from './store/db'
import { FileWatcher } from './watch/files'
import { ProcessWatcher } from './watch/processes'

const MINUTE = 60_000
/** Games bigger than this are found but not backed up until the user turns them on. */
const AUTO_TRACK_LIMIT = 1024 ** 3

export interface Notifier {
  (title: string, body: string, gameId?: string): void
}

export class SaveMeApp {
  db: Db
  folders!: KnownFolders
  engine!: BackupEngine
  private ids: OAuthIds
  private provider?: StorageProvider
  private quota?: Quota
  private scanning = false
  private scanProgress?: string
  private procs!: ProcessWatcher
  private files!: FileWatcher
  private listeners = new Set<(s: AppState) => void>()
  private emitTimer?: NodeJS.Timeout

  constructor(
    private userData: string,
    private notifyUser: Notifier
  ) {
    this.db = new Db(path.join(userData, 'state.json'))
    this.ids = loadOAuthIds(userData)
  }

  async init(): Promise<void> {
    const recovered = await recoverRestores(this.db.recoveryDirectory)
    if (recovered) this.db.log({ kind: 'error', message: `Recovered ${recovered} interrupted restore(s). Previous local saves were put back before automatic backups resumed.` })
    this.folders = await getKnownFolders()
    this.provider = this.makeProvider(this.db.data.settings.provider)
    this.engine = new BackupEngine({
      db: this.db,
      folders: this.folders,
      provider: () => this.provider,
      isRunning: (id) => this.procs.running.has(id),
      notify: (t, b, id) => this.notify(t, b, id),
      changed: () => this.changed(),
      rescan: () => this.scan()
    })
    this.procs = new ProcessWatcher(
      (id) => this.gameStarted(id),
      (id) => setTimeout(() => this.engine.enqueue(id, 'game-exit'), 10_000)
    )
    this.files = new FileWatcher(this.folders, (id) => this.engine.enqueue(id, 'file-change'), (id) => this.procs.running.has(id))
    this.refreshWatchers()
    this.procs.start()

    // Background schedule: resume queued jobs, look for other PCs' saves, keep quota fresh, rescan weekly.
    const periodic = async (): Promise<void> => {
      await this.safe(() => this.engine.checkRemote())
      await this.safe(() => this.refreshQuota())
      void this.engine.kick()
    }
    void periodic()
    setInterval(() => void periodic(), 15 * MINUTE)
    const lastScan = this.db.data.lastScanAt ? Date.parse(this.db.data.lastScanAt) : 0
    if (Object.keys(this.db.data.games).length && Date.now() - lastScan > 7 * 24 * 60 * MINUTE) void this.scan()
  }

  // ---- state for the UI ----

  onState(fn: (s: AppState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    clearTimeout(this.emitTimer)
    this.emitTimer = setTimeout(() => {
      const s = this.state()
      this.listeners.forEach((fn) => fn(s))
    }, 150)
  }

  state(): AppState {
    const p = this.provider
    return {
      machine: this.db.machine,
      operation: this.engine?.operation,
      recoveryWarning: this.engine?.recoveryRequired ?? this.db.recoveryWarning,
      settings: this.db.data.settings,
      games: Object.values(this.db.data.games).sort((a, b) => a.name.localeCompare(b.name)),
      activity: this.db.data.activity.slice(0, 50),
      provider: {
        kind: p?.kind,
        connected: !!p?.isConnected(),
        account: p?.account(),
        location: p ? this.describeLocation(p.kind) : undefined,
        configured: {
          gdrive: !!(this.ids.googleClientId && this.ids.googleClientSecret),
          onedrive: !!this.ids.microsoftClientId,
          local: true
        }
      },
      quota: this.quota,
      saveMeBytes: this.engine?.saveMeBytes ?? 0,
      backupUsage: this.engine?.backupUsage ?? { status: 'loading' },
      scanning: this.scanning,
      scanProgress: this.scanProgress,
      running: [...(this.procs?.running ?? [])],
      queue: this.engine?.queue ?? []
    }
  }

  private notify(title: string, body: string, gameId?: string): void {
    if (this.db.data.settings.notifications) this.notifyUser(title, body, gameId)
  }

  private async safe(fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (e) {
      console.warn('[saveme]', (e as Error).message)
    }
  }

  // ---- providers ----

  private tokenStore(): TokenStore {
    const tokens = this.db.data.tokens
    return {
      load: (key) => {
        const v = tokens[key]
        if (!v) return undefined
        return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : Buffer.from(v, 'base64').toString()
      },
      save: (key, value) => {
        if (value === undefined) delete tokens[key]
        else tokens[key] = (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value)).toString('base64')
        this.db.save()
      }
    }
  }

  private makeProvider(kind?: ProviderKind): StorageProvider | undefined {
    const open = (url: string): void => void shell.openExternal(url)
    if (!kind) return undefined
    const base = remoteFolderFor(this.db.data.settings, kind)
    switch (kind) {
      case 'gdrive':
        return this.ids.googleClientId && this.ids.googleClientSecret
          ? new GoogleDriveProvider(this.ids.googleClientId, this.ids.googleClientSecret, this.tokenStore(), open, base)
          : undefined
      case 'onedrive':
        return this.ids.microsoftClientId ? new OneDriveProvider(this.ids.microsoftClientId, this.tokenStore(), open, base) : undefined
      case 'local':
        return new LocalFolderProvider(this.db.data.settings.localFolder, base)
      default:
        return undefined
    }
  }

  /** Client IDs entered in the app; then signs in right away. */
  async configureAndConnect(kind: 'gdrive' | 'onedrive', ids: OAuthIds, remoteFolder?: string): Promise<void> {
    if (kind === 'gdrive' && !(ids.googleClientId?.trim() && ids.googleClientSecret?.trim())) throw new Error('Paste both the client ID and the client secret')
    if (kind === 'onedrive' && !ids.microsoftClientId?.trim()) throw new Error('Paste the application (client) ID')
    saveOAuthIds(this.userData, ids)
    this.ids = loadOAuthIds(this.userData)
    this.changed()
    await this.connect(kind, undefined, remoteFolder)
  }

  /** Signs in (or opens the folder) and starts backing up into `remoteFolder` inside that storage. */
  async connect(kind: ProviderKind, localFolder?: string, remoteFolder?: string): Promise<void> {
    await this.engine.exclusive({ kind: 'storage' }, async () => {
      const settings = this.db.data.settings
      const previous = { localFolder: settings.localFolder, remoteFolder: settings.remoteFolder, provider: settings.provider }
      try {
        if (kind === 'local') {
          if (!localFolder) throw new Error('Choose a folder')
          settings.localFolder = norm(localFolder)
        }
        if (remoteFolder !== undefined) this.setRemoteFolderSetting(kind, remoteFolder)
        const p = this.makeProvider(kind)
        if (!p) throw new Error(`${kind === 'gdrive' ? 'Google Drive' : 'OneDrive'} is not configured. See docs/SETUP.md.`)
        await p.connect()
        if (this.provider && this.provider.kind !== kind) await this.provider.disconnect()
        this.provider = p
        settings.provider = kind
      } catch (e) { Object.assign(settings, previous); this.db.flush(); throw e }
      this.db.log({ kind: 'info', message: `Connected to ${this.provider!.label}, saving to ${this.describeLocation(kind)}` })
      this.resetHistory()
    })
    await this.startOver()
  }

  /** Moves future backups to another folder in the same storage. Backups already in the old folder stay there. */
  async setRemoteFolder(remoteFolder: string): Promise<void> {
    await this.engine.exclusive({ kind: 'storage' }, async () => {
      const kind = this.provider?.kind
      if (!kind) throw new Error('Connect a storage first')
      const previous = this.db.data.settings.remoteFolder
      this.setRemoteFolderSetting(kind, remoteFolder)
      const next = this.makeProvider(kind)
      try { await next?.connect() }
      catch (e) { this.db.data.settings.remoteFolder = previous; this.db.flush(); throw e }
      this.provider = next
      this.db.log({ kind: 'info', message: `Backups now go to ${this.describeLocation(kind)}` })
      this.resetHistory()
    })
    await this.startOver()
  }

  private setRemoteFolderSetting(kind: ProviderKind, folder: string): void {
    const clean = cleanFolder(folder)
    if (!clean && kind !== 'onedrive') throw new Error('Enter a folder name')
    this.db.data.settings.remoteFolder = { ...this.db.data.settings.remoteFolder, [kind]: clean }
    this.db.save()
  }

  describeLocation(kind: ProviderKind): string {
    return locationLabel(kind, this.db.data.settings.localFolder, remoteFolderFor(this.db.data.settings, kind))
  }

  /** A different storage or folder has a different history: compare every game afresh and back up. */
  private resetHistory(): void {
    for (const g of Object.values(this.db.data.games)) Object.assign(g, { lastSnapshotId: undefined, lastHashes: undefined, lastBackupAt: undefined, newerSnapshot: undefined, error: undefined, status: 'never' })
    this.db.data.maintenance = {}
    this.engine.saveMeBytes = 0
    this.engine.invalidateBackupUsage()
    this.quota = undefined
    this.db.flush()
  }

  private async startOver(): Promise<void> {
    await this.safe(() => this.refreshQuota())
    await this.safe(() => this.engine.checkRemote())
    this.backupAll('first-backup')
    void this.engine.kick()
    this.changed()
  }

  async disconnect(): Promise<void> {
    await this.engine.exclusive({ kind: 'storage' }, async () => {
      await this.provider?.disconnect()
      this.provider = undefined
      this.engine.invalidateBackupUsage()
      this.quota = undefined
      this.db.data.settings.provider = undefined
      this.db.save()
      this.changed()
    })
  }

  async refreshQuota(): Promise<void> {
    const provider = this.provider
    if (!provider?.isConnected()) return
    const quota = await provider.quota()
    if (provider !== this.provider) return
    this.quota = quota
    if (this.quota.totalBytes && this.quota.usedBytes && this.quota.usedBytes / this.quota.totalBytes > 0.9) {
      this.notify('Cloud storage almost full', `${this.provider.label} is over 90% full. Lower the number of kept versions in Settings.`)
    }
    this.changed()
  }

  // ---- scanning ----

  async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    this.scanProgress = 'Downloading game database…'
    this.changed()
    try {
      const manifest = await loadManifest(this.userData)
      this.scanProgress = 'Looking for installed games…'
      this.changed()
      const launchers = await findInstalledGames(this.db.data.settings.extraLibraryFolders)
      // Let the UI update before the synchronous part of the scan.
      await new Promise((r) => setTimeout(r, 50))
      const results = scanGames(manifest, launchers, this.folders)
      const firstScan = !this.db.data.lastScanAt
      const added: string[] = []
      for (const { game } of results) {
        const existing = this.db.data.games[game.id]
        if (existing) {
          Object.assign(existing, { roots: existing.custom ? existing.roots : game.roots, installDir: game.installDir, store: game.store, steamId: game.steamId, sizeBytes: game.sizeBytes, fileCount: game.fileCount })
        } else {
          this.db.data.games[game.id] = { ...game, tracked: game.sizeBytes < AUTO_TRACK_LIMIT, status: 'never' }
          added.push(game.name)
        }
      }
      this.db.data.lastScanAt = new Date().toISOString()
      this.db.log({ kind: 'info', message: `Scan finished: ${results.length} games with saves${added.length && !firstScan ? `, ${added.length} new` : ''}` })
      if (added.length && !firstScan) this.notify(added.length === 1 ? `New game found: ${added[0]}` : `${added.length} new games found`, 'Their saves will be backed up automatically.')
      this.refreshWatchers()
      this.backupAll('first-backup', true)
    } finally {
      this.scanning = false
      this.scanProgress = undefined
      this.changed()
    }
  }

  /** A game the manifest doesn't know: the user picks its save folder. */
  addCustomGame(name: string, folder: string): void {
    const id = gameId('custom:' + name)
    const template = norm(folder)
    const { roots, files } = resolveGame({ files: [{ path: template }] }, this.folders)
    this.db.data.games[id] = { id, name, store: 'custom', custom: true, roots, tracked: true, status: 'never', sizeBytes: 0, fileCount: files.length }
    this.refreshWatchers()
    this.engine.enqueue(id, 'first-backup')
  }

  private refreshWatchers(): void {
    const games = Object.values(this.db.data.games).filter((g) => g.tracked)
    this.procs?.setGames(games.filter((g): g is Game & { installDir: string } => !!g.installDir).map((g) => ({ id: g.id, installDir: g.installDir })))
    void this.files?.setGames(games)
  }

  private gameStarted(id: string): void {
    const game = this.db.data.games[id]
    if (game?.status === 'cloud-newer' && game.newerSnapshot) {
      this.notify(`Newer ${game.name} save in the cloud`, `From ${game.newerSnapshot.machine}. Quit the game and restore it in SaveMe if you want that save.`, id)
    }
    this.changed()
  }

  // ---- actions from the UI ----

  backupAll(trigger: 'manual' | 'first-backup' = 'manual', onlyNew = false): void {
    for (const g of Object.values(this.db.data.games)) {
      if (g.tracked && g.roots.length && (!onlyNew || g.status === 'never')) this.engine.enqueue(g.id, trigger)
    }
  }

  backupNow(id: string): void {
    this.engine.enqueue(id, 'manual')
  }

  setTracked(id: string, tracked: boolean): void {
    const g = this.db.data.games[id]
    if (!g) return
    g.tracked = tracked
    this.db.save()
    this.refreshWatchers()
    if (tracked) this.engine.enqueue(id, 'first-backup')
    this.changed()
  }

  updateSettings(patch: Partial<Settings>): Settings {
    if (patch.retention !== undefined) validateRetention(patch.retention)
    const previous = { ...this.db.data.settings }
    Object.assign(this.db.data.settings, patch)
    // Settings are infrequent and must survive an immediate quit after the IPC reply.
    try { this.db.flush() }
    catch (error) { Object.assign(this.db.data.settings, previous); throw error }
    this.changed()
    return this.db.data.settings
  }

  openSaveFolder(id: string): void {
    const g = this.db.data.games[id]
    const dir = g && watchDirs(g)[0]
    if (!dir || !fs.existsSync(dir)) return
    if (fs.statSync(dir).isDirectory()) void shell.openPath(path.normalize(dir))
    else shell.showItemInFolder(path.normalize(dir))
  }

  isRunning(id: string): boolean {
    return this.procs.running.has(id)
  }

  shutdown(): void {
    this.engine?.stop()
    this.procs?.stop()
    void this.files?.close()
    this.db.flush()
  }
}
