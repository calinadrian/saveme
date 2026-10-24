import type { ReactNode } from 'react'
import type { ActivityItem, AppState, Game } from '../../../shared/types'
import type { Navigate } from '../App'
import { api, formatBytes, plural, timeAgo } from '../api'
import { Cover, Icon, IconName, InlineError, PROVIDER_NAMES, PROVIDER_PLACE, ProviderIcon, Spinner, StatusPill, useAction } from '../components'
import { protection } from '../../../shared/protection'

export function Dashboard({ state, navigate }: { state: AppState; navigate: Navigate }) {
  const [run, error, busy] = useAction()
  const tracked = state.games.filter((g) => g.tracked)
  const attention = state.games.filter((g) => g.status === 'cloud-newer' || g.status === 'error')
  const recent = tracked
    .filter((g) => g.lastBackupAt)
    .sort((a, b) => (b.lastBackupAt! > a.lastBackupAt! ? 1 : -1))
    .slice(0, 6)

  return (
    <div className="page">
      <Hero state={state} attention={attention} onConnect={() => navigate('/settings')} onBackup={() => run(() => api.backupAll())} busy={busy} onScan={() => run(() => api.scan())} />
      <InlineError error={error} />

      {attention.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Needs a look</h2>
            <button className="link" onClick={() => navigate('/games')}>
              All games
            </button>
          </div>
          {attention.map((g) => (
            <button key={g.id} className="row clickable" onClick={() => navigate(`/game/${g.id}`)}>
              <Cover game={g} />
              <div className="row-main">
                <strong>{g.name}</strong>
                <span className="muted">{g.status === 'cloud-newer' ? `Newer save from ${g.newerSnapshot?.machine}, ${timeAgo(g.newerSnapshot?.createdAt)}` : g.error}</span>
              </div>
              <StatusPill game={g} />
              <Icon name="back" size={16} className="chevron" />
            </button>
          ))}
        </section>
      )}

      <section className="grid-2 tiles">
        <StorageCard state={state} />
        <CoverageCard state={state} onOpen={() => navigate('/games')} />
      </section>

      <section className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Recently backed up</h2>
          </div>
          {recent.length === 0 && (
            <Empty icon="history" title={state.scanning ? 'Looking for your games…' : 'No backups yet'}>
              {state.scanning ? state.scanProgress : 'The first one happens a few seconds after you close a game.'}
            </Empty>
          )}
          {recent.map((g) => (
            <button key={g.id} className="row clickable" onClick={() => navigate(`/game/${g.id}`)}>
              <Cover game={g} />
              <div className="row-main">
                <strong>{g.name}</strong>
                <span className="muted">
                  {timeAgo(g.lastBackupAt)} · {formatBytes(g.sizeBytes)}
                </span>
              </div>
              <StatusPill game={g} running={state.running.includes(g.id)} />
            </button>
          ))}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Activity</h2>
          </div>
          {state.activity.length === 0 && (
            <Empty icon="info" title="Nothing yet">
              Backups, restores and problems show up here.
            </Empty>
          )}
          <ul className="activity">
            {state.activity.slice(0, 10).map((a, i) => (
              <li key={i} className={a.kind}>
                <span className="act-icon">
                  <Icon name={ACTIVITY_ICON[a.kind]} size={13} />
                </span>
                <span className="act-msg">{a.message}</span>
                <span className="act-time">{timeAgo(a.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  )
}

const ACTIVITY_ICON: Record<ActivityItem['kind'], IconName> = { backup: 'upload', restore: 'history', skip: 'check', error: 'alert', info: 'info' }

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={20} />
      </span>
      <strong>{title}</strong>
      {children && <span className="muted">{children}</span>}
    </div>
  )
}

/** The one thing to know when opening SaveMe: are my saves safe, and is there anything to do? */
function Hero({
  state,
  attention,
  busy,
  onConnect,
  onBackup,
  onScan
}: {
  state: AppState
  attention: Game[]
  busy: boolean
  onConnect: () => void
  onBackup: () => void
  onScan: () => void
}) {
  const tracked = state.games.filter((g) => g.tracked)
  const byId = (id: string): string => state.games.find((g) => g.id === id)?.name ?? 'a game'
  const where = state.provider.kind ? PROVIDER_PLACE[state.provider.kind] : ''
  const lastBackup = tracked
    .map((g) => g.lastBackupAt)
    .filter(Boolean)
    .sort()
    .pop()

  let tone: 'ok' | 'busy' | 'warn' | 'play' = 'ok'
  let icon: ReactNode = <Icon name="shield" size={30} />
  let title: string
  let sub: string
  if (!state.provider.connected) {
    tone = 'warn'
    icon = <Icon name="cloudOff" size={30} />
    title = 'Backups are paused'
    sub = 'Connect Google Drive, OneDrive or a folder, and SaveMe starts protecting your saves right away.'
  } else if (state.operation?.kind === 'restore' || state.operation?.kind === 'storage') {
    tone = 'busy'
    icon = <Spinner size={30} />
    title = protection(state).label
    sub = state.operation.kind === 'restore' ? 'Checking and restoring your selected version. Your previous files are kept for recovery until this finishes.' : 'Waiting for current work to finish before using the new destination.'
  } else if (state.operation?.kind === 'backup') {
    tone = 'busy'
    icon = <Spinner size={30} />
    title = protection(state).label
    sub = `Preparing and uploading to ${where}.`
  } else if (state.queue.length && !attention.length) {
    tone = 'warn'
    icon = <Icon name="history" size={30} />
    title = protection(state).label
    sub = state.games.find(g => g.id === state.queue[0])?.error ?? 'Waiting for the game to close or storage to become available. SaveMe will retry automatically.'
  } else if (state.scanning) {
    tone = 'busy'
    icon = <Spinner size={30} />
    title = 'Looking for your games'
    sub = state.scanProgress ?? 'This takes a few seconds.'
  } else if (state.running.length) {
    tone = 'play'
    icon = <Icon name="play" size={28} />
    title = `Playing ${byId(state.running[0])}`
    sub = 'Have fun. SaveMe backs it up a few seconds after you quit.'
  } else if (attention.length) {
    tone = 'warn'
    icon = <Icon name="alert" size={30} />
    title = `${plural(attention.length, 'game')} ${attention.length === 1 ? 'needs' : 'need'} a look`
    sub = 'Another PC has a newer save, or a backup didn’t go through. Details are below.'
  } else if (!tracked.length) {
    tone = 'warn'
    icon = <Icon name="games" size={30} />
    title = 'No games to back up yet'
    sub = 'Scan again after installing a game, or add one SaveMe didn’t find from the Games page.'
  } else {
    const health = protection(state)
    title = health.label
    if (health.kind !== 'protected') { tone = 'warn'; icon = <Icon name="alert" size={30} /> }
    sub = health.kind === 'protected' ? `Last backup ${timeAgo(lastBackup)} to ${where}. SaveMe is watching for your next session.` : 'Open Games to check save locations, or back up now to create a confirmed version.'
  }

  return (
    <section className={`hero ${tone}`}>
      <div className="hero-icon">{icon}</div>
      <div className="hero-text">
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <div className="hero-actions">
        {!state.provider.connected ? (
          <button className="btn primary" onClick={onConnect}>
            Connect storage
          </button>
        ) : !tracked.length ? (
          <button className="btn primary" disabled={state.scanning} onClick={onScan}>
            <Icon name="refresh" size={16} /> Scan again
          </button>
        ) : (
            <button className="btn primary" disabled={busy || !!state.operation} onClick={onBackup}>
            <Icon name="upload" size={16} /> Back up now
          </button>
        )}
      </div>
    </section>
  )
}

function StorageCard({ state }: { state: AppState }) {
  const q = state.quota
  const total = q?.totalBytes
  const used = q?.usedBytes ?? 0
  const backupBytes = state.backupUsage?.status === 'ready' ? state.backupUsage.bytes : undefined
  const usageLabel = state.backupUsage?.status === 'unavailable' ? 'Usage unavailable' : 'Checking usage…'
  const mine = backupBytes === undefined ? 0 : Math.min(backupBytes, used || backupBytes)
  const pct = (n: number): string => (total ? `${Math.max(n > 0 ? 0.8 : 0, (n / total) * 100)}%` : '0%')
  return (
    <div className="card tile storage">
      <div className="tile-head">
        <span className="tile-icon">
          <ProviderIcon kind={state.provider.kind} />
        </span>
        <div className="tile-title">
          <strong>{state.provider.kind ? PROVIDER_NAMES[state.provider.kind] : 'No storage'}</strong>
          <span className="muted" title={state.provider.location}>
            {state.provider.kind === 'local' ? state.provider.location : (state.provider.account ?? state.provider.location ?? 'Not connected')}
          </span>
        </div>
      </div>
      <div className="tile-value">
        {total ? formatBytes(total - used) : backupBytes === undefined ? '—' : formatBytes(backupBytes)}
        <small>{total ? `free of ${formatBytes(total)}` : 'used by SaveMe'}</small>
      </div>
      {total ? (
        <>
          <div className="bar" role="img" aria-label={`${formatBytes(used)} of ${formatBytes(total)} used`}>
            <span className="seg mine" style={{ width: pct(mine) }} />
            <span className="seg other" style={{ width: pct(Math.max(0, used - mine)) }} />
          </div>
          <div className="legend">
            <span>
              <i className="mine" /> SaveMe {backupBytes === undefined ? usageLabel : formatBytes(backupBytes)}
            </span>
            <span>
              <i className="other" /> {backupBytes === undefined ? `Total used ${formatBytes(used)}` : `Other files ${formatBytes(Math.max(0, used - mine))}`}
            </span>
          </div>
        </>
      ) : (
        <p className="muted small">{state.provider.connected ? backupBytes === undefined ? usageLabel : "Free space shows once SaveMe can read this storage's size." : 'Connect a storage to see free space.'}</p>
      )}
    </div>
  )
}

function CoverageCard({ state, onOpen }: { state: AppState; onOpen: () => void }) {
  const tracked = state.games.filter((g) => g.tracked)
  const safe = tracked.filter((g) => g.status === 'synced' && g.lastSnapshotId).length
  const off = state.games.length - tracked.length
  const share = tracked.length ? safe / tracked.length : 0
  return (
    <button className="card tile coverage clickable" onClick={onOpen}>
      <div className="tile-head">
        <span className="tile-icon">
          <Icon name="games" />
        </span>
        <div className="tile-title">
          <strong>Games</strong>
          <span className="muted">{state.machine}</span>
        </div>
      </div>
      <div className="tile-value">
        {safe}
        <small> of {plural(tracked.length, 'game')} backed up</small>
      </div>
      <div className="bar">
        <span className="seg mine" style={{ width: `${share * 100}%` }} />
      </div>
      <div className="legend">
        <span>{off ? `${plural(off, 'more game')} found, backup off` : safe === tracked.length && safe > 0 ? 'Every game found is backed up' : `${plural(tracked.length - safe, 'game')} waiting for a successful backup`}</span>
      </div>
    </button>
  )
}
