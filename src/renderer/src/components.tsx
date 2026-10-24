import { ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Game, GameStatus, ProviderKind } from '../../shared/types'

// ---- icons: 24px grid, drawn with the current text color ----

const PATHS = {
  overview: 'M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z',
  games: 'M7 8h10a4 4 0 0 1 4 4v1.2a2.8 2.8 0 0 1-5.1 1.6L14.8 14H9.2l-1.1.8A2.8 2.8 0 0 1 3 13.2V12a4 4 0 0 1 4-4zM8 10.3v3.4M6.3 12h3.4M15.5 11h.01M17.5 13h.01',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  cloud: 'M7 18.5a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 18.2 9.8 4.35 4.35 0 0 1 17.5 18.5z',
  cloudOff: 'M7 18.5a4.5 4.5 0 0 1-.4-8.98M9.2 6.1A6 6 0 0 1 18.2 9.8a4.35 4.35 0 0 1 2.1 7.4M17.5 18.5H11M3 3l18 18',
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z',
  drive: 'M3 14.5 5.6 6h12.8L21 14.5V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 14.5h18M17 16.8h.01',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4.5V8.5h-4',
  upload: 'M12 16V5M7.5 9.5 12 5l4.5 4.5M5 20h14',
  history: 'M4 12a8 8 0 1 0 2.34-5.66M4 4.5v4h4M12 8v4l2.8 1.8',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  shield: 'M12 3l7 3v5.4c0 4.4-2.9 7.9-7 9.6-4.1-1.7-7-5.2-7-9.6V6zM8.8 12.1l2.2 2.2 4.3-4.5',
  alert: 'M12 4.2 2.9 19.5h18.2zM12 10v4.2M12 16.9v.1',
  play: 'M8 5.6v12.8l10.4-6.4z',
  pc: 'M3.5 5h17v11h-17zM8.5 20h7M12 16v4',
  search: 'M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6zM15.8 15.8 20 20',
  plus: 'M12 5v14M5 12h14',
  external: 'M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  back: 'M14.5 5.5 8 12l6.5 6.5',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14',
  doc: 'M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h4',
  code: 'M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5',
  heart: 'M12 20s-7.5-4.6-9-9.3C1.9 7 4 4.5 6.9 4.5c2 0 3.3 1.1 5.1 3 1.8-1.9 3.1-3 5.1-3 2.9 0 5 2.5 3.9 6.2C19.5 15.4 12 20 12 20z',
  info: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 11v5.2M12 7.8v.1',
  key: 'M14.5 13.5a5 5 0 1 0-4.6-3L3.5 17v3.5H7v-2h2v-2h2l1.4-1.4a5 5 0 0 0 2.1.4zM16.5 8.5h.01'
} as const

