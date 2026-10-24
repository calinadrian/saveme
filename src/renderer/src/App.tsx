import { useEffect, useState } from 'react'
import { api, useAppState } from './api'
import { Dashboard } from './pages/Dashboard'
import { Games } from './pages/Games'
import { GameDetail } from './pages/GameDetail'
import { Settings } from './pages/Settings'
import { Onboarding } from './pages/Onboarding'

export type Navigate = (route: string) => void

export function App() {
  const state = useAppState()
  const [route, setRoute] = useState('/')
  const [skipOnboarding, setSkipOnboarding] = useState(false)

  useEffect(() => api.onNavigate(setRoute), [])

  if (!state) return <div className="loading">Loading…</div>

  if (!state.provider.connected && !state.settings.provider && !skipOnboarding) {
    return <Onboarding state={state} onDone={() => setSkipOnboarding(true)} />
  }

  const page = route.startsWith('/game/') ? (
    <GameDetail state={state} id={route.slice(6)} navigate={setRoute} />
  ) : route === '/games' ? (
    <Games state={state} navigate={setRoute} />
  ) : route === '/settings' ? (
    <Settings state={state} />
  ) : (
    <Dashboard state={state} navigate={setRoute} />
  )

  const attention = state.games.filter((g) => g.status === 'cloud-newer' || g.status === 'error').length
  const nav = [
    { to: '/', label: 'Overview', icon: '◎' },
    { to: '/games', label: 'Games', icon: '▦', badge: attention || undefined },
    { to: '/settings', label: 'Settings', icon: '⚙' }
  ]
  const active = (to: string): boolean => (to === '/' ? route === '/' : route.startsWith(to) || (to === '/games' && route.startsWith('/game/')))

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">S</span>
          <span>SaveMe</span>
        </div>
        <nav>
          {nav.map((n) => (
            <button key={n.to} className={'nav-item' + (active(n.to) ? ' active' : '')} onClick={() => setRoute(n.to)}>
              <span className="nav-icon">{n.icon}</span>
              {n.label}
              {n.badge && <span className="badge">{n.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <SyncIndicator queue={state.queue.length} connected={state.provider.connected} scanning={state.scanning} />
        </div>
      </aside>
      <main className="content">{page}</main>
    </div>
  )
}

function SyncIndicator({ queue, connected, scanning }: { queue: number; connected: boolean; scanning: boolean }) {
  if (!connected) return <div className="sync off">● Not connected</div>
  if (scanning) return <div className="sync busy">● Scanning…</div>
  if (queue) return <div className="sync busy">● Backing up {queue}…</div>
  return <div className="sync ok">● All saves backed up</div>
}
