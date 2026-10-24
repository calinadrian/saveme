// After npm run build, bundle src/main/artwork.ts to .tmp/artwork.cjs with esbuild.
// electron scripts/artwork-smoke.cjs [--live-artwork]
// Uses synthetic games; --live-artwork requests only the three public example covers.
const { app, BrowserWindow, session, ipcMain } = require('electron')
const { ArtworkStore } = require('../.tmp/artwork.cjs')
const live = process.argv.includes('--live-artwork')
const libraryPreview = process.argv.includes('--library-preview')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const output = path.join(root, '.tmp', 'artwork-smoke')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
const requests = []
let online = false
const game = (id, name, steamId) => ({ id, name, steamId, tracked: true, status: 'never', roots: [], sizeBytes: 0, fileCount: 0 })
const state = {
  machine: 'Preview PC', settings: { provider: 'local', localFolder: 'C:/Backups', startAtLogin: false, notifications: true, autoUpdate: false, retention: { keepLast: 10, keepDaily: 14, keepWeekly: 8 }, extraLibraryFolders: [] },
  provider: { kind: 'local', connected: true, location: 'C:\\Backups\\SaveMe', configured: { local: true } },
  games: [game('minecraft', 'Minecraft: Java Edition'), game('aion', 'Aion 2', 3393110), game('battlefield', 'Battlefield 6', 2807960), game('forza', 'Forza Horizon 6', 2483190), game('missing', 'Custom game without artwork', 0)],
  activity: [], scanning: true, scanProgress: 'Looking for saves…', running: [], queue: []
}
if (libraryPreview) {
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'SaveMe/state.json'), 'utf8'))
  state.games = Object.values(saved.games).map(g => ({
    id: g.id, name: g.name, steamId: g.steamId, store: g.store, tracked: g.tracked,
    status: g.status, roots: g.roots.length ? [{ template: '', resolved: '' }] : [],
    sizeBytes: g.sizeBytes, fileCount: g.fileCount, lastBackupAt: g.lastBackupAt
  })).sort((a, b) => a.name.localeCompare(b.name))
  state.scanning = false
  online = true
}
const preload = path.join(output, 'preload.cjs')
fs.writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('saveme', {
state: async () => (${JSON.stringify(state)}), updateState: async () => ({status: 'dev', current: '0.1.1'}),
artwork: id => ipcRenderer.invoke('artwork', id), onState: () => () => {}, onUpdate: () => () => {}, onNavigate: () => () => {}, history: async () => undefined
});`)
let win
const waitFor = async (script) => {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(script)) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw Error('Timed out: ' + script)
}
app.whenReady().then(async () => {
  const art = fs.readdirSync(path.join(root, 'out/renderer/assets')).find(n => n.startsWith('minecraft-'))
  const fixture = fs.readFileSync(path.join(root, 'out/renderer/assets', art))
  session.defaultSession.protocol.handle('https', request => {
    requests.push(request.url)
    // All sources fail offline. After reconnecting only the capsule fallback succeeds.
    if (online && request.url.endsWith('/capsule_616x353.jpg')) return new Response(fixture, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } })
    return new Response('', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  })
  const fetchArtwork = async input => {
    const url = String(input)
    if (!online) throw Error('offline fixture')
    if (url.includes('appdetails')) {
      const id = new URL(url).searchParams.get('appids')
      return Response.json({ [id]: { success: true, data: { header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/verified-hash/header_alt_assets_5.jpg` } } })
    }
    return new Response(fixture, { headers: { 'Content-Type': 'image/jpeg' } })
  }
  const artwork = new ArtworkStore(libraryPreview ? path.join(root, '.tmp/library-artwork') : path.join(output, live ? 'live-cache' : `mock-cache-${Date.now()}`), libraryPreview ? async () => { throw Error('Offline cache verification') } : live ? fetch : fetchArtwork)
  ipcMain.handle('artwork', (_event, id) => online ? artwork.get(state.games.find(g => g.id === id)?.steamId) : undefined)
  win = new BrowserWindow({ show: false, width: 1160, height: 780, icon: path.join(root, 'resources/icon.ico'), webPreferences: { preload } })
  win.setAppDetails({ appId: 'app.saveme.desktop.preview', appIconPath: path.join(root, 'resources/icon.ico'), relaunchDisplayName: 'SaveMe Preview' })
  const errors = []
  win.webContents.on('console-message', (_event, ...args) => {
    const message = typeof args[0] === 'object' ? args[0].message : args[1]
    if (/Uncaught|ReferenceError|TypeError/.test(message)) errors.push(message)
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'))
  if (libraryPreview) {
    await waitFor(`document.querySelectorAll('.nav-item').length === 3`)
    await win.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[1].click()`)
    await waitFor(`document.querySelectorAll('.game-row img').length === ${state.games.length}`)
    await waitFor(`[...document.querySelectorAll('.game-row img')].every(img => img.complete && img.naturalWidth > 0)`)
    win.setSize(1160, 960)
    win.showInactive()
    await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await new Promise(resolve => setTimeout(resolve, 200))
    fs.writeFileSync(path.join(output, 'library.png'), (await win.webContents.capturePage()).toPNG())
    assert.deepEqual(errors, [])
    console.log(`PASS: ${state.games.length}/${state.games.length} real library covers decoded offline`)
    app.exit(0)
    return
  }
  await waitFor(`!!document.querySelector('.hero-icon .spinner')`)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.spinner')).animationDuration`), '2s')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.spinner')).animationName`), 'none')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await win.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[1].click()`)
  await waitFor(`document.querySelectorAll('.game-row').length === 5 && document.querySelector('.game-row img')?.complete`)
  await waitFor(`document.querySelectorAll('.game-row .letter').length === 4`)
  online = true
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event('online'))`)
  await waitFor(`document.querySelectorAll('.game-row img').length === 4`)
  await waitFor(`[...document.querySelectorAll('.game-row img')].every(img => img.complete && img.naturalWidth > 0)`)
  assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.btn')).boxShadow`), 'none')
  assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.cover.letter')).backgroundImage`), 'none')
  const capture = async name => {
    win.showInactive()
    await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await new Promise(resolve => setTimeout(resolve, 200))
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  await capture('games')
  await win.webContents.executeJavaScript(`document.querySelectorAll('.game-row')[1].click()`)
  await waitFor(`!!document.querySelector('img.cover.lg')`)
  assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('.detail-backdrop')`), false)
  await capture('detail')
  await win.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[2].click()`)
  await waitFor(`!!document.querySelector('.page h1') && document.querySelector('.page h1').textContent === 'Settings'`)
  await capture('settings')
  await win.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[0].click()`)
  await waitFor(`!!document.querySelector('.hero')`)
  assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.hero'), '::after').backgroundImage`), 'none')
  await capture('overview')
  await win.setSize(860, 640)
  await win.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[1].click()`)
  await waitFor(`document.querySelectorAll('.game-row img').length === 4`)
  await capture('games-compact')
  assert.equal(await win.webContents.executeJavaScript(`document.documentElement.scrollWidth > innerWidth`), false)
  assert.deepEqual(errors, [])
  console.log('PASS: 2s/reduced-motion spinner, flat controls, no gradients or blurred backdrop, artwork metadata/cache, Aion/Battlefield/Forza covers, list/detail/settings/overview, compact layout, no renderer errors; live=' + live)
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
