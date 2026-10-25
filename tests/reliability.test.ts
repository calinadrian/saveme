import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import yazl from 'yazl'
import { BackupEngine } from '../src/main/backup/engine'
import { History, SnapshotRecord } from '../src/main/backup/history'
import { capture, inspectArchive, zipFiles, freeSpace } from '../src/main/backup/streaming'
import { LocalFolderProvider } from '../src/main/cloud/local'
import { Db } from '../src/main/store/db'
import { Portable } from '../src/main/detect/paths'
import { fakeFolders } from './helpers'
import { Game, AppState } from '../src/shared/types'
import { diagnostics, saveDiagnostics } from '../src/main/diagnostics'
import { unzipSync, zipSync } from 'fflate'

const roots: string[] = [], engines: BackupEngine[] = [], dbs: Db[] = []
function tmp() { const root = fs.mkdtempSync(path.join(os.tmpdir(),'saveme-v2-')); roots.push(root); return root }
function pc(cloud = tmp()) {
  const root = tmp(), folders = fakeFolders(root), db = new Db(path.join(root,'state.json'))
  const save = path.join(folders.winAppData,'Game','slot.sav')
  const game: Game = { id: 'game', name: 'Game', roots: [{ template: '<winAppData>/Game', resolved: path.dirname(save).replace(/\\/g,'/') }], tracked: true, status: 'never', fileCount: 0, sizeBytes: 0 }
  db.data.games.game = game
  const provider = new LocalFolderProvider(cloud), progress: string[] = []
  const engine = new BackupEngine({ db, folders, provider: () => provider, isRunning: () => false, notify: () => {}, changed: () => { const stage = engine.operation?.progress?.stage; if (stage) progress.push(stage) } })
  engines.push(engine); dbs.push(db)
  const write = (text: string, file = save) => { fs.mkdirSync(path.dirname(file),{ recursive: true }); fs.writeFileSync(file,text) }
  return { root, folders, db, save, game, provider, engine, write, progress, history: new History(provider,db.data.machineId) }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const engine of engines.splice(0)) { engine.stop(); await engine.drain() }
  for (const db of dbs.splice(0)) db.flush()
  for (const root of roots.splice(0)) fs.rmSync(root,{ recursive: true,force: true })
})

