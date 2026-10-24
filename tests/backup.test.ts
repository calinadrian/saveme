import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackupEngine } from '../src/main/backup/engine'
import { snapshotsToPrune } from '../src/main/backup/retention'
import { LocalFolderProvider } from '../src/main/cloud/local'
import { Game, SnapshotMeta } from '../src/shared/types'
import { Db } from '../src/main/store/db'
import { resolveTemplate } from '../src/main/detect/scanner'
import { fakeFolders } from './helpers'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-'))
const DAY = 24 * 3600 * 1000

describe('retention', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  const snap = (ageMs: number, i: number): SnapshotMeta =>
    ({ id: `s${i}`, createdAt: new Date(now - ageMs).toISOString() }) as SnapshotMeta

  it('keeps the latest N and thins out older ones by day and week', () => {
    // 4 per day for 60 days
    const all = Array.from({ length: 240 }, (_, i) => snap((i * DAY) / 4 + 1000, i))
    const pruned = snapshotsToPrune(all, { keepLast: 10, keepDaily: 14, keepWeekly: 8 }, now)
    const kept = all.filter((s) => !pruned.includes(s))
    expect(kept.slice(0, 10).map((s) => s.id)).toEqual(all.slice(0, 10).map((s) => s.id))
    const old = kept.filter((s) => now - Date.parse(s.createdAt) > 14 * DAY)
    expect(old.length).toBeLessThanOrEqual(8)
    expect(kept.length).toBeLessThan(10 + 14 + 8)
    expect(kept.some((s) => now - Date.parse(s.createdAt) > 45 * DAY)).toBe(true)
    expect(kept.some((s) => now - Date.parse(s.createdAt) > 56 * DAY)).toBe(false)
  })

  it('always keeps at least one', () => {
    expect(snapshotsToPrune([snap(400 * DAY, 1)], { keepLast: 0, keepDaily: 0, keepWeekly: 0 }, now)).toEqual([])
  })
})

/** A simulated PC: its own user folders and state, sharing one "cloud" folder with the others. */
function machine(cloud: string, name: string) {
  const root = tmp()
  const folders = fakeFolders(root)
  const db = new Db(path.join(root, 'state.json'))
  const saveDir = folders.winAppData + '/TestStudio/TestGame'
  const game: Game = {
    id: 'test-game',
    name: 'Test Game',
    roots: [{ template: '<winAppData>/TestStudio/TestGame', resolved: resolveTemplate('<winAppData>/TestStudio/TestGame', { folders })! }],
    tracked: true,
    status: 'never',
    sizeBytes: 0,
    fileCount: 0
  }
  db.data.games[game.id] = game
  const notes: string[] = []
  const provider = new LocalFolderProvider(cloud)
  const engine = new BackupEngine({
    db,
    folders,
    provider: () => provider,
    isRunning: () => false,
    notify: (title) => notes.push(title),
    changed: () => undefined
  })
  const write = (file: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(saveDir, file)), { recursive: true })
    fs.writeFileSync(path.join(saveDir, file), content)
  }
  const read = (file: string): string => fs.readFileSync(path.join(saveDir, file), 'utf8')
  return { name, db, game, engine, notes, write, read, provider }
}

describe('backup engine', () => {
  it('uploads only when saves change', async () => {
    const pc = machine(tmp(), 'A')
    pc.write('slot1.sav', 'level 1')
    const first = await pc.engine.backup(pc.game, 'first-backup')
    expect(first).toBeDefined()
    expect(await pc.engine.backup(pc.game, 'game-exit')).toBeUndefined()
    pc.write('slot1.sav', 'level 2')
    const second = await pc.engine.backup(pc.game, 'game-exit')
    expect(second?.files).not.toEqual(first?.files)
    expect((await pc.engine.index('test-game'))?.snapshots).toHaveLength(2)
    expect(pc.engine.saveMeBytes).toBeGreaterThan(0)
    expect(pc.game.status).toBe('synced')
  })

  it('restores identical bytes and keeps a pre-restore copy', async () => {
    const pc = machine(tmp(), 'A')
    const binary = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) % 256))
    fs.mkdirSync(path.dirname(path.join(pc.game.roots[0].resolved, 'x')), { recursive: true })
    fs.writeFileSync(path.join(pc.game.roots[0].resolved, 'data.bin'), binary)
    pc.write('sub/dir/slot.sav', 'original')
    const v1 = (await pc.engine.backup(pc.game, 'manual'))!
    pc.write('sub/dir/slot.sav', 'broken')
    await pc.engine.restore('test-game', v1.id)
    expect(pc.read('sub/dir/slot.sav')).toBe('original')
    expect(fs.readFileSync(path.join(pc.game.roots[0].resolved, 'data.bin')).equals(binary)).toBe(true)
    const triggers = (await pc.engine.index('test-game'))!.snapshots.map((s) => s.trigger)
    expect(triggers).toContain('pre-restore')
  })

  it('does not let a fresh PC overwrite the cloud, then syncs between PCs', async () => {
    const cloud = tmp()
    const a = machine(cloud, 'A')
    const b = machine(cloud, 'B')
    a.write('slot.sav', 'hours of progress')
    await a.engine.backup(a.game, 'game-exit')

    // B has only a brand-new save: it must not upload it as the latest.
    b.write('slot.sav', 'new game')
    expect(await b.engine.backup(b.game, 'first-backup')).toBeUndefined()
    expect(b.game.status).toBe('cloud-newer')
    expect(b.notes.length).toBe(1)

    await b.engine.restore('test-game', b.game.newerSnapshot!.id)
    expect(b.read('slot.sav')).toBe('hours of progress')
    expect(b.game.status).toBe('synced')

    // Play on B, then A sees the newer save.
    b.write('slot.sav', 'played on B')
    await b.engine.backup(b.game, 'game-exit')
    await a.engine.checkRemote()
    expect(a.game.status).toBe('cloud-newer')
    expect(a.game.newerSnapshot?.machineId).toBe(b.db.data.machineId)
    await a.engine.restore('test-game', a.game.newerSnapshot!.id)
    expect(a.read('slot.sav')).toBe('played on B')
  })

  it('offers games that exist only in the cloud', async () => {
    const cloud = tmp()
    const a = machine(cloud, 'A')
    a.write('slot.sav', 'progress')
    await a.engine.backup(a.game, 'game-exit')
    const b = machine(cloud, 'B')
    delete b.db.data.games['test-game']
    await b.engine.checkRemote()
    expect(b.db.data.games['test-game']?.status).toBe('cloud-newer')
  })
})
