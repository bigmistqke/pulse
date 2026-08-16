// src/dep-replay.ts
import {
  read as r3Read,
  type Computed as R3Computed,
  type Link,
  type Signal as R3Signal,
} from 'r3'

/** One dependency r3 recorded for a node, paired with the value it held at the
 *  moment it was recorded. */
export type DepRecord = {
  dep: R3Signal<unknown> | R3Computed<unknown>
  value: unknown
}

/**
 * Record the dependencies r3 has assembled for `node` during the current run.
 *
 * r3 keeps a node's dependencies as a linked list and reuses it across runs:
 * `recompute` resets the cursor `depsTail` to null before invoking the body,
 * each read advances it, and everything past it is unlinked once the body
 * returns. So the run's own dependencies are the list from `deps` up to and
 * including `depsTail`; anything after it is left over from the previous run
 * and is about to be discarded, which is why the walk stops at the cursor.
 *
 * A null cursor means the run has read nothing yet, so nothing is recorded.
 *
 * `exclude` names one dependency to leave out — a caller's own control signal,
 * which it changes deliberately to force a run and must therefore not mistake
 * for someone else's change. Pass null to record everything.
 */
export function snapshotDeps(
  node: R3Computed<unknown>,
  exclude: object | null,
): DepRecord[] {
  const records: DepRecord[] = []
  const stop = node.depsTail
  if (stop === null) return records
  for (let link: Link | null = node.deps; link !== null; link = link.nextDep) {
    if (link.dep !== exclude) {
      records.push({ dep: link.dep, value: link.dep.value })
    }
    if (link === stop) break
  }
  return records
}

/**
 * Read every recorded dependency, and report whether any of them changed.
 *
 * The read is the point: a dependency survives a run only by being read during
 * it, so replaying the records is what stops r3 unlinking dependencies that an
 * earlier segment of a resumed computation registered. Reading also brings a
 * computed dependency up to date and returns its current value, which is what
 * the comparison needs — so one walk both re-links and decides.
 *
 * Every record is read even once a change has been seen. Returning early would
 * re-link only part of the list and drop the rest.
 */
export function replayDeps(records: readonly DepRecord[]): boolean {
  let changed = false
  for (const record of records) {
    if (!Object.is(r3Read(record.dep), record.value)) changed = true
  }
  return changed
}
