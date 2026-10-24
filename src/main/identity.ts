import fs from 'node:fs'
import path from 'node:path'
import type { ShortcutDetails } from 'electron'

export const APP_ID = 'app.saveme.desktop'
export const DEV_APP_ID = 'app.saveme.desktop.dev'

interface Shortcuts {
  readShortcutLink(file: string): ShortcutDetails
  writeShortcutLink(file: string, operation: 'create' | 'update', details: ShortcutDetails): boolean
}

/** Repair only the legacy Electron shortcut that explicitly claims SaveMe's ID. */
export function repairSaveMeShortcuts(programs: string, backup: string, executable: string, icon: string, shell: Shortcuts): void {
  const legacy = path.join(programs, 'Electron.lnk')
  if (fs.existsSync(legacy)) {
    try {
      const details = shell.readShortcutLink(legacy)
      if (details.appUserModelId === APP_ID && path.win32.basename(details.target).toLowerCase() === 'electron.exe') {
        fs.mkdirSync(backup, { recursive: true })
        fs.renameSync(legacy, path.join(backup, `Electron-${Date.now()}.lnk`))
      }
    } catch (error) { console.warn('[saveme] Shortcut migration:', (error as Error).message) }
  }
  const shortcut = path.join(programs, 'SaveMe.lnk')
  let exists = false
  if (fs.existsSync(shortcut)) {
    try {
      const details = shell.readShortcutLink(shortcut)
      // A user-created unrelated shortcut with this name must remain theirs.
      if (details.appUserModelId && details.appUserModelId !== APP_ID) return
      if (path.win32.basename(details.target).toLowerCase() !== 'saveme.exe') return
      if (details.target === executable && details.icon === icon && details.appUserModelId === APP_ID) return
      exists = true
    } catch { return }
  }
  fs.mkdirSync(programs, { recursive: true })
  const saved = shell.writeShortcutLink(shortcut, exists ? 'update' : 'create', {
    target: executable, cwd: path.dirname(executable), args: '', description: 'SaveMe — game save backups',
    icon, iconIndex: 0, appUserModelId: APP_ID
  })
  if (!saved) console.warn('[saveme] Could not register the SaveMe Start menu shortcut')
}
