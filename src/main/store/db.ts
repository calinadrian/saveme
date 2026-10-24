import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { ActivityItem, DEFAULT_RETENTION, Game, Settings } from '../../shared/types'

export interface DbData {
  machineId: string
  settings: Settings
  games: Record<string, Game>
  activity: ActivityItem[]
  /** Encrypted refresh tokens per provider (base64) */
  tokens: Record<string, string>
  /** Games waiting to be backed up (survives restarts and offline periods) */
  queue: { gameId: string; trigger: string }[]
  lastScanAt?: string
}

const MAX_ACTIVITY = 200

/** Small JSON store with atomic, debounced writes. */
export class Db {
  data: DbData
  private timer?: NodeJS.Timeout

  constructor(private file: string) {
    this.data = Db.load(file)
  }

  static load(file: string): DbData {
    const fresh: DbData = {
      machineId: crypto.randomUUID(),
      settings: {
        startAtLogin: true,
        notifications: true,
        retention: { ...DEFAULT_RETENTION },
        extraLibraryFolders: []
      },
      games: {},
      activity: [],
      tokens: {},
      queue: []
    }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DbData>
      return { ...fresh, ...raw, settings: { ...fresh.settings, ...raw.settings } }
    } catch {
      return fresh
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
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1))
    fs.renameSync(tmp, this.file)
  }
}
