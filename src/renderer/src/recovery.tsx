import { useRef, useState } from 'react'
import type { AppState, DiagnosticsReport, SnapshotMeta } from '../../shared/types'
import { api, formatBytes } from './api'
import { Icon, InlineError, Modal, Spinner, useAction } from './components'

export function OperationStatus({ state }: { state: AppState }) {
  const progress = state.operation?.progress
  const pending = state.games.filter(g => g.retryAt && g.status === 'pending')
  if (!progress) return pending.length ? <p className="operation-status muted" role="status">{pending.length} backup{pending.length === 1 ? '' : 's'} waiting. Next retry at {new Date(Math.min(...pending.map(g => g.retryAt!))).toLocaleTimeString()}.</p> : null
  const labels = { reading: 'Reading files', compressing: 'Compressing', uploading: 'Uploading', downloading: 'Downloading', verifying: 'Verifying backup', restoring: 'Restoring files' }
  const game = state.games.find(g => g.id === state.operation?.gameId)?.name
  const amount = (n: number) => progress.unit === 'bytes' ? formatBytes(n) : n + ' files'
  return <div className="operation-status" role="status" aria-live="polite"><div className="operation-line"><Spinner size={14} /><strong>{labels[progress.stage]}{game ? ` · ${game}` : ''}</strong><span className="muted">{amount(progress.completed)}{progress.total ? ` of ${amount(progress.total)}` : ''}</span></div>{progress.total ? <progress aria-label={labels[progress.stage]} value={progress.completed} max={progress.total} /> : null}</div>
}

export function SnapshotActions({ snapshot, disabled, onAction, onRename }: { snapshot: SnapshotMeta; disabled: boolean; onAction: (action: 'verify' | 'pin' | 'unpin') => void; onRename: () => void }) {
  const details = useRef<HTMLDetailsElement>(null)
  const close = (): void => { if (details.current) { details.current.open = false; details.current.querySelector('summary')?.focus() } }
  return <details className="snapshot-actions" ref={details} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close() } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false }}>
    <summary className="btn small" data-snapshot-id={snapshot.id} aria-label={`Actions for ${snapshot.label || new Date(snapshot.createdAt).toLocaleString()}`}>Actions</summary>
    <div className="snapshot-menu"><button disabled={disabled} onClick={() => { close(); onAction('verify') }}><Icon name="shield" size={15} />Verify backup</button><button disabled={disabled} onClick={() => { close(); onRename() }}><Icon name="doc" size={15} />Name version</button><button disabled={disabled} onClick={() => { close(); onAction(snapshot.pinned ? 'unpin' : 'pin') }}><Icon name="history" size={15} />{snapshot.pinned ? 'Unpin version' : 'Pin version'}</button></div>
  </details>
}

export function DiagnosticExport() {
  const [report,setReport] = useState<DiagnosticsReport>()
  const [run,error,busy] = useAction()
  const [exported,setExported] = useState(false)
  return <div className="diagnostic-export"><button className="btn" disabled={busy} onClick={() => void run(async () => { setExported(false); setReport(await api.diagnostics()) })}><Icon name="doc" size={16} />Export diagnostics</button><InlineError error={!report ? error : undefined} />{report && <Modal title="Export diagnostics" dismissible={!busy} onClose={() => setReport(undefined)}><h2 className="modal-title">Export diagnostics</h2><p>This local report contains app versions, storage health, backup counts, and classified recent events. Credentials, accounts, personal paths, save contents, and raw error messages are excluded.</p><dl className="restore-facts"><dt>Storage</dt><dd>{report.storage.connected ? 'Connected' : 'Disconnected'}</dd><dt>Games / queued backups</dt><dd>{report.health.games} / {report.health.queued}</dd><dt>Recent events</dt><dd>{report.recentEvents.length}</dd></dl><details><summary>Preview report</summary><pre className="diagnostic-preview">{JSON.stringify(report,null,2)}</pre></details><InlineError error={error} /><p role="status">{exported ? 'Diagnostic report saved.' : ''}</p><div className="modal-actions"><button className="btn ghost" disabled={busy} onClick={() => setReport(undefined)}>Close</button><button className="btn primary" disabled={busy} onClick={() => void run(async () => setExported(await api.exportDiagnostics()))}>{busy ? 'Saving…' : 'Save report…'}</button></div></Modal>}</div>
}
