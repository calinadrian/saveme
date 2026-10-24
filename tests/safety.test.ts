import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { BackupEngine } from '../src/main/backup/engine'
import { buildZip, localState, prepareRestore } from '../src/main/backup/snapshot'
import { applyRestore, recoverRestores } from '../src/main/backup/restore'
import { measureBackupUsage, USAGE_TIMEOUT_MS } from '../src/main/backup/usage'
import { LocalFolderProvider } from '../src/main/cloud/local'
import { Portable } from '../src/main/detect/paths'
import { Db } from '../src/main/store/db'
import { Game } from '../src/shared/types'
import { fakeFolders } from './helpers'

const roots: string[] = []
const cleanup: (() => void)[] = []
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-safety-')); roots.push(dir); return dir }
function pc() {
  const root = tmp()
  const folders = fakeFolders(root)
  const db = new Db(path.join(root, 'state.json'))
  const save = path.join(folders.winAppData, 'Game', 'slot.sav')
  const game: Game = { id: 'game', name: 'Game', tracked: true, status: 'never', roots: [{ template: '', resolved: path.dirname(save).replace(/\\/g, '/') }], fileCount: 0, sizeBytes: 0 }
  const provider = new LocalFolderProvider(path.join(root, 'cloud'))
  const running = { value: false }
  const engine = new BackupEngine({ db, folders, provider: () => provider, isRunning: () => running.value, notify: vi.fn(), changed: () => {} })
  db.data.games.game = game
  const write = (s: string) => { fs.mkdirSync(path.dirname(save), { recursive: true }); fs.writeFileSync(save, s) }
  const result = { root, folders, db, save, game, provider, engine, running, write }
  cleanup.push(() => { engine.stop(); db.flush() })
  return result
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  cleanup.splice(0).forEach(close => close())
  roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})

describe('snapshot integrity', () => {
  it('archives the exact staged bytes even if the source changes before compression', async () => {
    const p = pc(); p.write('original')
    const state = await localState([p.save], new Portable(p.folders))
    p.write('changed later')
    const entries = unzipSync(await buildZip(state, {}))
    const data = entries['winAppData/Game/slot.sav']
    expect(Buffer.from(data).toString()).toBe('original')
    expect(crypto.createHash('sha256').update(data).digest('hex')).toBe(Object.values(state.hashes)[0])
  })

  it('rejects an incomplete capture rather than skipping a missing or unreadable file', async () => {
    const p = pc(); p.write('original')
    await expect(localState([p.save, p.save + '.missing'], new Portable(p.folders))).rejects.toThrow()
    const read = vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EACCES' }))
    await expect(p.engine.backup(p.game, 'manual')).rejects.toThrow('locked')
    expect(read).toHaveBeenCalled()
    expect(p.game.lastSnapshotId).toBeUndefined()
    expect(await p.engine.index('game')).toBeUndefined()
  })

  it('rejects a file changed during capture', async () => {
    const p = pc(); p.write('original')
    const read = fs.promises.readFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'readFile').mockImplementationOnce(async target => {
      const bytes = await read(target)
      fs.writeFileSync(p.save, 'different length while reading')
      return bytes
    })
    await expect(localState([p.save], new Portable(p.folders))).rejects.toThrow('changing')
  })
})

