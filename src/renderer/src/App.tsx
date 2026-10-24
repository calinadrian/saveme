import { useEffect, useState } from 'react'
import type { AppState, UpdateState } from '../../shared/types'
import { api, plural, useAppState, useUpdate } from './api'
import { BrandMark, DialogHost, Icon, IconName, Modal, Spinner } from './components'
import { Dashboard } from './pages/Dashboard'
import { Games } from './pages/Games'
import { GameDetail } from './pages/GameDetail'
import { Settings } from './pages/Settings'
import { Onboarding } from './pages/Onboarding'

export type Navigate = (route: string) => void

export function App() {
  const state = useAppState()
  const update = useUpdate()
  const [route, setRoute] = useState('/')
  const [skipOnboarding, setSkipOnboarding] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [offered, setOffered] = useState<string>()

  useEffect(() => api.onNavigate(setRoute), [])
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
        <div className="loading">
          <Spinner size={22} />
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
    <GameDetail key={route} state={state} id={route.slice(6)} navigate={setRoute} />
  ) : route === '/games' ? (
    <Games state={state} navigate={setRoute} />
  ) : route === '/settings' ? (
    <Settings state={state} update={update} onOpenUpdate={() => setUpdateOpen(true)} />
  ) : (
    <Dashboard state={state} navigate={setRoute} />
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
            <button key={n.to} className={'nav-item' + (active(n.to) ? ' active' : '')} aria-current={active(n.to) ? 'page' : undefined} onClick={() => setRoute(n.to)}>
              <Icon name={n.icon} />
              {n.label}
              {n.badge && (
                <span className="badge" title={`${plural(n.badge, 'game')} need a look`}>
                  {n.badge}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <SyncIndicator state={state} onClick={() => setRoute(!state.provider.connected ? '/settings' : attention ? '/games' : '/')} />
          <VersionChip update={update} onOpen={() => setUpdateOpen(true)} onCheck={() => void api.checkForUpdate()} />
        </div>
      </aside>
      <main className="content">{page}</main>
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
  const queue = state.queue.length
  // Same rule as the overview: a failed backup or a newer save elsewhere isn't "all backed up".
  const attention = state.games.filter((g) => g.status === 'cloud-newer' || g.status === 'error').length
  const [cls, label] = !state.provider.connected
    ? ['off', 'Backups paused']
    : state.scanning
      ? ['busy', 'Scanning games…']
      : queue
        ? ['busy', `Backing up ${plural(queue, 'game')}…`]
        : attention
          ? ['off', `${plural(attention, 'game')} ${attention === 1 ? 'needs' : 'need'} a look`]
          : ['ok', 'All saves backed up']
  return (
    <button className={`sync ${cls}`} onClick={onClick}>
      {cls === 'busy' ? <Spinner size={12} /> : <i className="sync-dot" />}
      <span>{label}</span>
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
