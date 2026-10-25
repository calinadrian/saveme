import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { ActivityItem, DEFAULT_RETENTION, LEGACY_RETENTION, Game, Settings, VerificationResult } from '../../shared/types'
import { validateAppearance } from '../../shared/appearance'

export interface DbData {
  machineId: string
  settings: Settings
  games: Record<string, Game>
  activity: ActivityItem[]
  /** Encrypted refresh tokens per provider (base64) */
  tokens: Record<string, string>
  /** Games waiting to be backed up (survives restarts and offline periods) */
  queue: { gameId: string; trigger: string }[]
  maintenance: Record<string, string[]>
  verifications?: Record<string, VerificationResult>
  lastScanAt?: string
}

const MAX_ACTIVITY = 200

/** Small JSON store with atomic, debounced writes. */
export class Db {
  data: DbData
  private timer?: NodeJS.Timeout
  private lastGood: string

  constructor(private file: string) {
    this.data = Db.load(file)
    this.lastGood = JSON.stringify(this.data, null, 1)
  }

  get recoveryDirectory(): string { return path.join(path.dirname(this.file), 'restore-recovery') }
  get stagingDirectory(): string { return path.join(path.dirname(this.file), 'operations') }

  get recoveryWarning(): string | undefined { return this.data.activity.find(a => a.message.startsWith('Local settings recovered'))?.message }

  static load(file: string): DbData {
    const fresh: DbData = {
      machineId: crypto.randomUUID(),
      settings: {
        appearance: 'dark',
        startAtLogin: true,
        minimizeToTray: true,
        notifications: true,
        autoUpdate: true,
        retention: { ...DEFAULT_RETENTION },
        extraLibraryFolders: []
      },
      games: {},
      activity: [],
      tokens: {},
      queue: [],
      maintenance: {}
    }
    const parse = (source: string): DbData => {
      const raw = JSON.parse(fs.readFileSync(source, 'utf8')) as Partial<DbData>
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a settings object')
      const record = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v)
      if (
        (raw.machineId !== undefined && typeof raw.machineId !== 'string') ||
        (raw.settings !== undefined && !record(raw.settings)) ||
        (raw.games !== undefined && !record(raw.games)) ||
        (raw.tokens !== undefined && (!record(raw.tokens) || Object.values(raw.tokens).some(t => typeof t !== 'string'))) ||
        (raw.queue !== undefined && (!Array.isArray(raw.queue) || raw.queue.some(q => !q || typeof q.gameId !== 'string' || typeof q.trigger !== 'string'))) ||
        (raw.activity !== undefined && (!Array.isArray(raw.activity) || raw.activity.some(a => !a || typeof a.message !== 'string' || typeof a.at !== 'string')))
      ) throw new Error('Invalid local settings structure')
      for (const [id, game] of Object.entries(raw.games ?? {})) {
        if (!game || game.id !== id || typeof game.name !== 'string' || !Array.isArray(game.roots) ||
          game.roots.some(r => !r || typeof r.template !== 'string' || typeof r.resolved !== 'string') ||
          typeof game.tracked !== 'boolean' || !['synced', 'pending', 'backing-up', 'cloud-newer', 'error', 'never'].includes(game.status) ||
          !Number.isFinite(game.sizeBytes) || game.sizeBytes < 0 || !Number.isInteger(game.fileCount) || game.fileCount < 0
          || (game.resolvedHeads !== undefined && (!Array.isArray(game.resolvedHeads) || game.resolvedHeads.some(id => typeof id !== 'string' || !/^[\w-]{1,240}$/.test(id))))
          || (game.retryAt !== undefined && !Number.isFinite(game.retryAt))
        ) throw new Error('Invalid saved game')
      }
      if (raw.verifications !== undefined && (!record(raw.verifications) || Object.entries(raw.verifications).some(([key,v]) =>
        !/^[a-f0-9]{64}$/.test(key) || !v || !['verified','corrupt','unavailable'].includes(v.status) || !Number.isFinite(Date.parse(v.checkedAt))
      ))) throw new Error('Invalid verification history')
      const s = raw.settings
      if (s?.appearance !== undefined) validateAppearance(s.appearance)
      if (raw.maintenance !== undefined && (!record(raw.maintenance) || Object.entries(raw.maintenance).some(([id, ids]) =>
        !/^[\w-]+$/.test(id) || !Array.isArray(ids) || ids.some(s => typeof s !== 'string' || !/^[\w-]+$/.test(s))
      ))) throw new Error('Invalid pending history maintenance')
      for (const key of ['startAtLogin', 'minimizeToTray', 'notifications', 'autoUpdate'] as const) if (s?.[key] !== undefined && typeof s[key] !== 'boolean') throw new Error(`Invalid setting: ${key}`)
      if (s?.provider !== undefined && !['local', 'gdrive', 'onedrive'].includes(s.provider)) throw new Error('Invalid storage provider')
      if (s?.extraLibraryFolders !== undefined && (!Array.isArray(s.extraLibraryFolders) || s.extraLibraryFolders.some(f => typeof f !== 'string'))) throw new Error('Invalid game folders')
      if (s?.retention !== undefined && (!record(s.retention) || Object.values(s.retention).some(n => !Number.isSafeInteger(n) || n < 0))) throw new Error('Invalid retention settings')
      return { ...fresh, ...raw, settings: { ...fresh.settings, ...s, retention: { ...LEGACY_RETENTION, ...s?.retention } } }
    }
    try { return parse(file) }
    catch (primaryError) {
      const missing = (primaryError as NodeJS.ErrnoException).code === 'ENOENT'
      // Preserve the original bytes before any future save can replace the damaged file.
      const preserved = `${file}.corrupt-${crypto.randomUUID()}`
      if (!missing) {
        try { fs.copyFileSync(file, preserved, fs.constants.COPYFILE_EXCL) }
        catch (e) { throw new Error(`Cannot read or preserve local settings at ${file}: ${(e as Error).message}`) }
      }
      try {
        const recovered = parse(file + '.bak')
        recovered.activity.unshift({ at: new Date().toISOString(), kind: 'error', message: `Local settings recovered from the previous copy. ${missing ? 'The main settings file was missing.' : `The unreadable file is preserved at ${preserved}.`} Check your games and storage settings.` })
        return recovered
      } catch (backupError) {
        if (missing && (backupError as NodeJS.ErrnoException).code === 'ENOENT') return fresh
        throw new Error(`Cannot recover local settings at ${file}. ${missing ? '' : `Original preserved at ${preserved}. `}Previous copy: ${(backupError as Error).message}. Your cloud backups have not been changed.`)
      }
    }
  }

  get machine(): string {
    return os.hostname()
  }

  log(item: Omit<ActivityItem, 'at'>): void {
    this.data.activity.unshift({ at: new Date().toISOString(), ...item })
    this.data.activity.length = Math.min(this.data.activity.length, MAX_ACTIVITY)
    this.save()
  }

  save(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 250)
  }

  flush(): void {
    clearTimeout(this.timer)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    // Rotate only bytes that were validated on load or successfully committed by this instance.
    fs.writeFileSync(this.file + '.bak.tmp', this.lastGood, { flush: true })
    fs.renameSync(this.file + '.bak.tmp', this.file + '.bak')
    const serialized = JSON.stringify(this.data, null, 1)
    fs.writeFileSync(tmp, serialized, { flush: true })
    fs.renameSync(tmp, this.file)
    this.lastGood = serialized
  }
}
