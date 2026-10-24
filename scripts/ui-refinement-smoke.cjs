// Build first. All scenarios use synthetic data and an isolated project-local profile.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const scale = process.argv.find(a => a.startsWith('--scale='))?.split('=')[1] || '1'
app.commandLine.appendSwitch('force-device-scale-factor', scale)
const output = path.join(root, '.tmp', 'ui-refinement', scale)
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
const preload = path.join(output, 'preload.cjs')
fs.writeFileSync(preload, `
const { contextBridge } = require('electron');
let listener, navigation, startup = 1, historyError = true, historyHeld = false, releaseHistory, settingHeld = false, releaseSetting, settingFailure = false, addFailure = true, addHeld = false, releaseAdd, usageFailure = false, usageHeld = false, usageBytes = 5120;
const calls = { state: 0, settings: [], adds: [], restores: [], connections: [] };
const state = {
 machine: 'Test destination PC', settings: { provider: 'local', localFolder: 'D:/Backups/' + 'Long folder name/'.repeat(8), startAtLogin: false, minimizeToTray: true, notifications: true, autoUpdate: false, retention: { keepLast: 10, keepDaily: 14, keepWeekly: 8 }, extraLibraryFolders: ['D:/Games/' + 'Long folder name/'.repeat(8)] },
 provider: { kind: 'local', connected: true, location: 'D:/Backups/' + 'Long folder name/'.repeat(8) + 'SaveMe', configured: { local: true, gdrive: false, onedrive: false } },
 games: Array.from({ length: 60 }, (_, i) => ({ id: 'game-' + i, name: 'Test Game ' + i + (i === 1 ? ' Very Long Edition Name '.repeat(6) : ''), tracked: true, status: 'synced', roots: [{ template: '<winAppData>/Test', resolved: 'C:/Test/' + 'Long path/'.repeat(5) }], sizeBytes: 1024, fileCount: 1, lastSnapshotId: 'current', lastBackupAt: '2026-10-24T17:00:00Z' })),
 activity: [], scanning: false, running: [], queue: [], saveMeBytes: 2048
};
const snapshots = [
 { id: 'current', createdAt: '2026-10-24T17:00:00Z', machine: 'Test destination PC', trigger: 'manual', zipBytes: 512 },
 { id: 'older', createdAt: '2026-10-23T17:00:00Z', machine: 'Source gaming PC with a long name', trigger: 'game-exit', zipBytes: 480 }
];
const emit = () => listener?.(structuredClone(state));
contextBridge.exposeInMainWorld('saveme', {
 state: async () => { calls.state++; if (startup-- > 0) throw Error('Startup test failure'); return structuredClone(state); },
 updateState: async () => { throw Error('Update status offline'); }, onState: fn => { listener = fn; return () => { listener = undefined }; }, onUpdate: () => () => {}, onNavigate: fn => { navigation = fn; return () => {}; },
 artwork: async () => undefined,
 history: async id => { if (historyHeld) await new Promise(resolve => { releaseHistory = resolve }); if (historyError) throw Error('History offline'); return { gameId: id, snapshots: structuredClone(snapshots) }; },
 updateSettings: async patch => { calls.settings.push(structuredClone(patch)); if (settingHeld) await new Promise(resolve => { releaseSetting = resolve }); if (settingFailure) { settingFailure = false; throw Error('Settings write failed'); } Object.assign(state.settings, patch); emit(); return structuredClone(state.settings); },
 addCustomGame: async (name, folder) => { calls.adds.push({ name, folder }); if (addHeld) await new Promise(resolve => { releaseAdd = resolve }); if (addFailure) { addFailure = false; throw Error('Folder unavailable'); } },
 pickFolder: async () => 'D:/Synthetic saves', openSaveFolder: async () => {}, scan: async () => {}, backupNow: async () => {}, backupAll: async () => {},
 setTracked: async (id, value) => { state.games.find(g => g.id === id).tracked = value; emit(); },
 restore: async (id, version) => { calls.restores.push({ id, version }); }, keepLocal: async () => {},
 connect: async (...args) => { calls.connections.push(args); state.provider.connected = true; state.provider.kind = 'local'; state.settings.provider = 'local'; emit(); }, configureAndConnect: async () => {},
 setRemoteFolder: async folder => { state.provider.location = folder; emit(); }, refreshQuota: async () => {}, disconnect: async () => {}, openUrl: async () => {}, openLicenses: async () => {}, checkForUpdate: async () => {},
 refreshBackupUsage: async () => { if (usageHeld) { state.backupUsage = { status: 'loading', completed: 0, total: 39 }; emit(); await new Promise(() => {}); } state.backupUsage = usageFailure ? { status: 'unavailable' } : { status: 'ready', bytes: usageBytes }; emit(); },
 test: async (action, value) => {
  if (action === 'calls') return structuredClone(calls);
  if (action === 'historyOK') historyError = false;
  if (action === 'holdHistory') { historyHeld = true; historyError = false; }
  if (action === 'releaseHistory') { historyHeld = false; releaseHistory?.(); }
  if (action === 'holdSetting') settingHeld = true;
  if (action === 'releaseSetting') { settingHeld = false; releaseSetting?.(); }
  if (action === 'failSetting') settingFailure = true;
  if (action === 'usageUnavailable') usageFailure = true;
  if (action === 'usageHung') usageHeld = true;
  if (action === 'usageZero') { usageHeld = false; usageFailure = false; usageBytes = 0; }
  if (action === 'holdAdd') addHeld = true;
  if (action === 'releaseAdd') { addHeld = false; releaseAdd?.(); }
  if (action === 'navigate') navigation(value);
  if (action === 'onboarding') { state.provider.connected = false; state.settings.provider = undefined; emit(); }
  if (action === 'empty') { state.games = []; emit(); }
  if (action === 'disconnected') { state.provider.connected = false; emit(); }
 }
});`)

