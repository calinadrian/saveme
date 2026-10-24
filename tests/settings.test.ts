import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Db } from '../src/main/store/db'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))
const file = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-settings-'))
  dirs.push(dir)
  return path.join(dir, 'state.json')
}

it('defaults new and existing installations to minimizing to tray without changing existing choices', () => {
  const target = file()
  expect(new Db(target).data.settings.minimizeToTray).toBe(true)
  fs.writeFileSync(target, JSON.stringify({ settings: { startAtLogin: false, notifications: false }, games: {}, tokens: {} }))
  const db = new Db(target)
  expect(db.data.settings.minimizeToTray).toBe(true)
  expect(db.data.settings.startAtLogin).toBe(false)
  expect(db.data.settings.notifications).toBe(false)
})

it('defaults new installations to three backups without migrating existing retention choices', () => {
  const target = file()
  expect(new Db(target).data.settings.retention).toEqual({ keepLast: 3, keepDaily: 0, keepWeekly: 0 })
  fs.writeFileSync(target, JSON.stringify({ settings: { retention: { keepLast: 3, keepDaily: 14, keepWeekly: 8 } } }))
  expect(new Db(target).data.settings.retention).toEqual({ keepLast: 3, keepDaily: 14, keepWeekly: 8 })
  fs.writeFileSync(target, JSON.stringify({ settings: { retention: { keepLast: 2 } } }))
  expect(new Db(target).data.settings.retention).toEqual({ keepLast: 2, keepDaily: 14, keepWeekly: 8 })
  fs.writeFileSync(target, JSON.stringify({ settings: { retention: { keepLast: 1, keepDaily: 0, keepWeekly: 0 } } }))
  expect(new Db(target).data.settings.retention).toEqual({ keepLast: 1, keepDaily: 0, keepWeekly: 0 })
})

it('preserves a taskbar preference through an immediate reload and supports switching back to tray', () => {
  const target = file()
  const db = new Db(target)
  db.data.settings.minimizeToTray = false
  db.flush()
  const restarted = new Db(target)
  expect(restarted.data.settings.minimizeToTray).toBe(false)
  restarted.data.settings.minimizeToTray = true
  restarted.flush()
  expect(new Db(target).data.settings.minimizeToTray).toBe(true)
})

it('preserves corrupt bytes and recovers the previous validated copy without losing it on save', () => {
  const target = file()
  const db = new Db(target)
  db.data.settings.minimizeToTray = false
  db.flush()
  db.data.settings.notifications = false
  db.flush()
  const previous = fs.readFileSync(target + '.bak', 'utf8')
  fs.writeFileSync(target, '{ corrupt')
  const recovered = new Db(target)
  expect(recovered.data.settings.minimizeToTray).toBe(false)
  expect(recovered.recoveryWarning).toContain('recovered')
  const copy = fs.readdirSync(path.dirname(target)).find(n => n.startsWith('state.json.corrupt-'))!
  expect(fs.readFileSync(path.join(path.dirname(target), copy), 'utf8')).toBe('{ corrupt')
  recovered.flush()
  expect(JSON.parse(fs.readFileSync(target + '.bak', 'utf8')).machineId).toBe(JSON.parse(previous).machineId)
  expect(new Db(target).data.settings.minimizeToTray).toBe(false)
})

it('surfaces unrecoverable settings instead of silently resetting them', () => {
  const target = file()
  fs.writeFileSync(target, '{ broken')
  fs.writeFileSync(target + '.bak', '{ also broken')
  expect(() => new Db(target)).toThrow('Cannot recover local settings')
  expect(fs.readFileSync(target, 'utf8')).toBe('{ broken')
  expect(fs.readFileSync(target + '.bak', 'utf8')).toBe('{ also broken')
})

it('rejects structurally corrupt settings and recovers a missing main file', () => {
  const target = file()
  const db = new Db(target)
  db.data.settings.minimizeToTray = false
  db.flush(); db.flush()
  fs.writeFileSync(target, JSON.stringify({ games: [], queue: {} }))
  const recovered = new Db(target)
  expect(recovered.data.settings.minimizeToTray).toBe(false)
  fs.unlinkSync(target)
  expect(new Db(target).data.settings.minimizeToTray).toBe(false)
})
