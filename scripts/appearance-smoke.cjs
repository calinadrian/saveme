// Run after npm run build. Synthetic data, real preload/controller, isolated profile.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const { buildSync } = require('esbuild')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const output = path.join(root, '.tmp', 'appearance-smoke')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
app.on('window-all-closed', () => {})
for (const [name, entry] of Object.entries({ appearance: 'src/main/appearance.ts', db: 'src/main/store/db.ts', validation: 'src/shared/appearance.ts' })) {
  buildSync({ entryPoints: [path.join(root, entry)], outfile: path.join(output, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
}
const { createAppearance } = require(path.join(output, 'appearance.cjs'))
const { Db } = require(path.join(output, 'db.cjs'))
const { validateAppearance, WINDOW_COLORS } = require(path.join(output, 'validation.cjs'))

// Runs in Chromium: alpha-composite all ancestor surfaces before comparing text.
function contrastAudit() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v) }
  const over = (top, bottom) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1)
  const background = el => { const chain = []; for (let p = el; p; p = p.parentElement) chain.unshift(p); return chain.reduce((bg, p) => over(rgba(getComputedStyle(p).backgroundColor), bg), [255,255,255,1]) }
  const luminance = rgb => rgb.slice(0,3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((v, c, i) => v + c * [.2126,.7152,.0722][i], 0)
  const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05) }
  const failures = []
  for (const el of document.querySelectorAll('body *')) {
    if (!el.getClientRects().length || el.closest('svg,[disabled],.sr-only') || getComputedStyle(el).visibility === 'hidden') continue
    const style = getComputedStyle(el), bg = background(el)
    if (el.matches('.btn:not(.ghost),input,select,.toggle') && parseFloat(style.borderLeftWidth) > 0) {
      const outer = background(el.parentElement)
      const value = ratio(over(rgba(style.borderLeftColor), outer), outer)
      if (value < 3) failures.push({ control: el.className || el.tagName, boundaryRatio: +value.toFixed(2) })
    }
    if (el.matches(':focus-visible') && style.outlineStyle !== 'none') {
      const outer = background(el.parentElement), value = ratio(over(rgba(style.outlineColor), outer), outer)
      if (value < 3) failures.push({ focus: el.className, ratio: +value.toFixed(2) })
    }
    const hasText = [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
    if (!hasText && !el.matches('input,select')) continue
    const check = (color, label) => { const value = ratio(over(rgba(color), bg), bg); if (value < 4.5) failures.push({ text: label.slice(0,80), class: el.className, color, bg, ratio: +value.toFixed(2) }) }
    check(style.color, el.textContent || el.getAttribute('aria-label') || el.tagName)
    if (el.matches('input[placeholder]')) check(getComputedStyle(el, '::placeholder').color, 'placeholder: ' + el.placeholder)
  }
  return failures
}