app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true)
  const win = new BrowserWindow({ show: false, width: 1100, height: 780, webPreferences: { preload, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', (_event, ...args) => { const msg = typeof args[0] === 'object' ? args[0].message : args[1]; if (/Uncaught|ReferenceError|TypeError|cannot be a descendant/.test(msg)) errors.push(msg) })
  const js = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { throw Error(`${error.message}\nUI evaluation: ${code}`) } }
  const wait = async code => {
    const end = Date.now() + 6000
    while (Date.now() < end) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 20)) }
    throw Error('Timed out: ' + code + '\n' + await js(`JSON.stringify({ active: document.activeElement?.outerHTML?.slice(0, 250), heading: document.querySelector('h1')?.textContent, dialogs: document.querySelectorAll('[role="dialog"]').length })`))
  }
  const click = async text => { await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`); }
  const fill = async (selector, value) => { await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`); }
  const key = async (keyCode, modifiers = []) => {
    const keys = { Return: ['Enter', 13], Tab: ['Tab', 9], Right: ['ArrowRight', 39], Escape: ['Escape', 27], Space: [' ', 32] }
    const [name, virtual] = keys[keyCode]
    const event = { key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: virtual, modifiers: modifiers.includes('shift') ? 8 : 0 }
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event, ...(name === 'Enter' ? { text: '\r' } : name === ' ' ? { text: ' ' } : {}) })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
    await js('new Promise(resolve => requestAnimationFrame(resolve))')
  }
  const nav = async index => { await js(`document.querySelectorAll('.nav-item')[${index}].click()`); await wait(`!!document.querySelector('.page h1')`); }
  const capture = async name => { await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
  const fit = async label => {
    await js('new Promise(resolve => requestAnimationFrame(resolve))')
    const overflow = await js(`({ viewport: innerWidth, width: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('.page button,.page input,.page h1,.page h2,.page code,.onboarding button,.onboarding input,.modal button,.modal input')].filter(el => el.getClientRects().length && el.getBoundingClientRect().right > innerWidth + 1).map(el => el.className || el.tagName) })`)
    assert.equal(overflow.width <= overflow.viewport, true, label + ': horizontal document overflow')
    assert.deepEqual(overflow.offenders, [], label + ': controls outside viewport')
  }
  await win.loadFile(path.join(root, 'out/renderer/index.html'))
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await wait(`document.querySelector('.boot-error')?.textContent.includes('Startup test failure')`)
  await click('Retry')
  await wait(`!!document.querySelector('.hero')`)
  assert.equal((await js(`window.saveme.test('calls')`)).state, 2)
  await nav(1)
  await wait(`document.querySelectorAll('.game-open').length === 60`)
  assert.equal(await js(`document.querySelector('.segmented').getAttribute('role')`), 'group')
  await fill('input[aria-label="Search games"]', 'Test Game')
  await js(`document.querySelectorAll('.segmented button')[1].click(); document.querySelector('.content').scrollTop = 500; document.querySelector('[data-game="game-8"]').focus();`)
  const beforeScroll = await js(`document.querySelector('.content').scrollTop`)
  await key('Return')
  await wait(`!!document.querySelector('.detail-hero')`)
  await wait(`document.querySelector('.detail-meta').textContent.includes('History unavailable')`)
  assert.equal(await js(`document.querySelector('.detail-meta').textContent.includes('0 versions')`), false)
  await js(`window.saveme.test('historyOK')`)
  await click('Retry')
  await wait(`document.querySelectorAll('.timeline li').length === 2`)
  await click('Restore')
  await wait(`!!document.querySelector('[role="dialog"]')`)
  assert.equal(await js(`document.activeElement.textContent.trim()`), 'Cancel')
  assert.match(await js(`document.querySelector('.restore-facts').textContent`), /Source gaming PC with a long name/)
  assert.match(await js(`document.querySelector('.restore-facts').textContent`), /Test destination PC/)
  await key('Return')
  await wait(`!document.querySelector('[role="dialog"]')`)
  assert.equal((await js(`window.saveme.test('calls')`)).restores.length, 0)
  await click('Games')
  await wait(`!!document.querySelector('.game-open')`)
  assert.equal(await js(`document.activeElement.dataset.game`), 'game-8')
  assert.equal(await js(`document.querySelector('input[aria-label="Search games"]').value`), 'Test Game')
  assert.equal(await js(`document.querySelectorAll('.segmented button')[1].getAttribute('aria-pressed')`), 'true')
  assert.equal(await js(`document.querySelector('.content').scrollTop`), beforeScroll)
  await click('Add game')
  await wait(`!!document.querySelector('.modal input')`)
  await fill('.modal input[placeholder="My Game"]', 'New game')
  await fill('.modal input[placeholder^="C:"]', 'D:/Synthetic saves')
  await js(`document.querySelector('.modal input[placeholder^="C:"]').focus()`)
  await key('Return')
  await wait(`document.querySelector('.modal [role="alert"]')?.textContent.includes('Folder unavailable')`)
  assert.equal(await js(`document.querySelector('.modal input[placeholder="My Game"]').value`), 'New game')
  await js(`window.saveme.test('holdAdd'); document.querySelector('.modal input[placeholder^="C:"]').focus()`)
  await key('Return'); await key('Return')
  assert.equal((await js(`window.saveme.test('calls')`)).adds.length, 2)
  await js(`window.saveme.test('releaseAdd')`)
  await wait(`!document.querySelector('.modal')`)
  await nav(2)
  await js(`document.querySelectorAll('.settings-nav button')[1].click()`)
  await wait(`document.querySelectorAll('.number-field input').length === 1`)
  await wait(`document.querySelector('.backup-usage').textContent.includes('5.0 KB')`)
  const baseline = (await js(`window.saveme.test('calls')`)).settings.length
  await fill('.number-field input', '')
  assert.equal((await js(`window.saveme.test('calls')`)).settings.length, baseline)
  assert.equal(await js(`document.querySelector('.number-field input').value`), '')
  await js(`document.querySelector('.number-field input').focus()`); await key('Tab')
  assert.equal((await js(`window.saveme.test('calls')`)).settings.length, baseline)
  await click('Apply changes')
  await wait(`document.querySelector('.history-form [role="alert"]')?.textContent.includes('2 to 365')`)
  await fill('.number-field input', '366')
  await js(`document.querySelector('.number-field input').focus()`); await key('Return')
  assert.equal((await js(`window.saveme.test('calls')`)).settings.length, baseline)
  await fill('.number-field input', '3')
  await click('Switch to 3 backups per game')
  await wait(`!!document.querySelector('.modal')`)
  assert.equal(await js(`document.activeElement.textContent.trim()`), 'Cancel')
  assert.match(await js(`document.querySelector('.modal').textContent`), /next successful backup/)
  assert.match(await js(`document.querySelector('.modal').textContent`), /Local game saves are unaffected/)
  await click('Cancel')
  await wait(`!document.querySelector('.modal')`)
  assert.equal((await js(`window.saveme.test('calls')`)).settings.length, baseline)
  await click('Switch to 3 backups per game')
  await wait(`!!document.querySelector('.modal')`)
  await click('Keep 3 backups per game')
  await wait(`document.querySelector('.history-form [role="status"]')?.textContent === 'Saved'`)
  assert.deepEqual((await js(`window.saveme.test('calls')`)).settings.at(-1).retention, { keepLast: 3, keepDaily: 0, keepWeekly: 0 })
  await fill('.number-field input', '2')
  await click('Apply changes')
  await wait(`!!document.querySelector('.modal')`)
  await click('Cancel')
  assert.equal((await js(`window.saveme.test('calls')`)).settings.length, baseline + 1)
  await js(`window.saveme.test('failSetting')`)
  await fill('.number-field input', '4')
  await click('Apply changes')
  await wait(`document.querySelector('.history-form [role="alert"]')?.textContent.includes('Settings write failed')`)
  assert.equal(await js(`document.querySelector('.history-settings').textContent.includes('Current limit: 3')`), true)
  await fill('.number-field input', '3')
  await js(`window.saveme.test('usageUnavailable')`)
  await click('Refresh usage')
  await wait(`document.querySelector('.backup-usage').textContent.includes('Storage usage unavailable')`)
  await js(`window.saveme.test('usageZero')`)
  await click('Refresh usage')
  await wait(`document.querySelector('.backup-usage').textContent.includes('0 B')`)
  // Accelerate only the renderer IPC fallback timer, while leaving other app timers intact.
  await js(`window.originalUsageTimer = window.setTimeout; window.setTimeout = (fn, ms, ...args) => window.originalUsageTimer(fn, ms === 25000 ? 100 : ms, ...args); window.saveme.test('usageHung')`)
  await click('Refresh usage')
  await wait(`document.querySelector('.backup-usage').textContent.includes('0 of 39 games')`)
  await wait(`document.querySelector('.backup-usage').textContent.includes('timed out or failed') && !document.querySelector('.backup-usage button').disabled`)
  await js(`window.setTimeout = window.originalUsageTimer; delete window.originalUsageTimer; window.saveme.test('usageZero')`)
  await click('Refresh usage')
  await wait(`document.querySelector('.backup-usage').textContent.includes('0 B')`)
  await js(`document.querySelectorAll('.settings-nav button')[2].click(); window.saveme.test('holdSetting')`)
  await wait(`document.querySelectorAll('.setting .toggle').length === 4`)
  await js(`document.querySelector('.setting .toggle').click(); document.querySelector('.setting .toggle').click()`)
  await wait(`document.querySelector('.setting .toggle').disabled`)
  const duringSave = (await js(`window.saveme.test('calls')`)).settings.length
  await js(`window.saveme.test('releaseSetting')`)
  await wait(`!document.querySelector('.setting .toggle').disabled`)
  assert.equal((await js(`window.saveme.test('calls')`)).settings.length, duringSave)
  await js(`window.saveme.test('failSetting'); document.querySelector('.setting .toggle').click()`)
  await wait(`document.querySelector('.setting [role="alert"]')?.textContent.includes('Settings write failed')`)
  await win.webContents.debugger.sendCommand('Accessibility.enable')
  const tree = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree')
  assert(tree.nodes.some(n => n.role?.value === 'switch' && n.name?.value === 'Start with Windows'))
  for (const [width, height, zoom] of [[1100, 780, 1], [820, 580, 1], [820, 580, 2]]) {
    win.setSize(width, height); win.webContents.setZoomFactor(zoom)
    await nav(0); await fit('Overview ' + width + '/' + zoom)
    if (scale === '1' && zoom === 1) await capture('overview-' + width)
    await nav(1); await fit('Games ' + width + '/' + zoom)
    if (scale === '1' && zoom === 1) await capture('games-' + width)
    await js(`document.querySelector('.game-open').click()`)
    await wait(`!!document.querySelector('.detail-hero')`); await fit('Details ' + width + '/' + zoom)
    if (scale === '1' && width === 1100) await capture('detail-' + zoom)
    await nav(2)
    for (let category = 0; category < 5; category++) {
      await js(`document.querySelectorAll('.settings-nav button')[${category}].click()`)
      await fit('Settings ' + category + ' ' + width + '/' + zoom)
      if (scale === '1' && zoom === 1) await capture('settings-' + category + '-' + width)
      if (category === 0) {
        await click('Change folder'); await wait(`!!document.querySelector('.folder-field input')`)
        const ax = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree')
        assert(ax.nodes.some(n => n.role?.value === 'textbox' && n.name?.value === 'Backup subfolder'))
        await fit('Destination editor ' + width + '/' + zoom)
        await click('Cancel')
      }
    }
  }
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
  await js(`document.querySelectorAll('.settings-nav button')[2].click()`)
  assert.equal(await js(`matchMedia('(forced-colors: active)').matches`), true)
  await fit('High contrast')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
  await js(`window.saveme.test('onboarding')`)
  await wait(`document.querySelectorAll('input[type="radio"]').length === 3`)
  for (const zoom of [1, 2]) {
    win.webContents.setZoomFactor(zoom)
    for (const provider of ['gdrive', 'onedrive', 'local']) {
      await js(`document.querySelector('input[value="${provider}"]').click()`)
      await fit('Onboarding ' + provider + '/' + zoom)
      if (scale === '1' && zoom === 1 && provider === 'gdrive') await capture('onboarding')
    }
  }
  win.webContents.setZoomFactor(1)
  await js(`document.querySelector('input[value="gdrive"]').focus()`); await key('Right')
  await wait(`document.querySelector('input[value="onedrive"]').checked`)
  await js(`document.querySelector('input[value="local"]').click()`)
  await wait(`!!document.querySelector('div:not([hidden]) > .setup')`)
  await click('Use this folder')
  await wait(`!!document.querySelector('.shell')`)
  assert.equal((await js(`window.saveme.test('calls')`)).connections.length, 1)
  await js(`window.saveme.test('empty')`); await nav(1)
  await fill('input[aria-label="Search games"]', '')
  await js(`document.querySelector('.segmented button').click()`)
  await wait(`document.body.textContent.includes('No games found yet')`)
  await js(`window.saveme.test('disconnected')`); await nav(0)
  await wait(`document.querySelector('.hero h1').textContent === 'Backups are paused'`)
  assert.deepEqual(errors, [])
  console.log('PASS: usage timeout/progress/retry, startup retry, keyboard library navigation and view restoration, truthful history, safe restore dialog, forms and duplicate prevention, retention drafts/bounds, settings feedback, accessibility tree, all screens at 1100/820 and 200% zoom, emulated high contrast/reduced motion, provider radios; scale=' + scale)
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