describe('history safety', () => {
  it('keeps exactly the newest three changed backups by default and uploads nothing unchanged', async () => {
    const p = pc()
    const versions = []
    for (let i = 1; i <= 4; i++) { p.write(`save ${i}`); versions.push((await p.engine.backup(p.game, 'manual'))!) }
    const index = (await p.engine.index('game'))!
    expect(index.snapshots.map(s => s.id)).toEqual(versions.slice(1).map(s => s.id))
    expect(await p.provider.get(`game/${versions[0].id}.zip`)).toBeUndefined()
    expect(await p.engine.backup(p.game, 'manual')).toBeUndefined()
    expect((await p.engine.index('game'))!.snapshots).toHaveLength(3)
    await p.engine.restore('game', versions[1].id)
    expect(fs.readFileSync(p.save, 'utf8')).toBe('save 2')
  })
  it('restores and retains a target that the pre-restore backup would otherwise prune', async () => {
    const p = pc(); p.write('old')
    p.db.data.settings.retention = { keepLast: 1, keepDaily: 0, keepWeekly: 0 }
    const old = (await p.engine.backup(p.game, 'manual'))!
    p.write('current')
    await p.engine.restore('game', old.id)
    expect(fs.readFileSync(p.save, 'utf8')).toBe('old')
    const history = (await p.engine.index('game'))!
    expect(history.snapshots.map(s => s.id)).toContain(old.id)
    expect(history.snapshots.some(s => s.trigger === 'pre-restore')).toBe(true)
  })

  it('preserves old archives and metadata if the new index cannot commit', async () => {
    const p = pc(); p.write('old')
    const old = (await p.engine.backup(p.game, 'manual'))!
    p.db.data.settings.retention = { keepLast: 1, keepDaily: 0, keepWeekly: 0 }
    const put = p.provider.put.bind(p.provider)
    vi.spyOn(p.provider, 'put').mockImplementation(async (key, data) => { if (key.endsWith('index.json')) throw new Error('index failed'); await put(key, data) })
    const remove = vi.spyOn(p.provider, 'remove')
    p.write('new')
    await expect(p.engine.backup(p.game, 'manual')).rejects.toThrow('index failed')
    expect(remove).not.toHaveBeenCalled()
    expect((await p.engine.index('game'))!.snapshots.map(s => s.id)).toEqual([old.id])
    expect(await p.provider.get(`game/${old.id}.zip`)).toBeDefined()
    expect(p.game.lastSnapshotId).toBe(old.id)
  })

  it('keeps a committed backup usable and retries failed deletion', async () => {
    const p = pc(); p.write('old')
    const old = (await p.engine.backup(p.game, 'manual'))!
    p.db.data.settings.retention = { keepLast: 1, keepDaily: 0, keepWeekly: 0 }
    const remove = vi.spyOn(p.provider, 'remove').mockRejectedValueOnce(new Error('delete failed'))
    p.write('new')
    const latest = (await p.engine.backup(p.game, 'manual'))!
    expect(p.game.lastSnapshotId).toBe(latest.id)
    expect(p.game.status).toBe('synced')
    expect((await p.engine.index('game'))!.snapshots.map(s => s.id)).toEqual([latest.id])
    expect(p.db.data.maintenance.game).toContain(old.id)
    await p.engine.kick()
    expect(remove).toHaveBeenCalledTimes(2)
    expect(await p.provider.get(`game/${old.id}.zip`)).toBeUndefined()
    expect(p.db.data.maintenance.game).toBeUndefined()
    await p.engine.restore('game', latest.id)
    expect(fs.readFileSync(p.save, 'utf8')).toBe('new')
  })

  it('never deletes archives when catalog publication fails, then retries discovery', async () => {
    const p = pc(); p.write('old')
    const old = (await p.engine.backup(p.game, 'manual'))!
    p.db.data.settings.retention = { keepLast: 1, keepDaily: 0, keepWeekly: 0 }
    const put = p.provider.put.bind(p.provider)
    const failing = vi.spyOn(p.provider, 'put').mockImplementation(async (key, data) => { if (key === 'catalog.json') throw new Error('catalog failed'); await put(key, data) })
    const remove = vi.spyOn(p.provider, 'remove')
    p.write('new')
    const latest = (await p.engine.backup(p.game, 'manual'))!
    expect(remove).not.toHaveBeenCalled()
    expect(await p.provider.get(`game/${old.id}.zip`)).toBeDefined()
    expect(p.game.lastSnapshotId).toBe(latest.id)
    failing.mockRestore()
    await p.engine.kick()
    expect(JSON.parse((await p.provider.get('catalog.json'))!.toString()).games[0].lastSnapshotId).toBe(latest.id)
    expect(p.db.data.maintenance).toEqual({})
  })
})

