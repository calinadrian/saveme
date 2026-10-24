import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { ProviderKind, Settings } from '../shared/types'
import { SaveMeApp } from './app'
import { OAuthIds } from './config'

/** Every renderer call; the preload exposes the same names as `window.saveme`. */
export function registerIpc(saveme: SaveMeApp, win: () => BrowserWindow | undefined): void {
  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, value: await fn(...(args as never[])) }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    })
  }

  handle('state', () => saveme.state())
  handle('scan', () => saveme.scan())
  handle('backupAll', () => saveme.backupAll())
  handle('backupNow', (id: string) => saveme.backupNow(id))
  handle('setTracked', (id: string, tracked: boolean) => saveme.setTracked(id, tracked))
  handle('history', (id: string) => saveme.engine.index(id))
  handle('restore', (id: string, snapshotId: string) => saveme.engine.restore(id, snapshotId))
  handle('keepLocal', (id: string) => saveme.engine.keepLocal(id))
  handle('connect', (kind: ProviderKind, folder?: string, remoteFolder?: string) => saveme.connect(kind, folder, remoteFolder))
  handle('configureAndConnect', (kind: 'gdrive' | 'onedrive', ids: OAuthIds, remoteFolder?: string) => saveme.configureAndConnect(kind, ids, remoteFolder))
  handle('setRemoteFolder', (folder: string) => saveme.setRemoteFolder(folder))
  handle('openUrl', (url: string) => {
    if (/^https:\/\/(console\.cloud\.google\.com|entra\.microsoft\.com|portal\.azure\.com)\//.test(url)) void shell.openExternal(url)
  })
  handle('disconnect', () => saveme.disconnect())
  handle('refreshQuota', () => saveme.refreshQuota())
  handle('openSaveFolder', (id: string) => saveme.openSaveFolder(id))
  handle('addCustomGame', (name: string, folder: string) => saveme.addCustomGame(name, folder))
  handle('updateSettings', (patch: Partial<Settings>) => {
    const s = saveme.updateSettings(patch)
    if (patch.startAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: s.startAtLogin, args: ['--hidden'] })
    return s
  })
  handle('pickFolder', async (title: string) => {
    const w = win()
    const opts = { title, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? undefined : res.filePaths[0]
  })

  saveme.onState((s) => win()?.webContents.send('state', s))
}
