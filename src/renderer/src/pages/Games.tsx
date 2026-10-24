import { useMemo, useState } from 'react'
import type { AppState } from '../../../shared/types'
import type { Navigate } from '../App'
import { api, formatBytes, timeAgo } from '../api'
import { Cover, StatusPill, Toggle, useAction } from '../components'

type Filter = 'all' | 'on' | 'off' | 'attention'

export function Games({ state, navigate }: { state: AppState; navigate: Navigate }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [adding, setAdding] = useState(false)
  const [run, error] = useAction()

  const games = useMemo(() => {
    const q = query.trim().toLowerCase()
    return state.games.filter((g) => {
      if (q && !g.name.toLowerCase().includes(q)) return false
      if (filter === 'on') return g.tracked
      if (filter === 'off') return !g.tracked
      if (filter === 'attention') return g.status === 'cloud-newer' || g.status === 'error'
      return true
    })
  }, [state.games, query, filter])

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Games</h1>
          <p className="sub">{state.scanning ? state.scanProgress : `${state.games.length} games with saves on this PC`}</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setAdding(true)}>Add game</button>
          <button className="btn" disabled={state.scanning} onClick={() => run(() => api.scan())}>
            {state.scanning ? 'Scanning…' : 'Scan again'}
          </button>
        </div>
      </header>
      {error && <div className="alert err">{error}</div>}
      {adding && <AddGame onClose={() => setAdding(false)} />}

      <div className="toolbar">
        <input className="search" placeholder="Search games" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="segmented">
          {(['all', 'on', 'off', 'attention'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {{ all: 'All', on: 'Backing up', off: 'Off', attention: 'Needs a look' }[f]}
            </button>
          ))}
        </div>
      </div>

      <div className="card list">
        {games.length === 0 && <p className="muted pad">{state.scanning ? 'Looking for saves…' : 'No games match.'}</p>}
        {games.map((g) => (
          <div key={g.id} className="row clickable" onClick={() => navigate(`/game/${g.id}`)}>
            <Cover game={g} />
            <div className="row-main">
              <strong>{g.name}</strong>
              <span className="muted">
                {g.store && g.store !== 'custom' ? <span className="store">{g.store}</span> : null}
                {g.roots.length ? `${g.fileCount} files · ${formatBytes(g.sizeBytes)}` : 'Only in the cloud'} · backed up {timeAgo(g.lastBackupAt)}
              </span>
            </div>
            {g.status === 'cloud-newer' && g.newerSnapshot && (
              <div className="inline-actions" onClick={(e) => e.stopPropagation()}>
                <button className="btn small primary" disabled={state.running.includes(g.id)} onClick={() => run(() => api.restore(g.id, g.newerSnapshot!.id))}>
                  Restore from {g.newerSnapshot.machine}
                </button>
                {g.roots.length > 0 && (
                  <button className="btn small" onClick={() => run(() => api.keepLocal(g.id))}>
                    Keep this PC's
                  </button>
                )}
              </div>
            )}
            <StatusPill game={g} running={state.running.includes(g.id)} />
            <Toggle on={g.tracked} label={`Back up ${g.name}`} onChange={(v) => run(() => api.setTracked(g.id, v))} />
          </div>
        ))}
      </div>
    </div>
  )
}

function AddGame({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [run, error, busy] = useAction()
  return (
    <div className="card form">
      <h2>Add a game</h2>
      <p className="muted">For games SaveMe didn't find: pick the folder where the game keeps its saves.</p>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Game" />
      </label>
      <label>
        Save folder
        <div className="picker">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Users\…\Saved Games\MyGame" />
          <button className="btn" onClick={async () => setFolder((await api.pickFolder('Save folder')) ?? folder)}>Browse</button>
        </div>
      </label>
      {error && <div className="alert err">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name || !folder || busy} onClick={() => run(async () => (await api.addCustomGame(name, folder), onClose()))}>
          Add and back up
        </button>
      </div>
    </div>
  )
}
