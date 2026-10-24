import { RefObject, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppState, Game, SnapshotMeta } from '../../../shared/types'
import type { Navigate } from '../App'
import { api, formatBytes, plural, timeAgo } from '../api'
import { AsyncToggle, confirmDialog, Cover, Icon, InlineError, Modal, StatusPill, STORE_NAMES, useAction } from '../components'
import { Empty } from './Dashboard'

type Filter = 'all' | 'on' | 'off' | 'attention'
export interface LibraryView { query: string; filter: Filter; scrollTop: number; focusedGame?: string }

const FILTERS: { id: Filter; label: string; test: (g: Game) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'on', label: 'Auto backup on', test: (g) => g.tracked },
  { id: 'off', label: 'Off', test: (g) => !g.tracked },
  { id: 'attention', label: 'Needs a look', test: (g) => g.status === 'cloud-newer' || g.status === 'error' }
]

export function Games({ state, navigate, view }: { state: AppState; navigate: Navigate; view: RefObject<LibraryView> }) {
  const [query, setQuery] = useState(view.current.query)
  const [filter, setFilter] = useState<Filter>(view.current.filter)
  const root = useRef<HTMLDivElement>(null)
  const [adding, setAdding] = useState(false)
  const [run, error, busy] = useAction()
  useLayoutEffect(() => {
    const scroll = root.current?.closest<HTMLElement>('.content')
    if (scroll) scroll.scrollTop = view.current.scrollTop
    const button = [...(root.current?.querySelectorAll<HTMLButtonElement>('.game-open') ?? [])].find(el => el.dataset.game === view.current.focusedGame)
    button?.focus({ preventScroll: true })
  }, [view])

  const games = useMemo(() => {
    const q = query.trim().toLowerCase()
    const test = FILTERS.find((f) => f.id === filter)!.test
    return state.games.filter((g) => (!q || g.name.toLowerCase().includes(q)) && test(g))
  }, [state.games, query, filter])

  return (
    <div ref={root} className="page">
      <header className="page-head">
        <div>
          <h1>Games</h1>
          <p className="sub">{state.scanning ? state.scanProgress : `${plural(state.games.length, 'game')} with saves on ${state.machine}`}</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add game
          </button>
          <button className="btn" disabled={busy || state.scanning} onClick={() => run(() => api.scan())}>
            <Icon name="refresh" size={16} className={state.scanning ? 'spin' : undefined} /> {state.scanning ? 'Scanning…' : 'Scan again'}
          </button>
        </div>
      </header>
      <InlineError error={error} />
      {adding && <AddGame onClose={() => setAdding(false)} />}

      <div className="toolbar">
        <label className="search">
          <Icon name="search" size={16} />
          <input placeholder="Search games" value={query} onChange={(e) => { setQuery(e.target.value); view.current.query = e.target.value }} aria-label="Search games" />
        </label>
        <div className="segmented" role="group" aria-label="Filter games">
          {FILTERS.map((f) => {
            const count = state.games.filter(f.test).length
            if (f.id === 'attention' && !count) return null
            return (
              <button key={f.id} aria-pressed={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => { setFilter(f.id); view.current.filter = f.id }}>
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
          <div key={g.id} className={'row game-row' + (g.tracked ? '' : ' is-off')}>
            <button className="game-open" data-game={g.id} aria-label={`Open ${g.name} details`} onClick={() => { view.current.focusedGame = g.id; navigate(`/game/${g.id}`) }}>
            <Cover game={g} />
            <span className="row-main">
              <strong>{g.name}</strong>
              <span className="muted">
                {g.store && <span className="store">{STORE_NAMES[g.store]}</span>}
                {g.roots.length ? `${formatBytes(g.sizeBytes)} · ${plural(g.fileCount, 'file')}` : 'Only in the cloud'}
                {g.lastBackupAt ? ` · backed up ${timeAgo(g.lastBackupAt)}` : ''}
              </span>
            </span>
            </button>
            {g.status === 'cloud-newer' && g.newerSnapshot && (
              <div className="inline-actions" onClick={(e) => e.stopPropagation()}>
                <button className="btn small primary" disabled={busy || !!state.operation || state.running.includes(g.id)} onClick={() => run(async () => (await confirmRestore(g, g.newerSnapshot!, state.machine)) && api.restore(g.id, g.newerSnapshot!.id))}>
                  Review cloud save
                </button>
                {g.roots.length > 0 && (
                  <button className="btn small" disabled={busy || !!state.operation} onClick={() => run(async () => { if (await confirmKeepLocal(g)) await api.keepLocal(g.id) })}>
                    Keep this PC's
                  </button>
                )}
              </div>
            )}
            <span className="status-cell">
              <StatusPill game={g} running={state.running.includes(g.id)} />
            </span>
            <AsyncToggle value={g.tracked} label={`Automatic backup for ${g.name}`} onChange={v => api.setTracked(g.id, v)} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Shared with GameDetail: restoring replaces the save on this PC, so always ask first. */
export function confirmRestore(game: Game, snapshot: SnapshotMeta, machine: string): Promise<boolean> {
  return confirmDialog({
    title: `Restore ${game.name}?`,
    message: (
      <><dl className="restore-facts"><dt>Selected version</dt><dd>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.machine}</dd><dt>Destination PC</dt><dd>{machine}</dd><dt>Last confirmed backup on this PC</dt><dd>{game.lastBackupAt ? new Date(game.lastBackupAt).toLocaleString() : 'No confirmed backup yet'}</dd></dl><p>This replaces {game.name}’s current files on this PC. Your current files are preserved before replacement so you can recover them.</p></>
    ),
    confirm: 'Restore this version',
    danger: true
  })
}

export function confirmKeepLocal(game: Game): Promise<boolean> {
  return confirmDialog({ title: `Keep this PC’s ${game.name} save?`, message: <p>Your local files will be uploaded as a new backup. Existing cloud versions stay in history subject to your retention settings. This does not download the other PC’s files.</p>, confirm: 'Keep this PC’s save', danger: true })
}

function AddGame({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [run, error, busy] = useAction()
  const field = useId()
  const [adding, setAdding] = useState(false)
  return (
    <Modal title="Add a game" onClose={onClose} dismissible={!busy}>
      <h2 className="modal-title">Add a game</h2>
      <p className="muted">For a game SaveMe didn't find on its own. Choose the folder where it keeps its saves; SaveMe backs up everything inside.</p>
      <form className="form" aria-busy={busy} onSubmit={e => { e.preventDefault(); if (!busy && name.trim() && folder.trim()) void run(async () => { setAdding(true); try { await api.addCustomGame(name.trim(), folder.trim()); onClose() } finally { setAdding(false) } }) }}>
        <label>
          Name
          <input autoFocus required disabled={busy} value={name} onChange={(e) => setName(e.target.value)} placeholder="My Game" />
        </label>
        <div className="field">
          <label htmlFor={field}>Save folder</label>
          <div className="picker">
            <input id={field} required disabled={busy} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Users\…\Saved Games\MyGame" />
            <button type="button" className="btn" disabled={busy} onClick={() => run(async () => setFolder((await api.pickFolder('Save folder')) ?? folder))}>
              <Icon name="folder" size={16} /> Browse
            </button>
          </div>
        </div>
        <InlineError error={error} />
        <span className="muted small" role="status">{busy ? adding ? 'Adding game…' : 'Choose a folder in the dialog…' : ''}</span>
      <div className="modal-actions">
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!name.trim() || !folder.trim() || busy}>
          {busy && adding ? 'Adding…' : 'Add and back up'}
        </button>
      </div>
      </form>
    </Modal>
  )
}
