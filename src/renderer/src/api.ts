import { useEffect, useState } from 'react'
import type { AppState, GameIndex, ProviderKind, Settings } from '../../shared/types'

export interface SaveMeApi {
  state(): Promise<AppState>
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
  disconnect(): Promise<void>
  refreshQuota(): Promise<void>
  openSaveFolder(id: string): Promise<void>
  addCustomGame(name: string, folder: string): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  pickFolder(title: string): Promise<string | undefined>
  onState(fn: (s: AppState) => void): () => void
  onNavigate(fn: (route: string) => void): () => void
}

declare global {
  interface Window {
    saveme: SaveMeApi
  }
}

export const api = window.saveme

export function useAppState(): AppState | undefined {
  const [state, setState] = useState<AppState>()
  useEffect(() => {
    void api.state().then(setState)
    return api.onState(setState)
  }, [])
  return state
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

export function timeAgo(iso?: string): string {
  if (!iso) return 'never'
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
  return new Date(iso).toLocaleDateString()
}
