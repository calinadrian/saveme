import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false }, shell: { openExternal: vi.fn() } }))
import { SaveMeApp } from '../src/main/app'
import { BackupEngine } from '../src/main/backup/engine'
import { fakeFolders } from './helpers'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-storage-'))
  const app = new SaveMeApp(root, () => {})
  app.engine = new BackupEngine({ db: app.db, folders: fakeFolders(root), provider: () => undefined, isRunning: () => false, notify: () => {}, changed: () => {} })
  cleanup.push(() => { app.shutdown(); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, app }
}

it('waits for the active operation before connecting a different storage', async () => {
  const { root, app } = setup()
  let release!: () => void
  const held = app.engine.exclusive({ kind: 'backup', gameId: 'game' }, () => new Promise<void>(resolve => { release = resolve }))
  await Promise.resolve()
  const destination = path.join(root, 'destination')
  const connection = app.connect('local', destination)
  expect(fs.existsSync(destination)).toBe(false)
  expect(app.db.data.settings.provider).toBeUndefined()
  release(); await held; await connection
  expect(app.db.data.settings.provider).toBe('local')
  expect(fs.existsSync(path.join(destination, 'SaveMe'))).toBe(true)
})

it('keeps the previous destination and settings when connecting the replacement fails', async () => {
  const { root, app } = setup()
  const destination = path.join(root, 'destination')
  await app.connect('local', destination)
  const blocked = path.join(root, 'not-a-folder')
  fs.writeFileSync(blocked, 'file')
  await expect(app.connect('local', blocked)).rejects.toThrow()
  expect(app.db.data.settings.localFolder).toBe(destination.replace(/\\/g, '/'))
  expect(app.state().provider.location).toContain('destination')
})