const FILLED = new Set<IconName>(['play', 'heart'])

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const filled = FILLED.has(name)
  return (
    <svg
      className={'icon' + (className ? ' ' + className : '')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/** The app icon: a floppy disk with a heart on its label. Same drawing as scripts/make-icons.mjs. */
export function BrandMark({ size = 26, tile = false }: { size?: number; tile?: boolean }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {tile && <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="#1a1d23" stroke="#2c313b" />}
      <g transform={tile ? 'translate(2.4 2.4) scale(0.8)' : undefined}>
        <path d="M5.4 2.6h11.1l4.1 4.1v12.5a2.2 2.2 0 0 1-2.2 2.2H5.4a2.2 2.2 0 0 1-2.2-2.2V4.8a2.2 2.2 0 0 1 2.2-2.2z" fill="var(--lime)" />
        <rect x="7.4" y="2.6" width="7.6" height="5" rx="0.8" fill="#11140d" />
        <rect x="11.8" y="3.5" width="1.8" height="3.1" rx="0.4" fill="var(--lime)" />
        <rect x="6.6" y="11.6" width="10.8" height="7.6" rx="1.3" fill="#f4f6f0" />
        <path d="M12 18s-2.9-1.8-3.4-3.6c-.4-1.4.4-2.4 1.5-2.4.8 0 1.3.4 1.9 1.1.7-.7 1.2-1.1 2-1.1 1.1 0 1.9 1 1.5 2.4C15 16.2 12 18 12 18z" fill="var(--heart)" />
      </g>
    </svg>
  )
}

export function ProviderIcon({ kind, size = 18 }: { kind?: ProviderKind; size?: number }) {
  return <Icon name={kind === 'local' ? 'drive' : kind ? 'cloud' : 'cloudOff'} size={size} />
}

export const PROVIDER_NAMES: Record<ProviderKind, string> = { gdrive: 'Google Drive', onedrive: 'OneDrive', local: 'Folder' }

/** Where backups go, as part of a sentence: "backed up to …". */
export const PROVIDER_PLACE: Record<ProviderKind, string> = { gdrive: 'Google Drive', onedrive: 'OneDrive', local: 'your backup folder' }

export const STORE_NAMES: Record<NonNullable<Game['store']>, string> = { steam: 'Steam', epic: 'Epic', gog: 'GOG', custom: 'Added by you' }

// ---- status ----

const STATUS: Record<GameStatus, { label: string; cls: string }> = {
  synced: { label: 'Backed up', cls: 'ok' },
  pending: { label: 'Waiting', cls: 'busy' },
  'backing-up': { label: 'Uploading…', cls: 'busy' },
  'cloud-newer': { label: 'Newer in cloud', cls: 'warn' },
  error: { label: 'Failed', cls: 'err' },
  never: { label: 'Not backed up yet', cls: 'muted' }
}

export function StatusPill({ game, running }: { game: Game; running?: boolean }) {
  if (running)
    return (
      <span className="pill play">
        <Icon name="play" size={11} /> Playing
      </span>
    )
  if (!game.tracked) return <span className="pill off">Off</span>
  const s = STATUS[game.status]
  return (
    <span className={`pill ${s.cls}`} title={game.error}>
      <i className="pill-dot" />
      {s.label}
    </span>
  )
}

export function Cover({ game, size = 'sm' }: { game: Game; size?: 'sm' | 'lg' }) {
  const [failed, setFailed] = useState(false)
  const hue = [...game.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  if (game.steamId && !failed) {
    return <img className={`cover ${size}`} src={coverUrl(game)} onError={() => setFailed(true)} alt="" />
  }
  return (
    <div className={`cover ${size} letter`} style={{ background: `linear-gradient(140deg, hsl(${hue} 32% 30%), hsl(${(hue + 50) % 360} 38% 16%))` }}>
      {game.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()}
    </div>
  )
}

export const coverUrl = (game: Game): string | undefined => (game.steamId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.steamId}/header.jpg` : undefined)

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} title={label} className={'toggle' + (on ? ' on' : '')} onClick={(e) => (e.stopPropagation(), onChange(!on))}>
      <span />
    </button>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
}

export function useAction(): [(fn: () => Promise<unknown>) => Promise<void>, string | undefined, boolean] {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(undefined)
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  return [run, error, busy]
}

// ---- dialogs ----

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <button className="icon-btn modal-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
        {children}
      </div>
    </div>,
    document.body
  )
}

interface Ask {
  title: string
  message: ReactNode
  confirm: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

let ask: ((a: Ask) => void) | undefined

/** An in-app replacement for window.confirm(). */
export function confirmDialog(opts: Omit<Ask, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => (ask ? ask({ ...opts, resolve }) : resolve(window.confirm(opts.title))))
}

export function DialogHost() {
  const [current, setCurrent] = useState<Ask>()
  useEffect(() => {
    ask = setCurrent
    return () => {
      ask = undefined
    }
  }, [])
  if (!current) return null
  const done = (ok: boolean): void => {
    current.resolve(ok)
    setCurrent(undefined)
  }
  return (
    <Modal title={current.title} onClose={() => done(false)}>
      <h2 className="modal-title">{current.title}</h2>
      <div className="modal-body">{current.message}</div>
      <div className="modal-actions">
        {/* Enter should never confirm something destructive by accident. */}
        <button autoFocus={current.danger} className="btn ghost" onClick={() => done(false)}>
          Cancel
        </button>
        <button autoFocus={!current.danger} className={'btn ' + (current.danger ? 'danger' : 'primary')} onClick={() => done(true)}>
          {current.confirm}
        </button>
      </div>
    </Modal>
  )
}
