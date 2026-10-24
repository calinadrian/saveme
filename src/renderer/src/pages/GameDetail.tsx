import { useEffect, useState } from 'react'
import type { AppState, GameIndex } from '../../../shared/types'
import type { Navigate } from '../App'
import { api, formatBytes, plural, timeAgo } from '../api'
import { Cover, coverUrl, Icon, StatusPill, STORE_NAMES, Toggle, useAction } from '../components'
import { Empty } from './Dashboard'
import { confirmRestore } from './Games'

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
  const [run, error, busy] = useAction()
  const running = state.running.includes(id)

  useEffect(() => {
    setLoading(true)
    api
      .history(id)
      .then(setIndex)
      .catch(() => setIndex(undefined))
      .finally(() => setLoading(false))
  }, [id, game?.lastSnapshotId])

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
  const restore = (snapshotId: string, label: string): void =>
    void run(async () => {
      if (await confirmRestore(game, label)) await api.restore(id, snapshotId)
    })
  const art = coverUrl(game)

  return (
    <div className="page">
      <button className="link back" onClick={() => navigate('/games')}>
        <Icon name="back" size={16} /> Games
      </button>
      <header className="detail-hero">
        {art && <div className="detail-backdrop" style={{ backgroundImage: `url(${art})` }} />}
        <Cover game={game} size="lg" />
        <div className="detail-title">
          <h1>{game.name}</h1>
          <div className="detail-meta">
            <StatusPill game={game} running={running} />
            {game.store && <span className="store">{STORE_NAMES[game.store]}</span>}
            <span className="muted">
              {formatBytes(game.sizeBytes)} on this PC · {formatBytes(cloudBytes)} in {plural(snapshots.length, 'version')}
            </span>
          </div>
          <div className="actions">
            <button className="btn primary" disabled={busy || !game.tracked || !state.provider.connected || !game.roots.length} onClick={() => run(() => api.backupNow(id))}>
              <Icon name="upload" size={16} /> Back up now
            </button>
            <button className="btn" disabled={!game.roots.length} onClick={() => run(() => api.openSaveFolder(id))}>
              <Icon name="folder" size={16} /> Open save folder
            </button>
            <label className="inline-toggle">
              <Toggle on={game.tracked} label="Automatic backup" onChange={(v) => run(() => api.setTracked(id, v))} />
              Automatic backup
            </label>
          </div>
        </div>
      </header>
      {error && <div className="alert err">{error}</div>}
      {game.status === 'error' && game.error && (
        <div className="alert err">
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
            <button className="btn small primary" disabled={running || busy} onClick={() => restore(game.newerSnapshot!.id, `the save from ${game.newerSnapshot!.machine}`)}>
              Use that save
            </button>
            {game.roots.length > 0 && (
              <button className="btn small" onClick={() => run(() => api.keepLocal(id))}>
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
        {loading && <p className="muted pad">Loading…</p>}
        {!loading && !snapshots.length && (
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
                    <button className="btn small" disabled={running || busy} onClick={() => restore(s.id, `the save from ${when.toLocaleString()}`)}>
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
              <code>{r.resolved.replace(/\\(.)/g, '$1')}</code>
            </li>
          ))}
        </ul>
        {game.installDir && (
          <p className="muted small">
            Installed at <code>{game.installDir}</code>
          </p>
        )}
      </section>
    </div>
  )
}
