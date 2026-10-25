import { AppState } from './types'

export type ProtectionKind = 'paused' | 'storage' | 'restoring' | 'uploading' | 'waiting' | 'attention' | 'scanning' | 'playing' | 'empty' | 'unprotected' | 'protected'

/** One rule for the overview, sidebar, and tray: only confirmed snapshots count as protected. */
export function protection(state: AppState): { kind: ProtectionKind; label: string } {
  const tracked = state.games.filter(g => g.tracked)
  const name = state.games.find(g => g.id === state.operation?.gameId)?.name ?? 'game saves'
  if (state.operation?.kind === 'storage') return { kind: 'storage', label: 'Changing backup storage…' }
  if (state.operation?.kind === 'restore') return { kind: 'restoring', label: `Restoring ${name}…` }
  if (state.operation?.kind === 'verify') return { kind: 'scanning', label: `Verifying ${name} backup…` }
  if (state.operation?.kind === 'preview') return { kind: 'scanning', label: `Comparing ${name} saves…` }
  if (state.operation?.kind === 'history') return { kind: 'storage', label: 'Updating backup history…' }
  if (!state.provider.connected) return { kind: 'paused', label: 'Backups are paused' }
  if (state.operation?.kind === 'backup') return { kind: 'uploading', label: `Backing up ${name}…` }
  const attention = tracked.filter(g => g.status === 'error' || g.status === 'cloud-newer').length
  if (attention) return { kind: 'attention', label: `${attention} game${attention === 1 ? ' needs' : 's need'} a look` }
  if (state.queue.length) return { kind: 'waiting', label: `${state.queue.length} backup${state.queue.length === 1 ? '' : 's'} waiting` }
  if (state.scanning) return { kind: 'scanning', label: 'Looking for your games' }
  if (state.running.length) return { kind: 'playing', label: 'Game running; backup after exit' }
  if (!tracked.length) return { kind: 'empty', label: 'No games to back up yet' }
  const missing = tracked.filter(g => g.status !== 'synced' || !g.lastSnapshotId).length
  if (missing) return { kind: 'unprotected', label: `${missing} game${missing === 1 ? ' has' : 's have'} no confirmed current backup` }
  return { kind: 'protected', label: tracked.length === 1 ? 'Your game is backed up' : `All ${tracked.length} games are backed up` }
}
