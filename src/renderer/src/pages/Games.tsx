import { useMemo, useState } from 'react'
import type { AppState, Game } from '../../../shared/types'
import type { Navigate } from '../App'
import { api, formatBytes, plural, timeAgo } from '../api'
import { confirmDialog, Cover, Icon, Modal, StatusPill, STORE_NAMES, Toggle, useAction } from '../components'
import { Empty } from './Dashboard'

type Filter = 'all' | 'on' | 'off' | 'attention'

const FILTERS: { id: Filter; label: string; test: (g: Game) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'on', label: 'Backing up', test: (g) => g.tracked },
  { id: 'off', label: 'Off', test: (g) => !g.tracked },
  { id: 'attention', label: 'Needs a look', test: (g) => g.status === 'cloud-newer' || g.status === 'error' }
]

export function Games({ state, navigate }: { state: AppState; navigate: Navigate }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [adding, setAdding] = useState(false)
  const [run, error] = useAction()

  const games = useMemo(() => {
    const q = query.trim().toLowerCase()
    const test = FILTERS.find((f) => f.id === filter)!.test
    return state.games.filter((g) => (!q || g.name.toLowerCase().includes(q)) && test(g))
  }, [state.games, query, filter])

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Games</h1>
          <p className="sub">{state.scanning ? state.scanProgress : `${plural(state.games.length, 'game')} with saves on ${state.machine}`}</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add game
          </button>
          <button className="btn" disabled={state.scanning} onClick={() => run(() => api.scan())}>
            <Icon name="refresh" size={16} className={state.scanning ? 'spin' : undefined} /> {state.scanning ? 'Scanning…' : 'Scan again'}
          </button>
        </div>
      </header>
      {error && <div className="alert err">{error}</div>}
      {adding && <AddGame onClose={() => setAdding(false)} />}

      <div className="toolbar">
        <label className="search">
          <Icon name="search" size={16} />
          <input placeholder="Search games" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search games" />
        </label>
        <div className="segmented" role="tablist" aria-label="Filter games">
          {FILTERS.map((f) => {
            const count = state.games.filter(f.test).length
            if (f.id === 'attention' && !count) return null
            return (
              <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
                {f.label}
                <span className="count">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="card list">
        <div className="list-head" aria-hidden="true">
          <span>Game</span>
          <span>Status</span>
          <span>Auto backup</span>
        </div>
        {games.length === 0 &&
          (state.scanning ? (
            <Empty icon="search" title="Looking for saves…">
              {state.scanProgress}
            </Empty>
          ) : query || filter !== 'all' ? (
            <Empty icon="search" title="No games match">
              Try another name or filter.
            </Empty>
          ) : (
            <Empty icon="games" title="No games found yet">
              Scan again after installing a game, or add one yourself.
            </Empty>
          ))}
        {games.map((g) => (
          <div key={g.id} className={'row clickable game-row' + (g.tracked ? '' : ' is-off')} onClick={() => navigate(`/game/${g.id}`)}>
            <Cover game={g} />
            <div className="row-main">
              <strong>{g.name}</strong>
              <span className="muted">
                {g.store && <span className="store">{STORE_NAMES[g.store]}</span>}
                {g.roots.length ? `${formatBytes(g.sizeBytes)} · ${plural(g.fileCount, 'file')}` : 'Only in the cloud'}
                {g.lastBackupAt ? ` · backed up ${timeAgo(g.lastBackupAt)}` : ''}
              </span>
            </div>
            {g.status === 'cloud-newer' && g.newerSnapshot && (
              <div className="inline-actions" onClick={(e) => e.stopPropagation()}>
                <button className="btn small primary" disabled={state.running.includes(g.id)} onClick={() => run(async () => (await confirmRestore(g)) && api.restore(g.id, g.newerSnapshot!.id))}>
                  Use {g.newerSnapshot.machine}'s save
                </button>
                {g.roots.length > 0 && (
                  <button className="btn small" onClick={() => run(() => api.keepLocal(g.id))}>
                    Keep this PC's
                  </button>
                )}
              </div>
            )}
            <span className="status-cell">
              <StatusPill game={g} running={state.running.includes(g.id)} />
            </span>
            <Toggle on={g.tracked} label={`${g.tracked ? 'Turn off' : 'Turn on'} automatic backup for ${g.name}`} onChange={(v) => run(() => api.setTracked(g.id, v))} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Shared with GameDetail: restoring replaces the save on this PC, so always ask first. */
export function confirmRestore(game: Game, label = `the save from ${game.newerSnapshot?.machine}`): Promise<boolean> {
  return confirmDialog({
    title: `Restore ${game.name}?`,
    message: (
      <p>
        This replaces the save on this PC with {label}. Your current save is backed up first, so you can go back to it from the version history.
      </p>
    ),
    confirm: 'Restore'
  })
}

function AddGame({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [run, error, busy] = useAction()
  return (
    <Modal title="Add a game" onClose={onClose}>
      <h2 className="modal-title">Add a game</h2>
      <p className="muted">For a game SaveMe didn't find on its own. Choose the folder where it keeps its saves; SaveMe backs up everything inside.</p>
      <div className="form">
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="My Game" />
        </label>
        <label>
          Save folder
          <div className="picker">
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Users\…\Saved Games\MyGame" />
            <button className="btn" onClick={async () => setFolder((await api.pickFolder('Save folder')) ?? folder)}>
              <Icon name="folder" size={16} /> Browse
            </button>
          </div>
        </label>
        {error && <div className="alert err">{error}</div>}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!name.trim() || !folder.trim() || busy} onClick={() => run(async () => (await api.addCustomGame(name.trim(), folder.trim()), onClose()))}>
          Add and back up
        </button>
      </div>
    </Modal>
  )
}
