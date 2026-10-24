import { contextBridge, ipcRenderer } from 'electron'

const channels = [
  'state',
  'scan',
  'backupAll',
  'backupNow',
  'setTracked',
  'history',
  'restore',
  'keepLocal',
  'connect',
  'configureAndConnect',
  'openUrl',
  'disconnect',
  'refreshQuota',
  'openSaveFolder',
  'addCustomGame',
  'updateSettings',
  'pickFolder'
] as const

const api: Record<string, unknown> = {}
for (const ch of channels) {
  api[ch] = async (...args: unknown[]) => {
    const res = await ipcRenderer.invoke(ch, ...args)
    if (!res.ok) throw new Error(res.error)
    return res.value
  }
}
api.onState = (fn: (s: unknown) => void) => {
  const listener = (_: unknown, s: unknown): void => fn(s)
  ipcRenderer.on('state', listener)
  return () => ipcRenderer.removeListener('state', listener)
}
api.onNavigate = (fn: (route: string) => void) => {
  const listener = (_: unknown, r: string): void => fn(r)
  ipcRenderer.on('navigate', listener)
  return () => ipcRenderer.removeListener('navigate', listener)
}

contextBridge.exposeInMainWorld('saveme', api)
