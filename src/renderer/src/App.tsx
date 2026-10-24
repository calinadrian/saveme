import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppState, UpdateState } from '../../shared/types'
import { api, plural, useAppState, useUpdate } from './api'
import { BrandMark, DialogHost, Icon, IconName, Modal, Spinner } from './components'
import { Dashboard } from './pages/Dashboard'
import { Games, LibraryView } from './pages/Games'
import { GameDetail } from './pages/GameDetail'
import { Settings } from './pages/Settings'
import { Onboarding } from './pages/Onboarding'
import { protection } from '../../shared/protection'

export type Navigate = (route: string) => void

export function App() {
  const [load, retry] = useAppState()
  const state = load.status === 'ready' ? load.value : undefined
  const update = useUpdate()
  const [route, setRoute] = useState('/')
  const [skipOnboarding, setSkipOnboarding] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [offered, setOffered] = useState<string>()
  const content = useRef<HTMLElement>(null)
  const library = useRef<LibraryView>({ query: '', filter: 'all', scrollTop: 0 })
  const currentRoute = useRef(route)
  currentRoute.current = route
  const navigate = useCallback((to: string): void => {
    if (currentRoute.current === '/games') library.current.scrollTop = content.current?.scrollTop ?? 0
    setRoute(to)
  }, [])

  useEffect(() => api.onNavigate(navigate), [navigate])
  useLayoutEffect(() => {
    if (route === '/games' || !content.current) return
    content.current.scrollTop = 0
    const heading = content.current.querySelector<HTMLElement>('h1')
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }) }
  }, [route, load.status, skipOnboarding])
  // A downloaded update opens its dialog once per version; after that it waits in the sidebar.
  useEffect(() => {
    if (update.status === 'ready' && update.version && offered !== update.version) {
      setOffered(update.version)
      setUpdateOpen(true)
    }
    if (update.status !== 'ready' && updateOpen) setUpdateOpen(false)
  }, [update.status, update.version])

  if (!state) {
    return (
      <div className="boot">
        <TitleBar />
        <div className="loading" role={load.status === 'error' ? 'alert' : 'status'}>
          {load.status === 'error' ? <div className="boot-error"><h1>Could not open SaveMe</h1><p>{load.error}</p><button className="btn primary" onClick={retry}>Retry</button></div> : <><Spinner size={22} /><span>Opening SaveMe…</span></>}
        </div>
      </div>
    )
  }

  const dialogs = (
    <>
      {updateOpen && <UpdateDialog update={update} auto={state.settings.autoUpdate} onClose={() => setUpdateOpen(false)} />}
      <DialogHost />
    </>
  )

  if (!state.provider.connected && !state.settings.provider && !skipOnboarding) {
    return (
      <div className="boot">
        <TitleBar />
        <Onboarding state={state} onDone={() => setSkipOnboarding(true)} />
        {dialogs}
      </div>
    )
  }

  const page = route.startsWith('/game/') ? (
    <GameDetail key={route} state={state} id={route.slice(6)} navigate={navigate} />
  ) : route === '/games' ? (
    <Games state={state} navigate={navigate} view={library} />
  ) : route === '/settings' ? (
    <Settings state={state} update={update} onOpenUpdate={() => setUpdateOpen(true)} />
  ) : (
    <Dashboard state={state} navigate={navigate} />
  )

  const attention = state.games.filter((g) => g.status === 'cloud-newer' || g.status === 'error').length
  const nav: { to: string; label: string; icon: IconName; badge?: number }[] = [
    { to: '/', label: 'Overview', icon: 'overview' },
    { to: '/games', label: 'Games', icon: 'games', badge: attention || undefined },
    { to: '/settings', label: 'Settings', icon: 'settings' }
  ]
  const active = (to: string): boolean => (to === '/' ? route === '/' : route.startsWith(to) || (to === '/games' && route.startsWith('/game/')))

  return (
    <div className="shell">
      <TitleBar />
      <aside className="sidebar">
        <nav aria-label="Main">
          {nav.map((n) => (
            <button key={n.to} className={'nav-item' + (active(n.to) ? ' active' : '')} aria-label={n.label} title={n.label} aria-current={active(n.to) ? 'page' : undefined} onClick={() => navigate(n.to)}>
              <Icon name={n.icon} />
              <span className="nav-label">{n.label}</span>
              {n.badge && (
                <span className="badge" title={`${plural(n.badge, 'game')} need a look`}>
                  {n.badge}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <SyncIndicator state={state} onClick={() => navigate(!state.provider.connected ? '/settings' : attention ? '/games' : '/')} />
          <VersionChip update={update} onOpen={() => setUpdateOpen(true)} onCheck={() => void api.checkForUpdate()} />
        </div>
      </aside>
      <main ref={content} className="content" aria-label="SaveMe workspace">
        {state.recoveryWarning && <div className="alert warn" role="alert">{state.recoveryWarning}</div>}
        {page}
      </main>
      {dialogs}
    </div>
  )
}

/** Draggable strip under the native window buttons (titleBarOverlay in index.ts). */
function TitleBar() {
  return (
    <header className="titlebar">
      <BrandMark size={20} />
      <span className="wordmark">
        Save<b>Me</b>
      </span>
    </header>
  )
}

function SyncIndicator({ state, onClick }: { state: AppState; onClick: () => void }) {
  const { kind, label } = protection(state)
  const cls = kind === 'protected' ? 'ok' : ['uploading', 'restoring', 'storage', 'scanning'].includes(kind) ? 'busy' : 'off'
  const short = kind === 'unprotected' ? 'Backup needed' : kind === 'waiting' ? 'Waiting to retry' : kind === 'protected' ? 'Backed up' : kind === 'paused' ? 'Backups paused' : kind === 'attention' ? 'Needs a look' : kind === 'uploading' ? 'Backing up…' : kind === 'restoring' ? 'Restoring…' : kind === 'storage' ? 'Changing storage…' : kind === 'scanning' ? 'Scanning…' : kind === 'empty' ? 'No games yet' : 'Playing'
  return (
    <button className={`sync ${cls}`} title={label} aria-label={label} onClick={onClick}>
      {cls === 'busy' ? <Spinner size={12} /> : <i className="sync-dot" />}
      <span>{short}</span>
    </button>
  )
}

function VersionChip({ update, onOpen, onCheck }: { update: UpdateState; onOpen: () => void; onCheck: () => void }) {
  if (update.status === 'ready')
    return (
      <button className="version ready" onClick={onOpen} title="See what's new and install">
        <Icon name="download" size={14} /> Update to {update.version}
      </button>
    )
  const busy = update.status === 'checking' || update.status === 'downloading'
  return (
    <button className="version" disabled={update.status === 'dev' || busy} onClick={onCheck} title={update.status === 'dev' ? 'Development copy: no updates' : 'Check for updates'}>
      {busy ? (update.status === 'downloading' ? `Downloading update… ${update.percent ?? 0}%` : 'Checking for updates…') : `SaveMe ${update.current || ''}`}
    </button>
  )
}

function UpdateDialog({ update, auto, onClose }: { update: UpdateState; auto: boolean; onClose: () => void }) {
  const notes = update.notes ?? []
  return (
    <Modal title="Update ready" onClose={onClose}>
      <div className="update-head">
        <BrandMark size={44} tile />
        <div>
          <h2 className="modal-title">SaveMe {update.version} is ready</h2>
          <p className="muted">You have {update.current}. It installs in a few seconds and SaveMe reopens.</p>
        </div>
      </div>
      {notes.length > 0 && (
        <div className="update-notes">
          {notes.map((s, i) => (
            <section key={i}>
              {s.title && <h3>{s.title}</h3>}
              <ul>
                {s.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Later
        </button>
        <button autoFocus className="btn primary" disabled={update.status !== 'ready'} onClick={() => void api.installUpdate()}>
          Restart and update
        </button>
      </div>
      <p className="modal-foot">Your games, backups and settings stay as they are. If you choose later, SaveMe updates itself {auto ? "the next time it's idle in the tray, or " : ''}when it quits.</p>
    </Modal>
  )
}
