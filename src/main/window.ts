import type { BrowserWindow } from 'electron'

/** Read the current setting on each minimize, so changes apply immediately. */
export function installMinimizeBehavior(window: BrowserWindow, enabled: () => boolean): void {
  window.on('minimize', () => {
    if (enabled()) window.hide()
  })
}

/** Tray clicks and second launches must also restore an iconic (minimized) window. */
export function restoreWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
