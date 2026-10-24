import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, nativeImage, Notification, Tray, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { SaveMeApp } from './app'
import { registerIpc } from './ipc'
import { createUpdates, Updater } from './updates'
import { APP_ID, DEV_APP_ID, repairSaveMeShortcuts } from './identity'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const resources = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources') : path.join(app.getAppPath(), 'resources')
const HOUR = 60 * 60_000

let win: BrowserWindow | undefined
let tray: Tray | undefined
let saveme: SaveMeApp
let quitting = false
let refreshTray: (() => void) | undefined

app.setName('SaveMe')
const appId = app.isPackaged ? APP_ID : DEV_APP_ID
app.setAppUserModelId(appId)
const primary = app.requestSingleInstanceLock()

/**
 * Written right before an update installs, read on the next start. An update installed while SaveMe sat
 * in the tray reopens in the tray too; the installer itself always relaunches with `--updated`.
 */
const updateMarker = path.join(app.getPath('userData'), 'update.json')
let afterUpdate: { from: string; hidden: boolean } | undefined
try {
  if (primary) {
    afterUpdate = JSON.parse(fs.readFileSync(updateMarker, 'utf8'))
    fs.rmSync(updateMarker)
  }
} catch {
  // no update just happened
}
const startHidden = process.argv.includes('--updated') ? !!afterUpdate?.hidden : process.argv.includes('--hidden')

const updates = createUpdates({
  current: app.getVersion(),
  // Only installed copies update; electron-updater needs the app-update.yml that the installer adds.
  updater: app.isPackaged ? (electronUpdater.autoUpdater as unknown as Updater) : null,
  publish: (state) => {
    if (win && !win.isDestroyed()) win.webContents.send('update', state)
    refreshTray?.()
  },
  beforeInstall: () => {
    quitting = true
  }
})

function installUpdate(hidden: boolean): void {
  if (updates.get().status !== 'ready') return
  try {
    fs.writeFileSync(updateMarker, JSON.stringify({ from: app.getVersion(), hidden }))
  } catch {
    // reopening visibly is fine too
  }
  updates.install()
}

if (!primary) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(start)
}

function showWindow(route?: string): void {
  if (!win || win.isDestroyed()) createWindow()
  if (route) win!.webContents.send('navigate', route)
  win!.show()
  win!.focus()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 820,
    minHeight: 580,
    show: false,
    title: 'SaveMe',
    backgroundColor: '#0c0e11',
    icon: path.join(resources, 'icon.ico'),
    // Our own title bar (see TitleBar in App.tsx) with the native Windows buttons on top.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0e11', symbolColor: '#a3a9b5', height: 40 },
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true }
  })
  // Explicit shell identity also supplies the icon when running through electron.exe in development.
  win.setAppDetails({
    appId,
    appIconPath: path.join(resources, 'icon.ico'),
    relaunchDisplayName: 'SaveMe',
    relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`
  })
  win.on('close', (e) => {
    // Closing the window keeps SaveMe running in the tray.
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.once('ready-to-show', () => {
    if (!startHidden || !saveme.db.data.settings.provider) win?.show()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function notify(title: string, body: string, gameId?: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: path.join(resources, 'icon.png'), silent: true })
  n.on('click', () => showWindow(gameId ? `/game/${gameId}` : '/'))
  n.show()
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(path.join(resources, 'tray.png')))
  refreshTray = (): void => {
    const s = saveme.state()
    const u = updates.get()
    const pending = s.games.filter((g) => g.status === 'cloud-newer').length
    const failed = s.games.filter((g) => g.status === 'error').length
    const busy = s.queue.length
      ? `Backing up ${s.queue.length} game${s.queue.length > 1 ? 's' : ''}…`
      : !s.provider.connected
        ? 'Not connected'
        : failed
          ? `${failed} backup${failed > 1 ? 's' : ''} failed`
          : pending
            ? 'Newer saves waiting in the cloud'
            : 'All saves backed up'
    tray!.setToolTip(`SaveMe: ${busy}`)
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label: busy, enabled: false },
        ...(pending ? [{ label: `${pending} newer save${pending > 1 ? 's' : ''} in the cloud`, click: () => showWindow('/games') }] : []),
        { type: 'separator' },
        { label: 'Open SaveMe', click: () => showWindow() },
        { label: 'Back up all now', click: () => saveme.backupAll() },
        { label: 'Scan for games', click: () => void saveme.scan() },
        ...(u.status === 'ready' ? [{ type: 'separator' as const }, { label: `Restart to update to ${u.version}`, click: () => installUpdate(!win?.isVisible()) }] : []),
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
  }
  refreshTray()
  saveme.onState(refreshTray)
  tray.on('click', () => showWindow())
}

/** A downloaded update installs by itself once SaveMe is only in the tray and has nothing to do. */
function idle(): boolean {
  const s = saveme.state()
  return !win?.isVisible() && !s.queue.length && !s.running.length && !s.scanning
}

function watchUpdates(): void {
  if (updates.get().status === 'dev') return
  const auto = (): boolean => saveme.db.data.settings.autoUpdate
  setTimeout(() => auto() && updates.check(), 10_000)
  setInterval(() => auto() && updates.check(), 6 * HOUR).unref()
  setInterval(() => auto() && idle() && installUpdate(true), 5 * 60_000).unref()
}

async function start(): Promise<void> {
  if (process.platform === 'win32' && app.isPackaged) {
    try {
      repairSaveMeShortcuts(
        path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        path.join(app.getPath('userData'), 'shortcut-backups'),
        process.execPath, path.join(resources, 'icon.ico'), shell
      )
    } catch (error) { console.warn('[saveme] Windows identity:', (error as Error).message) }
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Quit SaveMe', accelerator: 'Ctrl+Q', click: () => app.quit() }] },
    { role: 'editMenu' }, { role: 'viewMenu' }
  ]))
  saveme = new SaveMeApp(app.getPath('userData'), notify)
  await saveme.init()
  registerIpc(saveme, { win: () => win, updates: { get: updates.get, check: updates.check, install: () => installUpdate(false) }, resources })
  // A development run would register electron.exe without the app path, which can't start SaveMe.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: saveme.db.data.settings.startAtLogin, args: ['--hidden'] })
  createTray()
  createWindow()
  if (afterUpdate && afterUpdate.from !== app.getVersion()) {
    saveme.db.log({ kind: 'info', message: `SaveMe updated to ${app.getVersion()}` })
    if (startHidden && saveme.db.data.settings.notifications) notify(`SaveMe updated to ${app.getVersion()}`, 'Your backups carry on as before.')
  }
  watchUpdates()
  if (!saveme.db.data.lastScanAt) void saveme.scan()
}

app.on('before-quit', () => {
  quitting = true
  saveme?.shutdown()
})

// Keep running in the tray when all windows are closed.
app.on('window-all-closed', () => undefined)