describe('independent snapshot commits', () => {
  it('retains both simultaneous first backups and their unresolved heads', async () => {
    const cloud = tmp(), a = pc(cloud), b = pc(cloud)
    a.write('progress A'); b.write('progress B')
    const pa = a.provider.putFile.bind(a.provider), pb = b.provider.putFile.bind(b.provider)
    let ready = 0, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const wait = async () => { if (++ready === 2) release(); await gate }
    vi.spyOn(a.provider,'putFile').mockImplementation(async (...args) => { await wait(); return pa(...args) })
    vi.spyOn(b.provider,'putFile').mockImplementation(async (...args) => { await wait(); return pb(...args) })
    const versions = await Promise.all([a.engine.backup(a.game,'manual'),b.engine.backup(b.game,'manual')])
    expect(versions.every(Boolean)).toBe(true)
    const index = (await a.engine.index('game'))!
    expect(index.snapshots).toHaveLength(2); expect(index.heads).toHaveLength(2)
    a.db.data.settings.retention.keepLast = 1
    await a.engine.checkRemote()
    expect((await a.engine.index('game'))!.snapshots).toHaveLength(2)
    expect(a.game.status).toBe('cloud-newer')
    expect(await a.provider.get('catalog.json')).toBeUndefined()
    expect(await a.provider.get('game/index.json')).toBeUndefined()
  })

  it('keeps different games discoverable after simultaneous commits', async () => {
    const cloud = tmp(), a = pc(cloud), b = pc(cloud)
    delete b.db.data.games.game; b.game.id = 'another'; b.game.name = 'Another'; b.db.data.games.another = b.game
    a.write('one'); b.write('two')
    await Promise.all([a.engine.backup(a.game,'manual'),b.engine.backup(b.game,'manual')])
    const c = pc(cloud); delete c.db.data.games.game
    await c.engine.checkRemote()
    expect(Object.keys(c.db.data.games).sort()).toEqual(['another','game'])
  })

  it('waits for a deliberate conflict choice instead of uploading divergent local saves', async () => {
    const cloud = tmp(), a = pc(cloud), b = pc(cloud)
    a.write('shared'); const first = (await a.engine.backup(a.game,'manual'))!
    await b.engine.restore('game',first.id)
    // Do not auto-merge a restored baseline that has since changed remotely.
    b.game.resolvedHeads = undefined
    a.write('A progressed'); await a.engine.backup(a.game,'manual')
    b.write('B progressed')
    expect(await b.engine.backup(b.game,'manual')).toBeUndefined()
    expect(b.game.status).toBe('cloud-newer')
    await b.engine.keepLocal('game'); await b.engine.drain()
    const history = (await b.engine.index('game'))!
    expect(history.heads).toHaveLength(1)
    expect(history.snapshots.at(-1)!.files).not.toEqual(first.files)
  })

  it('imports legacy history idempotently and never rewrites its index', async () => {
    const p = pc(); p.write('old')
    const state = await capture([p.save],new Portable(p.folders),path.join(p.root,'staging'))
    const zip = path.join(p.root,'legacy.zip'); await zipFiles(state,{},zip)
    const snap = { id: 'legacy',gameId: 'game',createdAt: '2026-01-01T00:00:00Z',machine: 'Old PC',machineId: 'old',trigger: 'manual' as const,sizeBytes: 3,zipBytes: fs.statSync(zip).size,files: state.hashes }
    await p.provider.putFile('game/legacy.zip',zip)
    const index = Buffer.from(JSON.stringify({ gameId: 'game',name: 'Game',snapshots: [snap] }))
    await p.provider.put('game/index.json',index)
    await Promise.all([p.engine.index('game'),p.engine.index('game')])
    expect((await p.provider.list('game/_v2'))).toHaveLength(1)
    expect(await p.provider.get('game/index.json')).toEqual(index)
    expect((await p.engine.verifySnapshot('game','legacy')).status).toBe('verified')
  })

  it('defers cleanup when a committed archive has not arrived through folder sync', async () => {
    const p = pc(); p.db.data.settings.retention.keepLast = 1; p.write('one')
    const old = (await p.engine.backup(p.game,'manual'))!
    const original = await p.history.load('game'), record = original.records.get(old.id)!
    const missing: SnapshotRecord = { ...record,id: 'missing',clock: 2,snapshot: { ...record.snapshot,id: 'missing' },archive: 'game/missing.zip',parents: [old.id] }
    await p.history.commit('game',missing)
    await p.engine.checkRemote()
    expect((await p.engine.index('game'))!.incomplete).toBe(true)
    expect(await p.provider.get(record.archive)).toBeDefined()
  })
})

describe('version annotations and pins', () => {
  it('keeps pinned copies through retention and releases them after unpinning', async () => {
    const p = pc(); p.db.data.settings.retention.keepLast = 1; p.write('old')
    const old = (await p.engine.backup(p.game,'manual'))!
    await p.engine.renameSnapshot('game',old.id,'Before boss')
    await p.engine.pinSnapshot('game',old.id)
    p.write('new'); await p.engine.backup(p.game,'manual')
    let index = (await p.engine.index('game'))!
    expect(index.snapshots.find(s => s.id === old.id)).toMatchObject({ label: 'Before boss',pinned: true })
    expect((await p.engine.verifySnapshot('game',old.id)).status).toBe('verified')
    await p.engine.unpinSnapshot('game',old.id)
    index = (await p.engine.index('game'))!
    expect(index.snapshots.some(s => s.id === old.id)).toBe(false)
    expect((await p.provider.list('game')).filter(e => e.name.endsWith('.pin.zip'))).toEqual([])
  })

  it('preserves a concurrent pin that an unpin has not observed', async () => {
    const p = pc(); p.write('old'); const s = (await p.engine.backup(p.game,'manual'))!
    await p.engine.pinSnapshot('game',s.id)
    const before = await p.history.load('game'), original = before.pins.get(s.id)![0]
    const twin = { ...original,id: crypto.randomUUID(),clock: original.clock + 1 }
    await p.history.event(before,s.id,'unpin',{ observed: [original.id] })
    await p.history.commit('game',twin)
    expect((await p.engine.index('game'))!.snapshots[0].pinned).toBe(true)
  })

  it('finishes pinning safely even if the original is pruned after download', async () => {
    const p = pc(); p.write('old'); const s = (await p.engine.backup(p.game,'manual'))!
    const get = p.provider.getFile.bind(p.provider)
    vi.spyOn(p.provider,'getFile').mockImplementationOnce(async (...args) => {
      const found = await get(...args), view = await p.history.load('game')
      await p.history.event(view,s.id,'prune'); await p.provider.remove(view.records.get(s.id)!.archive)
      return found
    })
    await p.engine.pinSnapshot('game',s.id)
    expect((await p.engine.verifySnapshot('game',s.id)).status).toBe('verified')
  })

  it('does not claim a pin when its protected upload fails', async () => {
    const p = pc(); p.write('old'); const s = (await p.engine.backup(p.game,'manual'))!
    vi.spyOn(p.provider,'putFile').mockRejectedValueOnce(new TypeError('offline'))
    await expect(p.engine.pinSnapshot('game',s.id)).rejects.toThrow('offline')
    expect((await p.engine.index('game'))!.snapshots[0].pinned).toBe(false)
  })

  it('uses a deterministic name when two PCs rename from the same logical clock', async () => {
    const p = pc(); p.write('old'); const s = (await p.engine.backup(p.game,'manual'))!
    const view = await p.history.load('game'), other = new History(p.provider,'zzzz')
    await Promise.all([p.history.event(view,s.id,'rename',{ label: 'First' }),other.event(view,s.id,'rename',{ label: 'Second' })])
    expect((await p.engine.index('game'))!.snapshots[0].label).toBe('Second')
    await expect(p.engine.renameSnapshot('game',s.id,'x'.repeat(101))).rejects.toThrow('100')
  })
})

