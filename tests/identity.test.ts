import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { APP_ID, DEV_APP_ID, repairSaveMeShortcuts, shellIconPath } from '../src/main/identity'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))
const setup = () => {
  const programs = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-identity-'))
  dirs.push(programs)
  return { programs, backup: path.join(programs, 'backup') }
}

it('archives the Electron shortcut claiming SaveMe and registers the real app and icon', () => {
  const { programs, backup } = setup()
  fs.writeFileSync(path.join(programs, 'Electron.lnk'), 'legacy shortcut')
  const shell = {
    readShortcutLink: vi.fn(() => ({ target: 'D:\\Projects\\saveme\\node_modules\\electron\\dist\\electron.exe', appUserModelId: APP_ID })),
    writeShortcutLink: vi.fn(() => true)
  }
  repairSaveMeShortcuts(programs, backup, 'D:\\SaveMe\\SaveMe.exe', 'D:\\SaveMe\\icon.ico', shell)
  expect(fs.existsSync(path.join(programs, 'Electron.lnk'))).toBe(false)
  expect(fs.readFileSync(path.join(backup, fs.readdirSync(backup)[0]), 'utf8')).toBe('legacy shortcut')
  expect(shell.writeShortcutLink).toHaveBeenCalledWith(path.join(programs, 'SaveMe.lnk'), 'create', expect.objectContaining({ target: 'D:\\SaveMe\\SaveMe.exe', icon: 'D:\\SaveMe\\icon.ico', appUserModelId: APP_ID }))
  expect(DEV_APP_ID).not.toBe(APP_ID)
})

it('preserves another Electron app shortcut and an unrelated user shortcut', () => {
  const { programs, backup } = setup()
  fs.writeFileSync(path.join(programs, 'Electron.lnk'), 'another app')
  fs.writeFileSync(path.join(programs, 'SaveMe.lnk'), 'user link')
  const shell = {
    readShortcutLink: vi.fn(() => ({ target: 'C:\\OtherApp\\electron.exe', appUserModelId: 'org.other.app' })),
    writeShortcutLink: vi.fn(() => true)
  }
  repairSaveMeShortcuts(programs, backup, 'D:\\SaveMe\\SaveMe.exe', 'D:\\SaveMe\\icon.ico', shell)
  expect(fs.readFileSync(path.join(programs, 'Electron.lnk'), 'utf8')).toBe('another app')
  expect(fs.readFileSync(path.join(programs, 'SaveMe.lnk'), 'utf8')).toBe('user link')
  expect(shell.writeShortcutLink).not.toHaveBeenCalled()
})

it('refreshes a SaveMe-owned shortcut that still points at an old executable or icon', () => {
  const { programs, backup } = setup()
  fs.writeFileSync(path.join(programs, 'SaveMe.lnk'), 'old')
  const shell = {
    readShortcutLink: vi.fn(() => ({ target: 'D:\\old\\SaveMe.exe', icon: 'D:\\old\\icon.ico', appUserModelId: APP_ID })),
    writeShortcutLink: vi.fn(() => true)
  }
  repairSaveMeShortcuts(programs, backup, 'D:\\SaveMe\\SaveMe.exe', 'D:\\SaveMe\\icon.ico', shell)
  expect(shell.writeShortcutLink).toHaveBeenCalledWith(path.join(programs, 'SaveMe.lnk'), 'update', expect.objectContaining({ target: 'D:\\SaveMe\\SaveMe.exe' }))
})

it('gives changed icon content a fresh immutable shell path while preserving the old icon', () => {
  const { programs, backup } = setup()
  const source = path.join(programs, 'icon.ico')
  fs.writeFileSync(source, 'green icon')
  const green = shellIconPath(source, backup)
  expect(fs.readFileSync(green, 'utf8')).toBe('green icon')
  expect(shellIconPath(source, backup)).toBe(green)
  fs.writeFileSync(source, 'blue icon')
  const blue = shellIconPath(source, backup)
  expect(blue).not.toBe(green)
  expect(fs.readFileSync(blue, 'utf8')).toBe('blue icon')
  expect(fs.readFileSync(green, 'utf8')).toBe('green icon')
})
