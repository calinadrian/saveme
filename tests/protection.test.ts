import { expect, it } from 'vitest'
import { protection } from '../src/shared/protection'
import { AppState, Game } from '../src/shared/types'

const game: Game = { id: 'game', name: 'Game', tracked: true, status: 'never', roots: [], fileCount: 0, sizeBytes: 0 }
const state = (patch: Partial<AppState> = {}): AppState => ({ games: [game], provider: { connected: true }, running: [], queue: [], scanning: false, ...patch }) as AppState

it('never claims a tracked game with no confirmed snapshot is protected', () => {
  expect(protection(state()).kind).toBe('unprotected')
  expect(protection(state({ games: [{ ...game, status: 'synced' }] })).kind).toBe('unprotected')
  expect(protection(state({ games: [{ ...game, status: 'synced', lastSnapshotId: 'confirmed' }] })).kind).toBe('protected')
})

it('distinguishes queued retries from active backup and restore operations', () => {
  const waiting = state({ games: [{ ...game, status: 'pending', error: 'Offline, will retry' }], queue: ['game'] })
  expect(protection(waiting)).toEqual({ kind: 'waiting', label: '1 backup waiting' })
  expect(protection({ ...waiting, operation: { kind: 'backup', gameId: 'game' } }).kind).toBe('uploading')
  expect(protection({ ...waiting, operation: { kind: 'restore', gameId: 'game' } }).kind).toBe('restoring')
})

it('does not hide failed backups behind a queue or treat an empty library as protected', () => {
  expect(protection(state({ queue: ['game'], games: [{ ...game, status: 'error' }] })).kind).toBe('attention')
  expect(protection(state({ games: [] })).kind).toBe('empty')
  expect(protection(state({ provider: { connected: false } as AppState['provider'] })).kind).toBe('paused')
})
