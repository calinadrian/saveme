// App updates from GitHub releases. Kept separate from Electron so the event order and retries are testable.
import type { UpdateNotes, UpdateState } from '../shared/types'

/** The parts of electron-updater's autoUpdater this uses. */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  on(event: string, listener: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown> | unknown
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

interface ReleaseInfo {
  version: string
  releaseNotes?: string | { note?: string | null }[] | null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' }

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** GitHub sends release notes as HTML; turn them (or markdown) into titled lists for the update dialog. */
export function releaseSections(raw: ReleaseInfo['releaseNotes']): UpdateNotes {
  let text = Array.isArray(raw) ? raw.map((r) => r.note ?? '').join('\n') : (raw ?? '')
  if (/<[a-z]/i.test(text)) {
    text = text
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<h\d\b[^>]*>([\s\S]*?)<\/h\d>/gi, (_, t: string) => `\n## ${t}\n`)
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t: string) => `\n- ${t}\n`)
      .replace(/<br\s*\/?>|<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
    text = decode(text)
  }
  const sections: UpdateNotes = []
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const heading = /^#+\s*(.+)/.exec(line)
    const entry = /^[-*•]\s*(.+)/.exec(line)
    if (heading) sections.push({ title: heading[1], items: [] })
    else {
      if (!sections.length) sections.push({ title: '', items: [] })
      sections[sections.length - 1].items.push(entry ? entry[1] : line)
    }
  }
  return sections.filter((s) => s.items.length)
}

export interface Updates {
  get(): UpdateState
  check(): UpdateState
  install(): void
}

/**
 * Installed copies download new releases in the background. They install when the user says so,
 * when SaveMe quits, or (see index.ts) when it sits idle in the tray.
 */
export function createUpdates({
  current,
  updater,
  publish = () => undefined,
  beforeInstall = () => undefined
}: {
  current: string
  updater?: Updater | null
  publish?: (state: UpdateState) => void
  beforeInstall?: () => void
}): Updates {
  let state: UpdateState = { current, status: updater ? 'idle' : 'dev' }
  const set = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch }
    publish(state)
  }
  const fail = (error: Error): void =>
    // Before the first release GitHub has nothing to offer, which just means this is the latest version.
    /No published versions/i.test(error.message)
      ? set({ status: 'latest', checkedAt: Date.now(), version: undefined, notes: [], message: undefined })
      : set({
      status: 'error',
      checkedAt: Date.now(),
      message: /net::|ENOTFOUND|ETIMEDOUT|ECONN|EAI_AGAIN/i.test(error.message) ? 'No connection to GitHub. Check your connection and try again.' : 'The update failed. Check for updates to try again.'
    })
  if (updater) {
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.autoRunAppAfterInstall = true
    updater.on('checking-for-update', () => set({ status: 'checking', message: undefined }))
    updater.on('update-not-available', () => set({ status: 'latest', checkedAt: Date.now(), version: undefined, notes: [] }))
    updater.on('update-available', (info: ReleaseInfo) => set({ status: 'downloading', percent: 0, version: info.version, notes: releaseSections(info.releaseNotes), checkedAt: Date.now() }))
    updater.on('download-progress', (p: { percent: number }) => set({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent) || 0)) }))
    updater.on('update-downloaded', (info: ReleaseInfo) =>
      set({ status: 'ready', percent: 100, version: info.version, notes: info.releaseNotes == null ? state.notes : releaseSections(info.releaseNotes) })
    )
    updater.on('error', fail)
  }
  return {
    get: () => state,
    check() {
      if (!updater || ['checking', 'downloading', 'ready', 'installing'].includes(state.status)) return state
      set({ status: 'checking', message: undefined })
      // Also handle synchronous failures and rejected checks that don't emit an error event.
      Promise.resolve()
        .then(() => updater.checkForUpdates())
        .catch(fail)
      return state
    },
    install() {
      if (!updater || state.status !== 'ready') return
      set({ status: 'installing' })
      try {
        beforeInstall()
        updater.quitAndInstall(true, true)
      } catch (error) {
        fail(error as Error)
      }
    }
  }
}