describe('backup storage usage', () => {
  it('checks usage even when the backup coordinator is occupied', async () => {
    const p = pc(); await p.provider.connect()
    let release!: () => void
    const held = p.engine.exclusive({ kind: 'backup', gameId: 'game' }, () => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()
    await p.engine.refreshBackupUsage()
    expect(p.engine.backupUsage).toEqual({ status: 'ready', bytes: 0 })
    expect(p.engine.operation?.kind).toBe('backup')
    release(); await held
  })

  it('times out a hung provider, cancels its signal, permits retry, and never blocks backup work', async () => {
    const p = pc(); await p.provider.connect()
    vi.spyOn(p.provider, 'quota').mockResolvedValue({ totalBytes: 100, usedBytes: 0 })
    const list = vi.spyOn(p.provider, 'list').mockImplementation(() => new Promise(() => {}))
    vi.useFakeTimers()
    const check = p.engine.refreshBackupUsage()
    await p.engine.exclusive({ kind: 'backup', gameId: 'game' }, async () => {})
    expect(p.engine.operation).toBeUndefined()
    await vi.advanceTimersByTimeAsync(USAGE_TIMEOUT_MS)
    await check
    expect(p.engine.backupUsage.status).toBe('unavailable')
    expect(list.mock.calls[0][1]?.aborted).toBe(true)
    list.mockResolvedValue([])
    await p.engine.refreshBackupUsage()
    expect(p.engine.backupUsage).toEqual({ status: 'ready', bytes: 0 })
  })

  it('shares concurrent refreshes and ignores late results after invalidation', async () => {
    const p = pc(); await p.provider.connect()
    let resolveRoot!: (entries: { name: string; size: number }[]) => void
    const list = vi.spyOn(p.provider, 'list').mockImplementationOnce(() => new Promise(resolve => { resolveRoot = resolve }))
    const first = p.engine.refreshBackupUsage()
    expect(p.engine.refreshBackupUsage()).toBe(first)
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce())
    p.engine.invalidateBackupUsage()
    await first
    const retry = p.engine.refreshBackupUsage()
    await retry
    expect(p.engine.backupUsage).toEqual({ status: 'ready', bytes: 0 })
    resolveRoot([{ name: 'old-game', size: 0 }])
    await Promise.resolve(); await Promise.resolve()
    expect(p.engine.backupUsage).toEqual({ status: 'ready', bytes: 0 })
    expect(list.mock.calls.some(([dir]) => dir === 'old-game')).toBe(false)
  })

  it('scans four folders concurrently and reports progress without partial totals', async () => {
    const p = pc(); await p.provider.connect()
    let active = 0, max = 0
    vi.spyOn(p.provider, 'list').mockImplementation(async dir => {
      if (!dir) return Array.from({ length: 10 }, (_, i) => ({ name: `game-${i}`, size: 0 }))
      active++; max = Math.max(max, active)
      await new Promise(resolve => setImmediate(resolve))
      active--
      return [{ name: 'backup.zip', size: 10 }]
    })
    const progress = vi.fn()
    expect(await measureBackupUsage(p.provider, new AbortController().signal, progress)).toBe(100)
    expect(max).toBe(4)
    expect(progress).toHaveBeenLastCalledWith(10, 10)
  })

  it('distinguishes unmeasured storage, confirmed zero, and unavailable storage', async () => {
    const p = pc()
    expect(p.engine.backupUsage.status).toBe('unavailable')
    await p.provider.connect()
    await p.engine.refreshBackupUsage()
    expect(p.engine.backupUsage).toEqual({ status: 'ready', bytes: 0 })
    vi.spyOn(p.provider, 'list').mockRejectedValueOnce(new Error('offline'))
    await p.engine.refreshBackupUsage()
    expect(p.engine.backupUsage).toEqual({ status: 'unavailable' })
    await p.engine.refreshBackupUsage()
    expect(p.engine.backupUsage).toEqual({ status: 'ready', bytes: 0 })
  })

  it('counts real archive bytes including orphans and pending cleanup instead of index estimates', async () => {
    const p = pc(); p.write('save')
    const snapshot = (await p.engine.backup(p.game, 'manual'))!
    await p.provider.put('game/orphan.zip', Buffer.from('orphan'))
    await p.provider.put('game/pending.zip.part', Buffer.from('partial'))
    await p.engine.refreshBackupUsage()
    expect(p.engine.backupUsage).toEqual({ status: 'ready', bytes: snapshot.zipBytes + 6 + 7 })
  })
})

