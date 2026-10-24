// Types shared between the main process and the renderer.

export type ProviderKind = 'gdrive' | 'onedrive' | 'local'

export type GameStatus = 'synced' | 'pending' | 'backing-up' | 'cloud-newer' | 'error' | 'never'

export interface SaveRoot {
  /** Manifest template, e.g. `<winAppData>/Foo/*.sav` */
  template: string
  /** Template resolved for this PC (may still contain glob characters) */
  resolved: string
}

export interface Game {
  id: string
  name: string
  store?: 'steam' | 'epic' | 'gog' | 'custom'
  steamId?: number
  installDir?: string
  roots: SaveRoot[]
  tracked: boolean
  custom?: boolean
  status: GameStatus
  sizeBytes: number
  fileCount: number
  lastBackupAt?: string
  lastSnapshotId?: string
  /** sha256 per portable path of the last snapshot taken or restored on this PC */
  lastHashes?: Record<string, string>
  error?: string
  newerSnapshot?: SnapshotMeta
}

export interface SnapshotMeta {
  id: string
  gameId: string
  createdAt: string
  machine: string
  machineId: string
  trigger: 'game-exit' | 'file-change' | 'manual' | 'pre-restore' | 'first-backup'
  sizeBytes: number
  zipBytes: number
  files: Record<string, string>
}

export interface GameIndex {
  gameId: string
  name: string
  snapshots: SnapshotMeta[]
}

export interface Catalog {
  updatedAt: string
  games: {
    id: string
    name: string
    snapshots: number
    bytes: number
    lastBackupAt?: string
    lastSnapshotId?: string
    lastMachine?: string
  }[]
}

export interface RetentionPolicy {
  keepLast: number
  keepDaily: number
  keepWeekly: number
}

export interface Settings {
  provider?: ProviderKind
  localFolder?: string
  /** Folder inside the storage that holds the backups, per provider (see DEFAULT_REMOTE_FOLDER). */
  remoteFolder?: Partial<Record<ProviderKind, string>>
  startAtLogin: boolean
  notifications: boolean
  /** Check GitHub for new versions on launch and every 6 hours, and install them while idle in the tray. */
  autoUpdate: boolean
  retention: RetentionPolicy
  extraLibraryFolders: string[]
}

export interface Quota {
  totalBytes?: number
  usedBytes?: number
  account?: string
}

export interface ActivityItem {
  at: string
  gameId?: string
  kind: 'backup' | 'restore' | 'skip' | 'error' | 'info'
  message: string
}

export interface AppState {
  machine: string
  settings: Settings
  games: Game[]
  activity: ActivityItem[]
  provider: {
    kind?: ProviderKind
    connected: boolean
    account?: string
    /** Where backups go, e.g. `My Drive/SaveMe` */
    location?: string
    configured: Record<ProviderKind, boolean>
  }
  quota?: Quota
  saveMeBytes: number
  scanning: boolean
  scanProgress?: string
  running: string[]
  queue: string[]
}

export type UpdateNotes = { title: string; items: string[] }[]

export interface UpdateState {
  /** The running version */
  current: string
  /** `dev`: not an installed copy, so it never updates */
  status: 'dev' | 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'installing' | 'error'
  /** The new version, while downloading or ready */
  version?: string
  percent?: number
  notes?: UpdateNotes
  checkedAt?: number
  message?: string
}

export const DEFAULT_RETENTION: RetentionPolicy = { keepLast: 10, keepDaily: 14, keepWeekly: 8 }

/** OneDrive's app folder is already Apps/SaveMe, so no extra folder there by default. */
export const DEFAULT_REMOTE_FOLDER: Record<ProviderKind, string> = { gdrive: 'SaveMe', onedrive: '', local: 'SaveMe' }

/** Where each storage's folder path starts, as shown to the user. */
export const REMOTE_ROOT_LABEL: Record<ProviderKind, string> = { gdrive: 'My Drive', onedrive: 'OneDrive/Apps/SaveMe', local: '' }

/** `a\b//c/../d ` -> `a/b/c/d`: forward slashes, no empty, `.` or `..` parts. */
export function cleanFolder(folder: string): string {
  return folder
    .split(/[\\/]+/)
    .map((p) => p.trim().replace(/[<>:"|?*]/g, ''))
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/')
}

/** Where backups go, as shown to the user: `My Drive/SaveMe`, or `E:\Backups\SaveMe` for a folder. */
export function locationLabel(kind: ProviderKind, localFolder: string | undefined, folder: string): string {
  if (kind === 'local') return [localFolder?.replace(/[\\/]+$/, ''), folder.replace(/\//g, '\\')].filter(Boolean).join('\\')
  return [REMOTE_ROOT_LABEL[kind], folder].filter(Boolean).join('/')
}

export function remoteFolderFor(settings: Pick<Settings, 'remoteFolder'>, kind: ProviderKind): string {
  return cleanFolder(settings.remoteFolder?.[kind] ?? DEFAULT_REMOTE_FOLDER[kind])
}
