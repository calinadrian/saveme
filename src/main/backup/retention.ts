import { RetentionPolicy, SnapshotMeta } from '../../shared/types'

const DAY = 24 * 3600 * 1000

/**
 * Returns snapshots to delete: keeps the newest `keepLast`, plus the newest of each of
 * the last `keepDaily` days and `keepWeekly` weeks.
 */
export function snapshotsToPrune(snapshots: SnapshotMeta[], policy: RetentionPolicy, now = Date.now()): SnapshotMeta[] {
  // Append order breaks equal timestamps: the most recently committed version wins the tie.
  const sorted = [...snapshots].reverse().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const keep = new Set<string>(sorted.slice(0, Math.max(1, policy.keepLast)).map((s) => s.id))
  const newestPerBucket = (size: number, count: number): void => {
    const seen = new Set<number>()
    for (const s of sorted) {
      const bucket = Math.floor((now - Date.parse(s.createdAt)) / size)
      if (bucket >= count || seen.has(bucket)) continue
      seen.add(bucket)
      keep.add(s.id)
    }
  }
  newestPerBucket(DAY, policy.keepDaily)
  newestPerBucket(7 * DAY, policy.keepWeekly)
  return sorted.filter((s) => !keep.has(s.id))
}
