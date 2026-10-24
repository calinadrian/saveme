import { useState } from 'react'
import type { Game, GameStatus } from '../../shared/types'

const STATUS: Record<GameStatus, { label: string; cls: string }> = {
  synced: { label: 'Backed up', cls: 'ok' },
  pending: { label: 'Waiting', cls: 'busy' },
  'backing-up': { label: 'Uploading…', cls: 'busy' },
  'cloud-newer': { label: 'Newer in cloud', cls: 'warn' },
  error: { label: 'Error', cls: 'err' },
  never: { label: 'Not backed up', cls: 'muted' }
}

export function StatusPill({ game, running }: { game: Game; running?: boolean }) {
  if (running) return <span className="pill play">● Playing</span>
  if (!game.tracked) return <span className="pill muted">Off</span>
  const s = STATUS[game.status]
  return (
    <span className={`pill ${s.cls}`} title={game.error}>
      {s.label}
    </span>
  )
}

export function Cover({ game, size = 'sm' }: { game: Game; size?: 'sm' | 'lg' }) {
  const [failed, setFailed] = useState(false)
  const hue = [...game.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  if (game.steamId && !failed) {
    return <img className={`cover ${size}`} src={`https://cdn.cloudflare.steamstatic.com/steam/apps/${game.steamId}/header.jpg`} onError={() => setFailed(true)} alt="" />
  }
  return (
    <div className={`cover ${size} letter`} style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 38%), hsl(${(hue + 40) % 360} 60% 22%))` }}>
      {game.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()}
    </div>
  )
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={'toggle' + (on ? ' on' : '')} onClick={(e) => (e.stopPropagation(), onChange(!on))}>
      <span />
    </button>
  )
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
