import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import type { Appearance } from '../shared/types'
import { resolveTheme, WINDOW_COLORS } from '../shared/appearance'

/** Owns native chrome and renderer appearance, including reloads and hidden windows. */
export function createAppearance(getAppearance: () => Appearance, getWindow: () => BrowserWindow | undefined) {
  const current = () => resolveTheme(getAppearance(), nativeTheme.shouldUseDarkColors)
  const apply = () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    const theme = current()
    win.setBackgroundColor(WINDOW_COLORS[theme].color)
    win.setTitleBarOverlay(WINDOW_COLORS[theme])
    win.webContents.send('theme', theme)
  }
  // Synchronous bootstrap is restricted to this small, already-loaded preference.
  ipcMain.on('theme:initial', event => { event.returnValue = current() })
  nativeTheme.on('updated', () => { if (getAppearance() === 'system') apply() })
  return { current, apply }
}
