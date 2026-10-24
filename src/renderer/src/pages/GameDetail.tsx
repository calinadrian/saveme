import { useEffect, useState } from 'react'
import type { AppState, GameIndex } from '../../../shared/types'
import type { Navigate } from '../App'
import { api, formatBytes, timeAgo } from '../api'
import { Cover, StatusPill, Toggle, useAction } from '../components'

const TRIGGERS: Record<string, string> = {
  'game-exit': 'After playing',
  'file-change': 'Saves changed',
  manual: 'Manual',
  'pre-restore': 'Before restore',
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
        <button className="link" onClick={() => navigate('/games')}>← Games</button>
        <p>Game not found.</p>
      </div>
    )
  }

  const snapshots = [...(index?.snapshots ?? [])].sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
  const cloudBytes = snapshots.reduce((n, s) => n + s.zipBytes, 0)

  const restore = (snapshotId: string, label: string): void => {
    if (!confirm(`Restore ${game.name} to the save from ${label}?\n\nYour current save is backed up first, so you can undo this.`)) return
    void run(() => api.restore(id, snapshotId))
  }

  return (
    <div className="page">
      <button className="link back" onClick={() => navigate('/games')}>← Games</button>
      <header className="detail-head">
        <Cover game={game} size="lg" />
        <div className="detail-title">
          <h1>{game.name}</h1>
          <div className="detail-meta">
            <StatusPill game={game} running={running} />
            <span className="muted">{game.fileCount} files · {formatBytes(game.sizeBytes)} on disk · {formatBytes(cloudBytes)} in cloud</span>
          </div>
          <div className="actions">
            <button className="btn primary" disabled={busy || !game.tracked || !state.provider.connected || !game.roots.length} onClick={() => run(() => api.backupNow(id))}>
              Back up now
            </button>
            <button className="btn" disabled={!game.roots.length} onClick={() => run(() => api.openSaveFolder(id))}>Open save folder</button>
            <label className="inline-toggle">
              <Toggle on={game.tracked} label="Automatic backup" onChange={(v) => run(() => api.setTracked(id, v))} />
              Automatic backup
            </label>
          </div>
        </div>
      </header>
      {error && <div className="alert err">{error}</div>}
      {running && <div className="alert info">{game.name} is running. SaveMe backs it up a few seconds after you quit.</div>}
      {game.status === 'cloud-newer' && game.newerSnapshot && (
        <div className="alert warn">
          <span>
            The cloud has a newer save from <strong>{game.newerSnapshot.machine}</strong> ({timeAgo(game.newerSnapshot.createdAt)}).
          </span>
          <span className="alert-actions">
            <button className="btn small primary" disabled={running || busy} onClick={() => restore(game.newerSnapshot!.id, game.newerSnapshot!.machine)}>
              Restore it
            </button>
            {game.roots.length > 0 && <button className="btn small" onClick={() => run(() => api.keepLocal(id))}>Keep this PC's save</button>}
          </span>
        </div>
      )}

      <section className="card">
        <h2>Version history</h2>
        {loading && <p className="muted">Loading…</p>}
        {!loading && !snapshots.length && <p className="muted">{state.provider.connected ? 'No backups yet.' : 'Connect cloud storage to see history.'}</p>}
        {snapshots.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>PC</th>
                <th>Why</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => {
                const current = s.id === game.lastSnapshotId
                return (
                  <tr key={s.id} className={current ? 'current' : ''}>
                    <td>
                      {new Date(s.createdAt).toLocaleString()}
                      <span className="muted"> · {timeAgo(s.createdAt)}</span>
                    </td>
                    <td>{s.machine}</td>
                    <td>{TRIGGERS[s.trigger] ?? s.trigger}</td>
                    <td>{formatBytes(s.zipBytes)}</td>
                    <td className="right">
                      {current ? (
                        <span className="pill ok">On this PC</span>
                      ) : (
                        <button className="btn small" disabled={running || busy} onClick={() => restore(s.id, new Date(s.createdAt).toLocaleString())}>
                          Restore
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Save locations</h2>
        {game.roots.length === 0 && <p className="muted">Not found on this PC. Restoring puts the files where they were on the other PC.</p>}
        <ul className="paths">
          {game.roots.map((r) => (
            <li key={r.template}>
              <code>{r.resolved.replace(/\\(.)/g, '$1')}</code>
            </li>
          ))}
        </ul>
        {game.installDir && <p className="muted">Installed at <code>{game.installDir}</code></p>}
      </section>
    </div>
  )
}