app.whenReady().then(async () => {
  const dbPath = path.join(output, 'preferences.json')
  const db = new Db(dbPath)
  db.data.settings.appearance = 'dark'; db.flush()
  const state = {
    machine: 'Theme test PC', settings: db.data.settings, provider: { kind: 'local', connected: true, location: 'D:/Synthetic backups', configured: { local: true } },
    games: ['synced','pending','backing-up','cloud-newer','error','never'].map((status, i) => ({ id: 'game-'+i, name: 'Example game '+i, status, tracked: true, roots: [{ template: '<winAppData>/Example', resolved: 'C:/Example' }], sizeBytes: 1024, fileCount: 1, lastSnapshotId: status === 'synced' ? 'backup' : undefined })),
    activity: [{ kind: 'error', message: 'Example backup failed. Try again.', at: new Date().toISOString() }], scanning: false, running: [], queue: [], saveMeBytes: 1024
  }
  let win, failWrite = false
  const controller = createAppearance(() => db.data.settings.appearance, () => win)
  const emit = () => win.webContents.send('state', state)
  for (const ch of ['state','updateState','artwork','history','updateSettings','backupNow','scan','refreshQuota','refreshBackupUsage','previewRestore']) ipcMain.handle(ch, (_event, value) => {
    if (ch === 'state') return { ok: true, value: state }
    if (ch === 'updateState') return { ok: true, value: { status: 'dev', current: '0.1.6' } }
    if (ch === 'history') return { ok: true, value: { gameId: value, snapshots: [{ id: 'older', createdAt: new Date().toISOString(), machine: 'Theme test PC', trigger: 'manual', zipBytes: 1024 }] } }
    if (ch === 'previewRestore') return { ok: true, value: { token: 'a'.repeat(64), added: [], replaced: ['<winAppData>/Example/slot.sav'], unchanged: [], extra: ['<winAppData>/Example/keep.sav'] } }
    if (ch === 'updateSettings') {
      validateAppearance(value.appearance)
      if (failWrite) { failWrite = false; return { ok: false, error: 'Test disk unavailable. Try again.' } }
      Object.assign(db.data.settings, value); db.flush(); controller.apply(); emit()
      return { ok: true, value: db.data.settings }
    }
    return { ok: true, value: undefined }
  })
  const open = async () => {
    const colors = WINDOW_COLORS[controller.current()]
    win = new BrowserWindow({ show: false, width: 1100, height: 780, backgroundColor: colors.color, titleBarStyle: 'hidden', titleBarOverlay: colors, webPreferences: { preload: path.join(root, 'out/preload/index.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    await win.loadFile(path.join(root, 'out/renderer/index.html'))
    // Hidden windows can suspend compositor transitions; measure settled states.
    await win.webContents.insertCSS('* { transition: none !important; animation: none !important; }')
  }
  const js = async code => { try { return await win.webContents.executeJavaScript(code) } catch(error) { throw Error(error.message + '\n' + code) } }
  const wait = async code => { const end = Date.now()+6000; while (Date.now()<end) { if (await js(code)) return; await new Promise(r => setTimeout(r,25)) } throw Error('Timed out: '+code) }
  const click = text => js(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(text)} || b.textContent.trim() === ${JSON.stringify(text)}).click()`)
  const select = value => js(`(()=>{const el=document.querySelector('select[aria-label="Appearance"]');const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const audit = async name => {
    await new Promise(resolve => setTimeout(resolve, 180))
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    const failures = await js('('+contrastAudit.toString()+')()')
    assert.deepEqual(failures, [], name+' text contrast')
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, name+' overflow')
    fs.writeFileSync(path.join(output, name+'.png'), (await win.webContents.capturePage()).toPNG())
  }
  const appearance = async () => { await click('Settings'); await click('General') }
  await open(); await wait(`!!document.querySelector('.shell')`)
  await appearance(); failWrite = true; await select('light')
  await wait(`document.body.textContent.includes('Test disk unavailable')`)
  assert.equal(await js('document.documentElement.dataset.theme'), 'dark')
  const report = []
  for (const theme of ['light','dark']) {
    await appearance(); await select(theme); await wait(`document.documentElement.dataset.theme === '${theme}'`)
    assert.equal(win.getBackgroundColor().slice(0,7).toLowerCase(), WINDOW_COLORS[theme].color)
    assert.equal(new Db(dbPath).data.settings.appearance, theme)
    await js(`(() => { const panel = document.createElement('section'); panel.id = 'theme-controls'; panel.className = 'card'; panel.innerHTML = '<button class="btn primary">Primary action</button><button class="btn danger">Delete</button><button class="btn danger-ghost">Disconnect</button><div class="alert info">Information</div><div class="alert warn">Check storage</div><div class="alert err">Could not save. Try again.</div>'; document.querySelector('.page').append(panel) })()`)
    assert.deepEqual(await js('('+contrastAudit.toString()+')()'), [], theme+' feedback and control text')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('DOM.enable')
    await win.webContents.debugger.sendCommand('CSS.enable')
    const { root: documentNode } = await win.webContents.debugger.sendCommand('DOM.getDocument')
    for (const button of ['.primary','.danger','.danger-ghost']) {
      const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '#theme-controls '+button })
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
      assert.deepEqual(await js('('+contrastAudit.toString()+')()'), [], theme+' '+button+' hover contrast')
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
    }
    win.webContents.debugger.detach()
    await js(`document.querySelector('#theme-controls').remove(); document.querySelector('select').focus()`)
    for (const width of [1100,820]) {
      win.setSize(width,780)
      await audit(theme+'-'+width+'-general')
      for (const category of ['Storage','Version history','Game folders','About SaveMe']) { await click(category); await audit(theme+'-'+width+'-'+category.replaceAll(' ','-')) }
      await click('Games'); await audit(theme+'-'+width+'-games')
      await js(`document.querySelector('.game-open').click()`); await wait(`document.body.textContent.includes('Version history')`); await audit(theme+'-'+width+'-detail')
      await js(`document.querySelector('.timeline button').click()`); await wait(`!!document.querySelector('[role="dialog"]')`); await audit(theme+'-'+width+'-dialog'); await click('Cancel')
      await click('Overview'); await audit(theme+'-'+width+'-overview')
      await appearance()
    }
    win.webContents.setZoomFactor(2); await audit(theme+'-zoom'); win.webContents.setZoomFactor(1)
    await win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
    assert.equal(await js(`matchMedia('(forced-colors: active)').matches`), true)
    await js('new Promise(r => requestAnimationFrame(r))')
    fs.writeFileSync(path.join(output, theme+'-forced-colors.png'), (await win.webContents.capturePage()).toPNG())
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    win.webContents.debugger.detach()
    state.provider.connected = false; delete state.settings.provider; emit(); await wait(`!!document.querySelector('.onboarding')`); await audit(theme+'-onboarding')
    state.provider.connected = true; state.settings.provider = 'local'; emit(); await wait(`!!document.querySelector('.shell')`)
    report.push(theme+' passes text contrast, screens, dialog, persistence, native background, zoom and forced colors')
  }
  await appearance(); await select('system'); await wait(`document.querySelector('select').value === 'system'`)
  for (const system of ['light','dark']) {
    nativeTheme.themeSource = system
    await wait(`document.documentElement.dataset.theme === '${system}'`)
    assert.equal(win.getBackgroundColor().slice(0,7).toLowerCase(), WINDOW_COLORS[system].color)
  }
  await select('light'); await wait(`document.documentElement.dataset.theme === 'light'`)
  nativeTheme.themeSource = 'dark'
  await new Promise(r => setTimeout(r,100))
  assert.equal(await js('document.documentElement.dataset.theme'), 'light')
  win.destroy(); await open(); await wait(`!!document.querySelector('.shell')`)
  assert.equal(await js('document.documentElement.dataset.theme'), 'light')
  assert.equal(await js('window.saveme.initialTheme'), 'light')
  report.push('System follows native changes; explicit modes ignore them; recreated window bootstraps persisted light mode; failed save retains dark')
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report,null,2))
  console.log(report.join('\n')); app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })

