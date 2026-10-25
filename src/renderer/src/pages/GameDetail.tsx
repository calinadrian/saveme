import { useEffect, useRef, useState } from 'react'
import type { AppState, GameIndex } from '../../../shared/types'
import type { Navigate } from '../App'
import { api, formatBytes, plural, timeAgo, winPath } from '../api'
import { AsyncToggle, Cover, Icon, InlineError, StatusPill, STORE_NAMES, useAction } from '../components'
import { Empty } from './Dashboard'
import { confirmKeepLocal, confirmRestore } from './Games'
import { SnapshotActions } from '../recovery'

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
  const [naming, setNaming] = useState<{ id: string; value: string }>()
  const [notice, setNotice] = useState<string>()
  const returnTo = useRef<string | undefined>(undefined)
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

  useEffect(() => {
    if (!loading && !naming && returnTo.current) {
      const target = document.querySelector<HTMLElement>(`summary[data-snapshot-id="${returnTo.current}"]`) ?? document.querySelector<HTMLElement>('.timeline summary') ?? document.querySelector<HTMLElement>('h1')
      target?.focus()
      returnTo.current = undefined
    }
  }, [loading,naming])

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

  const snapshots = [...(index?.snapshots ?? [])].reverse()
  const cloudBytes = snapshots.reduce((n, s) => n + s.zipBytes, 0)
  const restore = (snapshotId: string): void =>
    void run(async () => {
      const snapshot = index?.snapshots.find(s => s.id === snapshotId) ?? game.newerSnapshot
      if (snapshot?.id === snapshotId) { const preview = await confirmRestore(game,snapshot,state.machine); if (preview) await api.restore(id,snapshotId,preview.token) }
    })
  const historyAction = (snapshotId: string, action: 'verify' | 'pin' | 'unpin'): void => {
    setNotice(undefined)
    void run(async () => {
      if (action === 'verify') {
        const result = await api.verifySnapshot(id,snapshotId)
        setNotice(result.status === 'verified' ? 'Backup verified. All files match their recorded hashes.' : result.status === 'corrupt' ? 'Backup verification failed. This archive is damaged or incomplete; choose another version.' : 'Could not verify the backup. Check storage availability and retry.')
      } else if (action === 'pin') { await api.pinSnapshot(id,snapshotId); setNotice('Version pinned. A protected copy stays until you unpin it.') }
      else { await api.unpinSnapshot(id,snapshotId); setNotice('Version unpinned. Normal retention applies.') }
      setHistoryAttempt(n => n + 1)
    })
  }
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
      {notice && <p className="history-feedback" role="status">{notice}</p>}
      {(!game.roots.length || !game.tracked || !state.provider.connected || !!state.operation) && <p className="muted small action-reason">{!state.provider.connected ? 'Connect storage in Settings to back up or restore.' : state.operation ? 'Wait for the current operation to finish.' : !game.roots.length ? 'Save files have not been found on this PC. You can restore a version if its destinations are available.' : 'Turn on automatic backup to enable Back up now.'}</p>}
      {game.status === 'error' && game.error && (
        <div className="alert err" role="alert">
          <span className="alert-text">The last backup failed: {game.error}</span>
        </div>
      )}
      {running && (
        <div className="alert info">
          <Icon name="play" /> <span className="alert-text">{game.name} is running. SaveMe backs it up a few seconds after you quit.</span>
        </div>
      )}
      {game.status === 'cloud-newer' && game.newerSnapshot && (
        <div className="alert warn">
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
        <p className="muted small">History format 2 requires updated SaveMe on every PC sharing this storage. Pinned versions and unresolved branches can exceed your history limit.</p>
        {index?.incomplete && <p className="alert warn">Some backup files have not arrived yet. History cleanup waits for storage to finish syncing.</p>}
        {(index?.heads?.length ?? 0) > 1 && <p className="alert warn">Multiple PCs have separate save progress. Review the versions before choosing which save to continue.</p>}
        {naming && <form className="history-name-editor" onSubmit={event => { event.preventDefault(); void run(async () => { await api.renameSnapshot(id,naming.id,naming.value); setNaming(undefined); setHistoryAttempt(n => n + 1) }) }}><label htmlFor="version-name">Version name</label><input id="version-name" autoFocus maxLength={100} disabled={busy} value={naming.value} onChange={event => setNaming({ ...naming,value: event.target.value })} placeholder="Before the final boss" /><button type="button" className="btn ghost" disabled={busy} onClick={() => setNaming(undefined)}>Cancel</button><button className="btn primary" disabled={busy}>Save name</button></form>}
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
                  <strong>{s.label || timeAgo(s.createdAt)}{s.pinned && <span className="snapshot-pin">Pinned</span>}</strong>
                  <span className="muted">
                    {when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} {when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {s.verification && <span className={s.verification.status === 'corrupt' ? 'err-text' : 'muted'} title={new Date(s.verification.checkedAt).toLocaleString()}>{s.verification.status === 'verified' ? 'Verified' : s.verification.status === 'corrupt' ? 'Verification failed' : 'Verification unavailable'}</span>}
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
                  <SnapshotActions snapshot={s} disabled={busy || !!state.operation || !state.provider.connected} onAction={action => { returnTo.current = s.id; historyAction(s.id,action) }} onRename={() => { returnTo.current = s.id; setNaming({ id: s.id,value: s.label ?? '' }) }} />
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
