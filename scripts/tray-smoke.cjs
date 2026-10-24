// Bundle src/main/window.ts and src/main/store/db.ts to .tmp/window.cjs and .tmp/db.cjs.
// Run with Electron, then run again with --reopen to verify a cold-start taskbar preference.
const { app, BrowserWindow, Tray } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const koffi = require('koffi')
const nativeVisible = koffi.load('user32.dll').func('int __stdcall IsWindowVisible(uintptr_t hwnd)')
const { installMinimizeBehavior, restoreWindow } = require('../.tmp/window.cjs')
const { Db } = require('../.tmp/db.cjs')
const root = path.resolve(__dirname, '..')
const output = path.join(root, '.tmp/tray-smoke')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
app.setAppUserModelId('app.saveme.tray-test')
const reopening = process.argv.includes('--reopen')
const db = new Db(path.join(output, 'state.json'))
let win, tray
const taskbarWindow = () => !!nativeVisible(win.getNativeWindowHandle().readBigUInt64LE())
const wait = async fn => {
  const deadline = Date.now() + 6000
  while (!fn()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for native window state')
    await new Promise(resolve => setTimeout(resolve, 30))
  }
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 850, height: 580, title: 'SaveMe minimize verification', icon: path.join(root, 'resources/icon.ico') })
  installMinimizeBehavior(win, () => db.data.settings.minimizeToTray)
  tray = new Tray(path.join(root, 'resources/tray.png'))
  tray.on('click', () => restoreWindow(win))
  await win.loadURL('data:text/html,<body style="background:%23111318;color:white;font:16px Segoe UI;padding:30px">SaveMe minimize behavior verification</body>')
  win.showInactive()
  await wait(() => win.isVisible())
  if (reopening) {
    assert.equal(db.data.settings.minimizeToTray, false, 'saved taskbar choice survives a cold start')
  } else {
    db.data.settings.minimizeToTray = true
    db.flush()
    win.minimize()
    await wait(() => !taskbarWindow())
    tray.emit('click', {}, {})
    await wait(() => win.isVisible() && !win.isMinimized())
    db.data.settings.minimizeToTray = false
    db.flush()
  }
  win.minimize()
  await wait(() => win.isMinimized())
  assert(taskbarWindow(), 'normal Windows minimize keeps the native window visible to the taskbar')
  tray.emit('click', {}, {})
  await wait(() => win.isVisible() && !win.isMinimized())
  if (!reopening) {
    // Changing the setting is live: the already-created window uses the new choice.
    db.data.settings.minimizeToTray = true
    db.flush()
    win.minimize()
    await wait(() => !taskbarWindow())
    restoreWindow(win) // same path used by a second launch and tray/notification activation
    await wait(() => win.isVisible() && !win.isMinimized())
    db.data.settings.minimizeToTray = false
    db.flush()
  }
  console.log(reopening ? 'PASS: taskbar preference persisted across cold restart; tray activation restores the window' : 'PASS: native minimize hides to tray, taskbar mode stays visible, changes apply live, tray/second-launch activation restores')
  tray.destroy()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
