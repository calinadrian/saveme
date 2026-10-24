// npm run build && node_modules/.bin/electron scripts/safety-ui-smoke.cjs
// Synthetic state only; never opens the user's profile or cloud accounts.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const output = path.join(root, '.tmp', 'safety-ui-smoke')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
const preload = path.join(output, 'preload.cjs')
fs.writeFileSync(preload, `
const { contextBridge } = require('electron');
let listener, historyCalls = 0;
const state = {
 machine: 'Test PC', settings: { provider: 'local', startAtLogin: false, minimizeToTray: true, notifications: false, autoUpdate: false, retention: { keepLast: 10, keepDaily: 14, keepWeekly: 8 }, extraLibraryFolders: [] },
 provider: { kind: 'local', connected: true, location: 'D:\\\\Backups', configured: { local: true } },
 games: [{ id: 'game', name: 'Test Game', tracked: true, status: 'never', roots: [{ template: '<winAppData>/Test', resolved: 'C:/Test' }], sizeBytes: 0, fileCount: 0 }], activity: [], scanning: false, running: [], queue: [], saveMeBytes: 0
};
contextBridge.exposeInMainWorld('saveme', {
 state: async () => state, updateState: async () => ({ status: 'dev', current: 'test' }),
 artwork: async () => undefined, onState: fn => { listener = fn; return () => {}; }, onUpdate: () => () => {}, onNavigate: () => () => {},
 history: async () => { if (++historyCalls === 1) throw Error('Offline test'); return { gameId: 'game', snapshots: [] }; },
 setScenario: async kind => {
   state.queue = kind === 'waiting' ? ['game'] : [];
   state.games[0].status = kind === 'waiting' ? 'pending' : 'never';
   state.games[0].error = kind === 'waiting' ? 'Storage unavailable, will retry' : undefined;
   state.operation = kind === 'uploading' ? { kind: 'backup', gameId: 'game' } : undefined;
   listener?.(structuredClone(state));
 }
});`)

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 780, webPreferences: { preload, sandbox: true, contextIsolation: true } })
  const errors = []
  win.webContents.on('console-message', (_event, ...args) => {
    const msg = typeof args[0] === 'object' ? args[0].message : args[1]
    if (/Uncaught|ReferenceError|TypeError/.test(msg)) errors.push(msg)
  })
  const js = code => win.webContents.executeJavaScript(code)
  const wait = async code => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 30)) }
    throw Error('Timed out: ' + code)
  }
  const capture = async name => {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  await win.loadFile(path.join(root, 'out/renderer/index.html'))
  await wait(`document.querySelector('.hero h1')?.textContent.includes('no confirmed')`)
  assert.match(await js(`document.querySelector('.sync').getAttribute('aria-label')`), /no confirmed/)
  await capture('overview')
  await js(`window.saveme.setScenario('waiting')`)
  await wait(`document.querySelector('.hero h1')?.textContent === '1 backup waiting'`)
  assert.equal(await js(`!!document.querySelector('.hero-icon .spinner')`), false)
  await js(`window.saveme.setScenario('uploading')`)
  await wait(`document.querySelector('.hero h1')?.textContent.includes('Backing up Test Game')`)
  await js(`window.saveme.setScenario('idle'); document.querySelectorAll('.nav-item')[1].click()`)
  await wait(`!!document.querySelector('.game-row')`)
  await js(`document.querySelector('.game-open').click()`)
  await wait(`document.querySelector('[role="alert"]')?.textContent.includes('Could not load version history')`)
  assert.equal(await js(`document.body.textContent.includes('No backups yet')`), false)
  await capture('history-error')
  await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Retry').click()`)
  await wait(`document.body.textContent.includes('No backups yet') && !document.querySelector('[role="alert"]')`)
  await js(`document.querySelectorAll('.nav-item')[1].click()`)
  await wait(`!![...document.querySelectorAll('button')].find(b => b.textContent.includes('Add game'))`)
  await js(`const add = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Add game')); add.focus(); add.click();`)
  await wait(`!!document.querySelector('[role="dialog"]')`)
  assert.equal(await js(`document.querySelector('[role="dialog"]').contains(document.activeElement)`), true)
  assert.equal(await js(`document.querySelector('#root').inert`), true)
  await js(`const items = [...document.querySelector('[role="dialog"]').querySelectorAll('button:not(:disabled),input:not(:disabled)')]; items.at(-1).focus();`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await wait(`document.activeElement === document.querySelector('.modal-close')`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] })
  await wait(`document.activeElement.textContent.trim() === 'Cancel'`)
  await capture('dialog')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(`!document.querySelector('[role="dialog"]')`)
  assert.match(await js(`document.activeElement.textContent`), /Add game/)
  assert.equal(await js(`document.querySelector('#root').inert`), false)
  for (const width of [1100, 820]) {
    win.setSize(width, width === 820 ? 580 : 780)
    await js(`document.querySelectorAll('.nav-item')[0].click()`)
    await wait(`!!document.querySelector('.hero')`)
    assert.equal(await js(`document.documentElement.scrollWidth > innerWidth`), false)
    await capture('overview-' + width)
  }
  assert.deepEqual(errors, [])
  console.log('PASS: truthful never/waiting/uploading status, history error and retry, keyboard focus containment/restoration, Escape, compact layout, no renderer errors')
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