describe('verification and restore previews', () => {
  it('rejects source changes during streamed capture and preserves the staged bytes afterwards', async () => {
    const p = pc(); p.write('original bytes')
    const read = fs.createReadStream.bind(fs)
    vi.spyOn(fs,'createReadStream').mockImplementationOnce((...args) => { const stream = read(...args); stream.once('data',() => p.write('changed during capture with different size')); return stream })
    await expect(p.engine.backup(p.game,'manual')).rejects.toThrow('changing')
    expect(await p.engine.index('game')).toBeUndefined()
    vi.restoreAllMocks(); p.write('staged original')
    const state = await capture([p.save],new Portable(p.folders),path.join(p.root,'exact'))
    p.write('changed after capture')
    const zip = path.join(p.root,'exact.zip'); await zipFiles(state,{},zip)
    const files = await inspectArchive(zip,{ files: state.hashes,sizeBytes: state.sizeBytes },path.join(p.root,'exact-verified'))
    expect(fs.readFileSync(files[0].staged,'utf8')).toBe('staged original')
  })

  it.each(['bad-hash','missing','unsafe-path','incorrect-size'])('rejects %s in the streaming archive validator', async fault => {
    const root = tmp(), file = path.join(root,'bad.zip'), data = Buffer.from('save')
    fs.writeFileSync(file,Buffer.from(zipSync(fault === 'missing' ? {} : { [fault === 'unsafe-path' ? 'winAppData/../escape.sav' : 'winAppData/Game/a.sav']: data })))
    const files = { '<winAppData>/Game/a.sav': fault === 'bad-hash' ? '0'.repeat(64) : crypto.createHash('sha256').update(data).digest('hex') }
    await expect(inspectArchive(file,{ files,sizeBytes: fault === 'incorrect-size' ? 1 : 4 },path.join(root,'output'))).rejects.toThrow()
  })

  it('distinguishes verified, corrupt and unavailable without changing local files', async () => {
    const p = pc(); p.write('original'); const s = (await p.engine.backup(p.game,'manual'))!
    p.write('current')
    expect((await p.engine.verifySnapshot('game',s.id)).status).toBe('verified')
    expect(fs.readFileSync(p.save,'utf8')).toBe('current')
    await p.provider.put('game/' + s.id + '.zip',Buffer.from('broken'))
    expect((await p.engine.verifySnapshot('game',s.id)).status).toBe('corrupt')
    await p.provider.remove('game/' + s.id + '.zip')
    expect((await p.engine.verifySnapshot('game',s.id)).status).toBe('unavailable')
    expect(fs.readFileSync(p.save,'utf8')).toBe('current')
  })

  it('compares changes, refuses stale confirmation, and keeps extra files', async () => {
    const p = pc(); p.write('old'); p.write('same',path.join(path.dirname(p.save),'same.sav'))
    const s = (await p.engine.backup(p.game,'manual'))!
    p.write('current'); p.write('keep',path.join(path.dirname(p.save),'extra.sav'))
    const preview = await p.engine.previewRestore('game',s.id)
    expect(preview.replaced).toHaveLength(1); expect(preview.unchanged).toHaveLength(1); expect(preview.extra).toHaveLength(1)
    p.write('changed again')
    await expect(p.engine.restore('game',s.id,preview.token)).rejects.toThrow('Local files changed')
    const current = await p.engine.previewRestore('game',s.id)
    await p.engine.restore('game',s.id,current.token)
    expect(fs.readFileSync(p.save,'utf8')).toBe('old')
    expect(fs.readFileSync(path.join(path.dirname(p.save),'extra.sav'),'utf8')).toBe('keep')
    expect(p.progress).toEqual(expect.arrayContaining(['reading','compressing','uploading','downloading','verifying','restoring']))
  })

  it('isolates verification results by backup destination', async () => {
    const p = pc(); p.write('old'); const s = (await p.engine.backup(p.game,'manual'))!
    await p.engine.verifySnapshot('game',s.id)
    expect((await p.engine.index('game'))!.snapshots[0].verification?.status).toBe('verified')
    p.db.data.settings.remoteFolder = { local: 'other' }
    expect((await p.engine.index('game'))!.snapshots[0].verification).toBeUndefined()
  })

  it('reads a ZIP64 archive and rejects duplicate entry names', async () => {
    const root = tmp(), file = path.join(root,'zip64.zip'), bytes = Buffer.from('save')
    const zip = new yazl.ZipFile(); zip.addBuffer(bytes,'winAppData/Game/a.sav')
    const done = new Promise<void>((resolve,reject) => zip.outputStream.pipe(fs.createWriteStream(file)).on('close',resolve).on('error',reject))
    zip.end({ forceZip64Format: true, comment: '' }); await done
    const meta = { sizeBytes: bytes.length,files: { '<winAppData>/Game/a.sav': crypto.createHash('sha256').update(bytes).digest('hex') } }
    expect(await inspectArchive(file,meta,path.join(root,'ok'))).toHaveLength(1)
    const duplicate = path.join(root,'duplicate.zip'), bad = new yazl.ZipFile()
    bad.addBuffer(bytes,'winAppData/Game/a.sav'); bad.addBuffer(bytes,'winAppData/Game/a.sav')
    const written = new Promise<void>((resolve,reject) => bad.outputStream.pipe(fs.createWriteStream(duplicate)).on('close',resolve).on('error',reject)); bad.end(); await written
    await expect(inspectArchive(duplicate,meta,path.join(root,'bad'))).rejects.toThrow('Duplicate')
  })

  it('reports insufficient temporary space before capture', async () => {
    const root = tmp()
    vi.spyOn(fs.promises,'statfs').mockResolvedValue({ bavail: 0,bsize: 4096 } as fs.StatsFs)
    await expect(freeSpace(root,1)).rejects.toThrow('Not enough temporary disk space')
  })
})

it('exports only allowlisted diagnostics, excluding planted credentials and personal details', async () => {
  const secret = 'PLANTED-SECRET-token', personal = 'C:/Users/private-user/save.sav'
  const state = { machine: secret,provider: { kind: 'local',connected: true,account: secret,location: personal },settings: { tokens: secret },games: [{ name: secret,roots: [{ resolved: personal }],tracked: true,status: 'error' }],queue: [secret],recoveryWarning: secret,activity: [{ at: new Date().toISOString(),kind: 'error',gameId: secret,message: 'Permission denied ' + personal + ' bearer ' + secret }] } as unknown as AppState
  const report = diagnostics(state,{ saveme: 'test',node: process.versions.node,credentials: secret })
  const serialized = JSON.stringify(report)
  expect(serialized).not.toContain(secret); expect(serialized).not.toContain(personal)
  expect(report.recentEvents[0].code).toBe('access-or-authentication')
  const root = tmp(), file = path.join(root,'report.zip'); await saveDiagnostics(file,report)
  const entries = unzipSync(fs.readFileSync(file))
  expect(Object.keys(entries).sort()).toEqual(['report.json','report.txt'])
  expect(Buffer.from(entries['report.txt']).toString()).not.toContain(secret)
})