describe('coordinated operations', () => {
  it('serializes restore and storage changes behind an active backup', async () => {
    const p = pc(); p.write('old')
    const old = (await p.engine.backup(p.game, 'manual'))!
    p.write('new')
    let unblock!: () => void
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const put = p.provider.put.bind(p.provider)
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    vi.spyOn(p.provider, 'put').mockImplementationOnce(async (key, data) => { entered(); await gate; await put(key, data) })
    const backup = p.engine.backup(p.game, 'manual')
    await started
    const restore = p.engine.restore('game', old.id)
    const switchStorage = vi.fn(async () => { expect(fs.readFileSync(p.save, 'utf8')).toBe('old') })
    const changed = p.engine.exclusive({ kind: 'storage' }, switchStorage)
    expect(p.engine.operation?.kind).toBe('backup')
    expect(switchStorage).not.toHaveBeenCalled()
    unblock()
    await Promise.all([backup, restore, changed])
    expect(switchStorage).toHaveBeenCalledOnce()
    expect(p.engine.operation).toBeUndefined()
  })

  it('rechecks tracking when a queued backup starts', async () => {
    const p = pc(); p.write('save')
    let release!: () => void
    const held = p.engine.exclusive({ kind: 'storage' }, () => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()
    const backup = p.engine.backup(p.game, 'manual')
    p.game.tracked = false
    release(); await held
    expect(await backup).toBeUndefined()
    expect(await p.engine.index('game')).toBeUndefined()
  })

  it('retains a deferred job while a game is running, then retries it', async () => {
    const p = pc(); p.write('save'); p.running.value = true
    p.db.data.queue.push({ gameId: 'game', trigger: 'manual' })
    await p.engine.kick()
    expect(p.engine.queue).toEqual(['game'])
    expect(p.game.status).toBe('pending')
    expect(p.engine.operation).toBeUndefined()
    p.running.value = false
    await p.engine.kick()
    expect(p.engine.queue).toEqual([])
    expect(p.game.lastSnapshotId).toBeDefined()
  })

  it('keeps a transient storage failure queued and retries on the timer', async () => {
    const p = pc(); p.write('save')
    vi.useFakeTimers()
    vi.spyOn(p.provider, 'put').mockRejectedValueOnce(new TypeError('offline'))
    p.db.data.queue.push({ gameId: 'game', trigger: 'manual' })
    await p.engine.kick()
    expect(p.engine.queue).toEqual(['game'])
    expect(p.game.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(30_000)
    await p.engine.drain()
    expect(p.game.lastSnapshotId).toBeDefined()
    expect(p.engine.queue).toEqual([])
  })
})

describe('restore validation and rollback', () => {
  it('rejects corrupt archive bytes before making a pre-restore backup or writing saves', async () => {
    const p = pc(); p.write('old')
    const snap = (await p.engine.backup(p.game, 'manual'))!
    await p.provider.put(`game/${snap.id}.zip`, Buffer.from('broken archive'))
    p.write('current')
    await expect(p.engine.restore('game', snap.id)).rejects.toThrow()
    expect(fs.readFileSync(p.save, 'utf8')).toBe('current')
    expect((await p.engine.index('game'))!.snapshots).toHaveLength(1)
  })

  it('rejects bad hashes, missing entries, and unresolved destinations before any writes', () => {
    const p = pc()
    const portable = new Portable(p.folders)
    const snapshot = { files: { '<winAppData>/Game/slot.sav': 'bad' }, sizeBytes: 4 }
    expect(() => prepareRestore(Buffer.from(zipSync({ 'winAppData/Game/slot.sav': Buffer.from('data') })), portable, snapshot)).toThrow('integrity')
    expect(() => prepareRestore(Buffer.from(zipSync({})), portable, snapshot)).toThrow('incomplete')
    expect(() => prepareRestore(Buffer.from(zipSync({ 'base/slot.sav': Buffer.from('data') })), portable, snapshot)).toThrow('Cannot resolve')
  })

  it.each(['winAppData/../outside.sav', 'winAppData/Game/..\\outside.sav', 'winAppData/Game/a:stream', 'winAppData/Game/NUL.sav', '/winAppData/Game/slot.sav', 'winAppData/Game/file.'])('rejects unsafe Windows entry %s', name => {
    const p = pc()
    expect(() => prepareRestore(Buffer.from(zipSync({ [name]: Buffer.from('data') })), new Portable(p.folders), { files: {}, sizeBytes: 4 })).toThrow('Unsafe path')
  })

  it('rolls all files back when a later replacement fails', async () => {
    const root = tmp(), first = path.join(root, 'first.sav'), second = path.join(root, 'second.sav')
    fs.writeFileSync(first, 'first original'); fs.writeFileSync(second, 'second original')
    const rename = fs.promises.rename.bind(fs.promises)
    let calls = 0
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { if (++calls === 2) throw new Error('injected write failure'); await rename(from, to) })
    await expect(applyRestore([{ target: first, data: Buffer.from('new') }, { target: second, data: Buffer.from('new') }], path.join(root, 'recovery'))).rejects.toThrow('injected write failure')
    expect(fs.readFileSync(first, 'utf8')).toBe('first original')
    expect(fs.readFileSync(second, 'utf8')).toBe('second original')
  })

  it('retains originals if rollback fails and recovers them on the next startup', async () => {
    const root = tmp(), target = path.join(root, 'slot.sav'), recovery = path.join(root, 'recovery')
    fs.writeFileSync(target, 'original')
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('locked target'))
    await expect(applyRestore([{ target, data: Buffer.from('new') }], recovery)).rejects.toThrow('Recovery files retained')
    expect(fs.readdirSync(recovery)).toHaveLength(1)
    vi.restoreAllMocks()
    expect(await recoverRestores(recovery)).toBe(1)
    expect(fs.readFileSync(target, 'utf8')).toBe('original')
    expect(fs.readdirSync(recovery)).toEqual([])
  })

  it('does not roll back an already completed restore on startup', async () => {
    const root = tmp(), directory = path.join(root, 'restore-complete'), target = path.join(root, 'slot.sav')
    fs.mkdirSync(directory); fs.writeFileSync(target, 'restored')
    fs.writeFileSync(path.join(directory, 'complete'), '')
    expect(await recoverRestores(root)).toBe(0)
    expect(fs.readFileSync(target, 'utf8')).toBe('restored')
  })

  it('stops automatic work and rejects further writes after an unrecoverable rollback', async () => {
    const p = pc(); p.write('old')
    const old = (await p.engine.backup(p.game, 'manual'))!
    p.write('current')
    const rename = fs.promises.rename.bind(fs.promises)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(p.save)) throw new Error('save is locked')
      await rename(from, to)
    })
    await expect(p.engine.restore('game', old.id)).rejects.toThrow('Recovery files retained')
    expect(p.engine.recoveryRequired).toContain('Automatic backups are stopped')
    vi.restoreAllMocks()
    p.engine.enqueue('game', 'file-change')
    expect(p.engine.queue).toEqual([])
    await expect(p.engine.backup(p.game, 'manual')).rejects.toThrow('Automatic backups are stopped')
    expect(await recoverRestores(p.db.recoveryDirectory)).toBe(1)
    expect(fs.readFileSync(p.save, 'utf8')).toBe('current')
  })

  it('removes newly created files if a later write fails', async () => {
    const root = tmp(), first = path.join(root, 'new.sav'), second = path.join(root, 'second.sav')
    fs.writeFileSync(second, 'original')
    const rename = fs.promises.rename.bind(fs.promises)
    let count = 0
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { if (++count === 2) throw new Error('write failed'); await rename(from, to) })
    await expect(applyRestore([{ target: first, data: Buffer.from('new') }, { target: second, data: Buffer.from('new') }], path.join(root, 'recovery'))).rejects.toThrow('write failed')
    expect(fs.existsSync(first)).toBe(false)
    expect(fs.readFileSync(second, 'utf8')).toBe('original')
  })

  it('refuses junction destinations before replacing files', async () => {
    const root = tmp(), actual = path.join(root, 'actual'), link = path.join(root, 'junction')
    fs.mkdirSync(actual)
    fs.writeFileSync(path.join(actual, 'slot.sav'), 'original')
    fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(applyRestore([{ target: path.join(link, 'slot.sav'), data: Buffer.from('new') }], path.join(root, 'recovery'))).rejects.toThrow('contains a link')
    expect(fs.readFileSync(path.join(actual, 'slot.sav'), 'utf8')).toBe('original')
  })
})

it('does not treat local storage permission failures as an empty cloud history', async () => {
  const p = pc()
  vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
  await expect(p.provider.get('game/index.json')).rejects.toThrow('permission denied')
})
