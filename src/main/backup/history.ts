import crypto from 'node:crypto'
import { GameIndex, SnapshotMeta } from '../../shared/types'
import { StorageProvider, writeJson } from '../cloud/provider'

interface Base { format: 2; id: string; clock: number; machineId: string }
export interface SnapshotRecord extends Base { kind: 'snapshot'; snapshot: SnapshotMeta; name: string; archive: string; parents: string[] }
interface EventRecord extends Base { kind: 'rename' | 'pin' | 'unpin' | 'prune'; snapshotId: string; label?: string; archive?: string; observed?: string[] }
type RecordV2 = SnapshotRecord | EventRecord
export interface HistoryView {
  index: GameIndex
  records: Map<string, SnapshotRecord>
  events: EventRecord[]
  pins: Map<string, EventRecord[]>
  pruned: Set<string>
  clock: number
  available: Set<string>
}

export const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,240}$/.test(id) && !['__proto__','constructor','prototype'].includes(id)
function validRef(ref: unknown, gameId: string): ref is string {
  return typeof ref === 'string' && (/^@[\w!-]+$/.test(ref) || (ref.startsWith(`${gameId}/`) && /^[\w./-]+$/.test(ref) && !ref.split('/').some(p => p === '..' || p === '.')))
}
export function validateSnapshot(value: unknown, gameId: string): asserts value is SnapshotMeta {
  const s = value as SnapshotMeta
  if (!s || !validId(s.id) || s.gameId !== gameId || typeof s.machine !== 'string' || typeof s.machineId !== 'string' ||
    !Number.isSafeInteger(s.sizeBytes) || s.sizeBytes < 0 || !Number.isSafeInteger(s.zipBytes) || s.zipBytes < 0 ||
    !Number.isFinite(Date.parse(s.createdAt)) || !['game-exit','file-change','manual','pre-restore','first-backup'].includes(s.trigger) ||
    !s.files || typeof s.files !== 'object' || Array.isArray(s.files) || Object.values(s.files).some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h))) throw new Error('Backup history is invalid; no saves were changed')
}

/** Immutable records make discovery independent of a shared read/modify/write catalog. */
export class History {
  constructor(readonly provider: StorageProvider, readonly machineId: string) {}

