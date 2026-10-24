import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { ProviderKind, Settings, UpdateState } from '../shared/types'
import { SaveMeApp } from './app'
import { OAuthIds } from './config'

/** Links the UI may open: app registration, SaveMe's site and repo, and where users revoke SaveMe's access. */
const EXTERNAL = /^https:\/\/(console\.cloud\.google\.com|entra\.microsoft\.com|portal\.azure\.com|calinadrian\.github\.io\/saveme|github\.com\/calinadrian\/saveme|myaccount\.google\.com\/permissions|account\.live\.com\/consent)(\/|$)/

/** Every renderer call; the preload exposes the same names as `window.saveme`. */
export function registerIpc(
  saveme: SaveMeApp,
  { win, updates, resources }: { win: () => BrowserWindow | undefined; updates: { get(): UpdateState; check(): UpdateState; install(): void }; resources: string }
): void {
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
    if (EXTERNAL.test(url)) void shell.openExternal(url)
  })
  handle('openLicenses', () => shell.openPath(path.join(resources, 'THIRD-PARTY-NOTICES.txt')))
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
  handle('updateState', () => updates.get())
  handle('checkForUpdate', () => updates.check())
  handle('installUpdate', () => updates.install())

  saveme.onState((s) => win()?.webContents.send('state', s))
}
