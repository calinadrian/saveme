import { useEffect, useState } from 'react'
import type { AppState, GameIndex, ProviderKind, Settings, UpdateState } from '../../shared/types'

export interface SaveMeApi {
  state(): Promise<AppState>
  artwork(id: string): Promise<string | undefined>
  scan(): Promise<void>
  backupAll(): Promise<void>
  backupNow(id: string): Promise<void>
  setTracked(id: string, tracked: boolean): Promise<void>
  history(id: string): Promise<GameIndex | undefined>
  restore(id: string, snapshotId: string): Promise<void>
  keepLocal(id: string): Promise<void>
  connect(kind: ProviderKind, folder?: string, remoteFolder?: string): Promise<void>
  configureAndConnect(
    kind: 'gdrive' | 'onedrive',
    ids: { googleClientId?: string; googleClientSecret?: string; microsoftClientId?: string },
    remoteFolder?: string
  ): Promise<void>
  setRemoteFolder(folder: string): Promise<void>
  openUrl(url: string): Promise<void>
  openLicenses(): Promise<void>
  disconnect(): Promise<void>
  refreshQuota(): Promise<void>
  openSaveFolder(id: string): Promise<void>
  addCustomGame(name: string, folder: string): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  pickFolder(title: string): Promise<string | undefined>
  updateState(): Promise<UpdateState>
  checkForUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onState(fn: (s: AppState) => void): () => void
  onNavigate(fn: (route: string) => void): () => void
  onUpdate(fn: (u: UpdateState) => void): () => void
}

declare global {
  interface Window {
    saveme: SaveMeApi
  }
}

export const api = window.saveme

export const SITE = 'https://calinadrian.github.io/saveme/'
export const REPO = 'https://github.com/calinadrian/saveme'

export function useAppState(): AppState | undefined {
  const [state, setState] = useState<AppState>()
  useEffect(() => {
    void api.state().then(setState)
    return api.onState(setState)
  }, [])
  return state
}

export function useUpdate(): UpdateState {
  const [update, setUpdate] = useState<UpdateState>({ current: '', status: 'dev' })
  useEffect(() => {
    void api.updateState().then(setUpdate)
    return api.onUpdate(setUpdate)
  }, [])
  return update
}

export function formatBytes(n?: number): string {
  if (n === undefined) return '–'
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

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function timeAgo(iso?: string | number): string {
  if (!iso) return 'never'
  const at = typeof iso === 'number' ? iso : Date.parse(iso)
  const s = (Date.now() - at) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return relative.format(-Math.floor(s / 60), 'minute')
  if (s < 86400) return relative.format(-Math.floor(s / 3600), 'hour')
  if (s < 86400 * 30) return relative.format(-Math.floor(s / 86400), 'day')
  return new Date(at).toLocaleDateString()
}

/** Save paths are kept with forward slashes; show them the way Windows does. */
export const winPath = (p: string): string => p.replace(/\//g, '\\')

export const plural =(n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
