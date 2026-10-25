import { contextBridge, ipcRenderer } from 'electron'

const channels = [
  'state',
  'artwork',
  'scan',
  'backupAll',
  'backupNow',
  'setTracked',
  'history',
  'restore',
  'previewRestore',
  'verifySnapshot',
  'renameSnapshot',
  'pinSnapshot',
  'unpinSnapshot',
  'diagnostics',
  'exportDiagnostics',
  'keepLocal',
  'connect',
  'configureAndConnect',
  'setRemoteFolder',
  'openUrl',
  'openLicenses',
  'disconnect',
  'refreshQuota',
  'refreshBackupUsage',
  'openSaveFolder',
  'addCustomGame',
  'updateSettings',
  'pickFolder',
  'updateState',
  'checkForUpdate',
  'installUpdate'
] as const

const api: Record<string, unknown> = {}
api.initialTheme = ipcRenderer.sendSync('theme:initial')
const applyTheme = (): void => {
  if (document.documentElement) document.documentElement.dataset.theme = api.initialTheme as string
}
// Preload may run before <html> exists. Apply as soon as it is parsed, before CSS paints.
if (document.documentElement) applyTheme()
else {
  const observer = new MutationObserver(() => {
    if (document.documentElement) { applyTheme(); observer.disconnect() }
  })
  observer.observe(document, { childList: true })
}
ipcRenderer.on('theme', (_event, theme: 'dark' | 'light') => { api.initialTheme = theme; applyTheme() })
api.onTheme = (fn: (theme: 'dark' | 'light') => void) => {
  const listener = (_: unknown, theme: 'dark' | 'light'): void => fn(theme)
  ipcRenderer.on('theme', listener)
  fn(api.initialTheme as 'dark' | 'light')
  return () => ipcRenderer.removeListener('theme', listener)
}
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
api.onUpdate = (fn: (u: unknown) => void) => {
  const listener = (_: unknown, u: unknown): void => fn(u)
  ipcRenderer.on('update', listener)
  return () => ipcRenderer.removeListener('update', listener)
}

contextBridge.exposeInMainWorld('saveme', api)
