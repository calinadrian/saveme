import { useEffect, useState } from 'react'
import type { AppState, GameIndex } from '../../../shared/types'
import type { Navigate } from '../App'
import { api, formatBytes, plural, timeAgo, winPath } from '../api'
import { AsyncToggle, Cover, Icon, InlineError, StatusPill, STORE_NAMES, useAction } from '../components'
import { Empty } from './Dashboard'
import { confirmKeepLocal, confirmRestore } from './Games'

const TRIGGERS: Record<string, string> = {
  'game-exit': 'After playing',
  'file-change': 'Saves changed',
  manual: 'Backed up by you',
  'pre-restore': 'Before a restore',
  'first-backup': 'First backup'
}

export function GameDetail({ state, id, navigate }: { state: AppState; id: string; navigate: Navigate }) {
  const game = state.games.find((g) => g.id === id)
  const [index, setIndex] = useState<GameIndex>()
  const [loading, setLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string>()
  const [historyAttempt, setHistoryAttempt] = useState(0)
  const [run, error, busy] = useAction()
  const running = state.running.includes(id)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setHistoryError(undefined)
    setIndex(undefined)
    if (!state.provider.connected) { setLoading(false); return }
    api
      .history(id)
      .then(value => { if (!cancelled) setIndex(value) })
      .catch(e => { if (!cancelled) setHistoryError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, game?.lastSnapshotId, state.provider.connected, state.provider.location, historyAttempt])

  if (!game) {
    return (
      <div className="page">
        <button className="link back" onClick={() => navigate('/games')}>
          <Icon name="back" size={16} /> Games
        </button>
        <Empty icon="search" title="This game isn't here any more" />
      </div>
    )
  }

  const snapshots = [...(index?.snapshots ?? [])].sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
  const cloudBytes = snapshots.reduce((n, s) => n + s.zipBytes, 0)
  const restore = (snapshotId: string): void =>
    void run(async () => {
      const snapshot = index?.snapshots.find(s => s.id === snapshotId) ?? game.newerSnapshot
      if (snapshot?.id === snapshotId && await confirmRestore(game, snapshot, state.machine)) await api.restore(id, snapshotId)
    })
  return (
    <div className="page">
      <button className="link back" onClick={() => navigate('/games')}>
        <Icon name="back" size={16} /> Games
      </button>
      <header className="detail-hero">
        <Cover game={game} size="lg" />
        <div className="detail-title">
          <h1>{game.name}</h1>
          <div className="detail-meta">
            <StatusPill game={game} running={running} />
            {game.store && <span className="store">{STORE_NAMES[game.store]}</span>}
            <span className="muted">
              {formatBytes(game.sizeBytes)} on this PC · {loading ? 'Loading versions…' : historyError ? 'History unavailable' : !state.provider.connected ? 'Storage disconnected' : `${formatBytes(cloudBytes)} in ${plural(snapshots.length, 'version')}`}
            </span>
          </div>
          <div className="actions">
            <button className="btn primary" disabled={busy || !!state.operation || !game.tracked || !state.provider.connected || !game.roots.length} onClick={() => run(() => api.backupNow(id))}>
              <Icon name="upload" size={16} /> Back up now
            </button>
            <button className="btn" disabled={!game.roots.length} onClick={() => run(() => api.openSaveFolder(id))}>
              <Icon name="folder" size={16} /> Open save folder
            </button>
            <div className="inline-toggle">
              <AsyncToggle value={game.tracked} label="Automatic backup" onChange={v => api.setTracked(id, v)} />
              Automatic backup
            </div>
          </div>
        </div>
      </header>
      <InlineError error={error} />
      {(!game.roots.length || !game.tracked || !state.provider.connected || !!state.operation) && <p className="muted small action-reason">{!state.provider.connected ? 'Connect storage in Settings to back up or restore.' : state.operation ? 'Wait for the current operation to finish.' : !game.roots.length ? 'Save files have not been found on this PC. You can restore a version if its destinations are available.' : 'Turn on automatic backup to enable Back up now.'}</p>}
      {game.status === 'error' && game.error && (
        <div className="alert err" role="alert">
          <Icon name="alert" /> <span className="alert-text">The last backup failed: {game.error}</span>
        </div>
      )}
      {running && (
        <div className="alert info">
          <Icon name="play" /> <span className="alert-text">{game.name} is running. SaveMe backs it up a few seconds after you quit.</span>
        </div>
      )}
      {game.status === 'cloud-newer' && game.newerSnapshot && (
        <div className="alert warn">
          <Icon name="pc" />
          <span className="alert-text">
            <strong>{game.newerSnapshot.machine}</strong> has a newer save from {timeAgo(game.newerSnapshot.createdAt)}.
          </span>
          <span className="alert-actions">
            <button className="btn small primary" disabled={running || busy || !!state.operation} onClick={() => restore(game.newerSnapshot!.id)}>
              Review cloud save
            </button>
            {game.roots.length > 0 && (
              <button className="btn small" disabled={busy || !!state.operation} onClick={() => run(async () => { if (await confirmKeepLocal(game)) await api.keepLocal(id) })}>
                Keep this PC's
              </button>
            )}
          </span>
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Version history</h2>
          <span className="muted small">Restoring backs up your current save first.</span>
        </div>
        {loading && <p className="muted pad" role="status">Loading versions…</p>}
        {historyError && <div className="alert err" role="alert"><span className="alert-text">Could not load version history: {historyError}</span><button className="btn small" disabled={loading} onClick={() => setHistoryAttempt(n => n + 1)}>Retry</button></div>}
        {!loading && !historyError && !snapshots.length && (
          <Empty icon="history" title={state.provider.connected ? 'No backups yet' : 'Connect a storage to see backups'}>
            {state.provider.connected && 'The first one happens after you play, or press Back up now.'}
          </Empty>
        )}
        <ol className="timeline">
          {snapshots.map((s) => {
            const current = s.id === game.lastSnapshotId
            const when = new Date(s.createdAt)
            return (
              <li key={s.id} className={current ? 'current' : ''}>
                <span className="tl-dot" />
                <div className="tl-main">
                  <strong>{timeAgo(s.createdAt)}</strong>
                  <span className="muted">
                    {when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} {when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <span className="tl-tag">
                  <Icon name="pc" size={13} /> {s.machine === state.machine ? 'This PC' : s.machine}
                </span>
                <span className="tl-why muted">{TRIGGERS[s.trigger] ?? s.trigger}</span>
                <span className="tl-size muted">{formatBytes(s.zipBytes)}</span>
                <span className="tl-action">
                  {current ? (
                    <span className="pill ok">
                      <Icon name="check" size={12} /> On this PC
                    </span>
                  ) : (
                    <button className="btn small" disabled={running || busy || !!state.operation || !!historyError || !state.provider.connected} onClick={() => restore(s.id)}>
                      Restore
                    </button>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Where the saves are</h2>
        </div>
        {game.roots.length === 0 && <p className="muted">Not on this PC yet. Restoring puts the files where they were on the other PC.</p>}
        <ul className="paths">
          {game.roots.map((r) => (
            <li key={r.template}>
              <Icon name="folder" size={15} />
              <code>{winPath(r.resolved.replace(/\\(.)/g, '$1'))}</code>
            </li>
          ))}
        </ul>
        {game.installDir && (
          <p className="muted small">
            Installed at <code>{winPath(game.installDir)}</code>
          </p>
        )}
      </section>
    </div>
  )
}
