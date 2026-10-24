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
  refreshBackupUsage(): Promise<void>
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

/** Keep the control retryable even if an IPC reply never arrives. The main scan expires earlier. */
export async function refreshUsageWithTimeout(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([api.refreshBackupUsage(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Storage check timed out. Try refreshing again.')), 25_000)
    })])
  } finally { clearTimeout(timer) }
}

export const SITE = 'https://calinadrian.github.io/saveme/'
export const REPO = 'https://github.com/calinadrian/saveme'

export type AppLoadState = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; value: AppState }

export function useAppState(): [AppLoadState, () => void] {
  const [state, setState] = useState<AppLoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    let receivedEvent = false
    setState({ status: 'loading' })
    const stop = api.onState(value => { receivedEvent = true; if (active) setState({ status: 'ready', value }) })
    void api.state().then(value => { if (active && !receivedEvent) setState({ status: 'ready', value }) }).catch(error => {
      if (active && !receivedEvent) setState({ status: 'error', error: (error as Error).message })
    })
    return () => { active = false; stop() }
  }, [attempt])
  return [state, () => setAttempt(n => n + 1)]
}

export function useUpdate(): UpdateState {
  const [update, setUpdate] = useState<UpdateState>({ current: '', status: 'dev' })
  useEffect(() => {
    let active = true, receivedEvent = false
    const stop = api.onUpdate(value => { receivedEvent = true; if (active) setUpdate(value) })
    void api.updateState().then(value => { if (active && !receivedEvent) setUpdate(value) }).catch(error => {
      if (active && !receivedEvent) setUpdate({ status: 'error', current: '', message: `Could not load update status: ${(error as Error).message}` })
    })
    return () => { active = false; stop() }
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
