import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron'
import { SaveMeApp } from './app'
import { registerIpc } from './ipc'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const resources = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources') : path.join(app.getAppPath(), 'resources')
const startHidden = process.argv.includes('--hidden')

let win: BrowserWindow | undefined
let tray: Tray | undefined
let saveme: SaveMeApp
let quitting = false

app.setName('SaveMe')
app.setAppUserModelId('app.saveme.desktop')

if (!app.requestSingleInstanceLock()) {
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
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'SaveMe',
    backgroundColor: '#0f1115',
    icon: path.join(resources, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true }
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
  const update = (): void => {
    const s = saveme.state()
    const busy = s.queue.length ? `Backing up ${s.queue.length} game${s.queue.length > 1 ? 's' : ''}…` : s.provider.connected ? 'All saves backed up' : 'Not connected'
    const pending = s.games.filter((g) => g.status === 'cloud-newer').length
    tray!.setToolTip(`SaveMe: ${busy}`)
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label: busy, enabled: false },
        ...(pending ? [{ label: `${pending} newer save${pending > 1 ? 's' : ''} in the cloud`, click: () => showWindow('/games') }] : []),
        { type: 'separator' },
        { label: 'Open SaveMe', click: () => showWindow() },
        { label: 'Back up all now', click: () => saveme.backupAll() },
        { label: 'Scan for games', click: () => void saveme.scan() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
  }
  update()
  saveme.onState(update)
  tray.on('click', () => showWindow())
}

async function start(): Promise<void> {
  saveme = new SaveMeApp(app.getPath('userData'), notify)
  await saveme.init()
  registerIpc(saveme, () => win)
  app.setLoginItemSettings({ openAtLogin: saveme.db.data.settings.startAtLogin, args: ['--hidden'] })
  createTray()
  createWindow()
  if (!saveme.db.data.lastScanAt) void saveme.scan()
}

app.on('before-quit', () => {
  quitting = true
  saveme?.shutdown()
})

// Keep running in the tray when all windows are closed.
app.on('window-all-closed', () => undefined)