  async load(gameId: string): Promise<HistoryView> {
    if (!validId(gameId)) throw new Error('Invalid game ID')
    const archives = await this.provider.list(gameId)
    const available = new Set(archives.filter(e => !e.directory).map(e => e.ref ?? `${gameId}/${e.name}`))
    const stored = await this.provider.list(`${gameId}/_v2`)
    const records = new Map<string, SnapshotRecord>(), events: EventRecord[] = []
    let clock = 0, name = gameId, incomplete = false
    // Bound metadata concurrency; large histories must not fan out unbounded requests.
    const candidates = stored.filter(e => e.name.endsWith('.json'))
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (next < candidates.length) {
        const entry = candidates[next++]
        if (entry.size > 32 * 1024 * 1024) throw new Error('Backup history record is too large')
        const bytes = await this.provider.get(entry.ref ?? `${gameId}/_v2/${entry.name}`)
        if (!bytes) { incomplete = true; continue }
        const record = JSON.parse(bytes.toString('utf8')) as RecordV2
        if (!record || record.format !== 2 || !validId(record.id) || !Number.isSafeInteger(record.clock) || record.clock < 0 || typeof record.machineId !== 'string') throw new Error('Invalid backup history record')
        clock = Math.max(clock, record.clock)
        if (record.kind === 'snapshot') {
          validateSnapshot(record.snapshot, gameId)
          if (record.id !== record.snapshot.id || !validRef(record.archive, gameId) || typeof record.name !== 'string' || !Array.isArray(record.parents) || record.parents.some(p => !validId(p))) throw new Error('Invalid snapshot record')
          const previous = records.get(record.id)
          if (previous && JSON.stringify(previous.snapshot) !== JSON.stringify(record.snapshot)) throw new Error('Conflicting snapshot identities')
          records.set(record.id, record); name = record.name
        } else {
          if (!['rename','pin','unpin','prune'].includes(record.kind) || !validId(record.snapshotId) ||
            (record.kind === 'rename' && (typeof record.label !== 'string' || record.label.length > 100)) ||
            (record.kind === 'pin' && !validRef(record.archive, gameId)) ||
            (record.kind === 'unpin' && (!Array.isArray(record.observed) || record.observed.some(p => !validId(p))))) throw new Error('Invalid history event')
          events.push(record)
        }
      }
    }))
    // Import every legacy index, including duplicate Drive folders, without rewriting it.
    const legacy = archives.filter(e => e.name === 'index.json')
    for (const entry of legacy) {
      if (entry.size > 32 * 1024 * 1024) throw new Error('Legacy history is too large')
      const bytes = await this.provider.get(entry.ref ?? `${gameId}/index.json`)
      if (!bytes) { incomplete = true; continue }
      const index = JSON.parse(bytes.toString('utf8')) as GameIndex
      if (index.gameId !== gameId || typeof index.name !== 'string' || !Array.isArray(index.snapshots)) throw new Error('Backup history is invalid; no saves were changed')
      let previous: string | undefined
      for (const s of [...index.snapshots].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
        validateSnapshot(s, gameId)
        if (!records.has(s.id)) {
          const archive = archives.find(e => e.name === `${s.id}.zip`)
          if (!archive) { incomplete = true; continue }
          const record: SnapshotRecord = { format: 2, kind: 'snapshot', id: s.id, machineId: s.machineId, clock: 0, name: index.name, snapshot: s, archive: archive.ref ?? `${gameId}/${s.id}.zip`, parents: previous ? [previous] : [] }
          await writeJson(this.provider, `${gameId}/_v2/import-${s.id}.json`, record)
          records.set(s.id, record); name = index.name
        }
        previous = s.id
      }
    }
    events.sort((a,b) => a.clock - b.clock || a.machineId.localeCompare(b.machineId) || a.id.localeCompare(b.id))
    const removed = new Set(events.filter(e => e.kind === 'unpin').flatMap(e => e.observed ?? []))
    const pins = new Map<string, EventRecord[]>(), pruned = new Set(events.filter(e => e.kind === 'prune').map(e => e.snapshotId))
    for (const e of events) if (e.kind === 'pin' && !removed.has(e.id)) pins.set(e.snapshotId, [...(pins.get(e.snapshotId) ?? []), e])
    const referenced = new Set([...records.values()].flatMap(r => r.parents))
    if ([...referenced].some(id => !records.has(id)) || events.some(e => !records.has(e.snapshotId))) incomplete = true
    const heads = [...records.keys()].filter(id => !referenced.has(id) && !pruned.has(id)).sort()
    const snapshots: SnapshotMeta[] = []
    for (const record of records.values()) {
      const pinned = pins.get(record.id) ?? []
      if (pruned.has(record.id) && !pinned.length) continue
      const ref = pinned.at(-1)?.archive ?? record.archive
      if (!available.has(ref)) incomplete = true
      const label = events.filter(e => e.kind === 'rename' && e.snapshotId === record.id).at(-1)?.label
      snapshots.push({ ...record.snapshot, parents: record.parents, pinned: pinned.length > 0, label: label || undefined })
    }
    snapshots.sort((a,b) => (records.get(a.id)!.clock - records.get(b.id)!.clock) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return { index: { gameId, name, snapshots, heads, incomplete }, records, events, pins, pruned, clock, available }
  }

  async commit(gameId: string, record: RecordV2): Promise<void> {
    await writeJson(this.provider, `${gameId}/_v2/${record.id}.json`, record)
  }

  async event(view: HistoryView, snapshotId: string, kind: EventRecord['kind'], data: Partial<Pick<EventRecord, 'label' | 'archive' | 'observed'>> = {}): Promise<void> {
    await this.commit(view.index.gameId, { format: 2, id: crypto.randomUUID(), clock: view.clock + 1, machineId: this.machineId, kind, snapshotId, ...data })
  }

  archive(view: HistoryView, id: string): string {
    const ref = view.pins.get(id)?.at(-1)?.archive ?? view.records.get(id)?.archive
    if (!ref || !view.index.snapshots.some(s => s.id === id)) throw new Error('Snapshot not found')
    return ref
  }
}
