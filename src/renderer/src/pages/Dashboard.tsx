import type { AppState } from '../../../shared/types'
import type { Navigate } from '../App'
import { api, formatBytes, timeAgo } from '../api'
import { Cover, StatusPill, useAction } from '../components'

const PROVIDER_NAMES = { gdrive: 'Google Drive', onedrive: 'OneDrive', local: 'Local folder' }

export function Dashboard({ state, navigate }: { state: AppState; navigate: Navigate }) {
  const [run, error, busy] = useAction()
  const tracked = state.games.filter((g) => g.tracked)
  const protectedCount = tracked.filter((g) => g.status === 'synced').length
  const attention = state.games.filter((g) => g.status === 'cloud-newer' || g.status === 'error')
  const lastBackup = tracked.map((g) => g.lastBackupAt).filter(Boolean).sort().pop()
  const recent = [...tracked].filter((g) => g.lastBackupAt).sort((a, b) => (b.lastBackupAt! > a.lastBackupAt! ? 1 : -1)).slice(0, 5)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="sub">{state.machine} · {state.provider.kind ? PROVIDER_NAMES[state.provider.kind] : 'no storage'}{state.provider.account ? ` · ${state.provider.account}` : ''}</p>
        </div>
        <button className="btn primary" disabled={busy || !state.provider.connected} onClick={() => run(() => api.backupAll())}>
          Back up all now
        </button>
      </header>
      {error && <div className="alert err">{error}</div>}
      {!state.provider.connected && (
        <div className="alert warn">
          Cloud storage isn't connected, so nothing is being backed up. <button className="link" onClick={() => navigate('/settings')}>Connect storage</button>
        </div>
      )}

      <section className="grid-3">
        <StorageCard state={state} />
        <div className="card stat">
          <span className="stat-label">Games protected</span>
          <span className="stat-value">
            {protectedCount}
            <small> / {tracked.length}</small>
          </span>
          <span className="stat-foot">{state.games.length - tracked.length} found but turned off</span>
        </div>
        <div className="card stat">
          <span className="stat-label">Last backup</span>
          <span className="stat-value">{timeAgo(lastBackup)}</span>
          <span className="stat-foot">{state.queue.length ? `${state.queue.length} in queue` : state.running.length ? `Watching ${state.running.length} running game` : 'Waiting for you to play'}</span>
        </div>
      </section>

      {attention.length > 0 && (
        <section className="card">
          <h2>Needs a look</h2>
          {attention.map((g) => (
            <button key={g.id} className="row clickable" onClick={() => navigate(`/game/${g.id}`)}>
              <Cover game={g} />
              <div className="row-main">
                <strong>{g.name}</strong>
                <span className="muted">{g.status === 'cloud-newer' ? `Newer save from ${g.newerSnapshot?.machine}, ${timeAgo(g.newerSnapshot?.createdAt)}` : g.error}</span>
              </div>
              <StatusPill game={g} />
            </button>
          ))}
        </section>
      )}

      <section className="grid-2">
        <div className="card">
          <h2>Recently backed up</h2>
          {recent.length === 0 && <p className="muted">{state.scanning ? state.scanProgress : 'Nothing yet. Backups start right after a game closes.'}</p>}
          {recent.map((g) => (
            <button key={g.id} className="row clickable" onClick={() => navigate(`/game/${g.id}`)}>
              <Cover game={g} />
              <div className="row-main">
                <strong>{g.name}</strong>
                <span className="muted">{formatBytes(g.sizeBytes)} · {timeAgo(g.lastBackupAt)}</span>
              </div>
              <StatusPill game={g} running={state.running.includes(g.id)} />
            </button>
          ))}
        </div>
        <div className="card">
          <h2>Activity</h2>
          <ul className="activity">
            {state.activity.slice(0, 12).map((a, i) => (
              <li key={i} className={a.kind}>
                <span className="dot" />
                <span className="act-msg">{a.message}</span>
                <span className="act-time">{timeAgo(a.at)}</span>
              </li>
            ))}
            {!state.activity.length && <li className="muted">No activity yet.</li>}
          </ul>
        </div>
      </section>
    </div>
  )
}

function StorageCard({ state }: { state: AppState }) {
  const q = state.quota
  const total = q?.totalBytes
  const used = q?.usedBytes ?? 0
  const mine = Math.min(state.saveMeBytes, used || state.saveMeBytes)
  const pct = (n: number): string => (total ? `${Math.max(0.5, (n / total) * 100)}%` : '0%')
  return (
    <div className="card stat storage">
      <span className="stat-label">Cloud storage</span>
      <span className="stat-value">
        {total ? formatBytes(total - used) : '–'}
        <small> free</small>
      </span>
      <div className="bar" title={total ? `${formatBytes(used)} of ${formatBytes(total)} used` : 'Unknown'}>
        <span className="seg mine" style={{ width: pct(mine) }} />
        <span className="seg other" style={{ width: pct(Math.max(0, used - mine)) }} />
      </div>
      <div className="legend">
        <span><i className="mine" /> SaveMe {formatBytes(state.saveMeBytes)}</span>
        <span><i className="other" /> Other {formatBytes(Math.max(0, used - mine))}</span>
        <span>of {formatBytes(total)}</span>
      </div>
    </div>
  )
}
