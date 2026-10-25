import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false }, shell: {} }))
import { SaveMeApp } from '../src/main/app'
import { validateRetention } from '../src/shared/settings'
import { Db } from '../src/main/store/db'
import { resolveTheme } from '../src/shared/appearance'
import type { Appearance } from '../src/shared/types'

const roots: string[] = []
it('defaults new and legacy profiles to dark while retaining other settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-appearance-')); roots.push(root)
  const file = path.join(root, 'state.json')
  expect(new Db(file).data.settings.appearance).toBe('dark')
  fs.writeFileSync(file, JSON.stringify({ settings: { notifications: false } }))
  const db = new Db(file)
  expect(db.data.settings.appearance).toBe('dark')
  expect(db.data.settings.notifications).toBe(false)
})

it.each(['light', 'dark', 'system'] as const)('persists %s across restart', appearance => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-appearance-')); roots.push(root)
  const app = new SaveMeApp(root, () => {})
  app.updateSettings({ appearance })
  expect(new Db(path.join(root, 'state.json')).data.settings.appearance).toBe(appearance)
})

it.each(['sepia', '', null, 1])('rejects invalid appearance %j without changing preferences', value => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-appearance-')); roots.push(root)
  const app = new SaveMeApp(root, () => {})
  const previous = structuredClone(app.db.data.settings)
  expect(() => app.updateSettings({ appearance: value as Appearance, notifications: false })).toThrow('appearance')
  expect(app.db.data.settings).toEqual(previous)
  expect(fs.existsSync(path.join(root, 'state.json'))).toBe(false)
})

it('rolls back appearance when persistence fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-appearance-')); roots.push(root)
  const app = new SaveMeApp(root, () => {})
  const flush = vi.spyOn(app.db, 'flush').mockImplementation(() => { throw new Error('disk unavailable') })
  expect(() => app.updateSettings({ appearance: 'light' })).toThrow('disk unavailable')
  expect(app.db.data.settings.appearance).toBe('dark')
  flush.mockRestore()
})

it('follows Windows only when System is selected', () => {
  expect(resolveTheme('system', true)).toBe('dark')
  expect(resolveTheme('system', false)).toBe('light')
  expect(resolveTheme('dark', false)).toBe('dark')
  expect(resolveTheme('light', true)).toBe('light')
})
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

it.each([
  { keepLast: 0, keepDaily: 14, keepWeekly: 8 },
  { keepLast: 1, keepDaily: 0, keepWeekly: 0 },
  { keepLast: 1, keepDaily: -1, keepWeekly: 8 },
  { keepLast: 1, keepDaily: 366, keepWeekly: 8 },
  { keepLast: 1.5, keepDaily: 14, keepWeekly: 8 },
  { keepLast: 1, keepDaily: 14, keepWeekly: NaN }
])('rejects invalid retention before mutating or persisting settings: %j', retention => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-ui-settings-')); roots.push(root)
  const app = new SaveMeApp(root, () => {})
  const before = structuredClone(app.db.data.settings)
  expect(() => app.updateSettings({ notifications: false, retention })).toThrow('whole number')
  expect(app.db.data.settings).toEqual(before)
  expect(fs.existsSync(path.join(root, 'state.json'))).toBe(false)
})

it('accepts and persists the boundary values while preserving unrelated choices', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-ui-settings-')); roots.push(root)
  const app = new SaveMeApp(root, () => {})
  const retention = { keepLast: 2, keepDaily: 0, keepWeekly: 0 }
  expect(() => validateRetention(retention)).not.toThrow()
  const settings = app.updateSettings({ retention })
  expect(settings.minimizeToTray).toBe(true)
  expect(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).settings.retention).toEqual(retention)
})

it('keeps the previous choices in memory if saving preferences fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-ui-settings-')); roots.push(root)
  const app = new SaveMeApp(root, () => {})
  const previous = structuredClone(app.db.data.settings)
  const flush = vi.spyOn(app.db, 'flush').mockImplementation(() => { throw new Error('disk unavailable') })
  expect(() => app.updateSettings({ notifications: false })).toThrow('disk unavailable')
  expect(app.db.data.settings).toEqual(previous)
  flush.mockRestore()
})
