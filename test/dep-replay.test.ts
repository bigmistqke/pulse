import { expect, test } from 'vitest'
import {
  computed as r3Computed,
  read as r3Read,
  setSignal as r3SetSignal,
  signal as r3Signal,
  type Computed as R3Computed,
} from 'r3'
import { replayDeps, snapshotDeps } from '../src/dep-replay'

test('snapshotDeps records every dependency a run read, with its value', () => {
  const a = r3Signal(1)
  const b = r3Signal(2)
  const node = r3Computed(() => r3Read(a) + r3Read(b))

  const records = snapshotDeps(node as R3Computed<unknown>, null)

  expect(records.length).toBe(2)
  expect(records.map((r) => r.value)).toEqual([1, 2])
})

test('snapshotDeps records nothing for a run that read no dependencies', () => {
  const node = r3Computed(() => 42)
  expect(snapshotDeps(node as R3Computed<unknown>, null)).toEqual([])
})

test('snapshotDeps leaves out the excluded dependency', () => {
  const a = r3Signal(1)
  const control = r3Signal(0)
  const node = r3Computed(() => {
    r3Read(control)
    return r3Read(a)
  })

  const records = snapshotDeps(node as R3Computed<unknown>, control)

  expect(records.length).toBe(1)
  expect(records[0]!.value).toBe(1)
})

test('an excluded control signal does not make replayDeps report a change', () => {
  // The failure this guards against: a caller that bumps its own control signal
  // to force a run would see every run as someone else's change.
  const a = r3Signal(1)
  const control = r3Signal(0)
  const node = r3Computed(() => {
    r3Read(control)
    return r3Read(a)
  })
  const records = snapshotDeps(node as R3Computed<unknown>, control)

  r3SetSignal(control, 1)

  expect(replayDeps(records)).toBe(false)
})

test('replayDeps reports false when nothing changed', () => {
  const a = r3Signal(1)
  const node = r3Computed(() => r3Read(a))
  const records = snapshotDeps(node as R3Computed<unknown>, null)

  expect(replayDeps(records)).toBe(false)
})

test('replayDeps reports true when a recorded dependency changed', () => {
  const a = r3Signal(1)
  const b = r3Signal(2)
  const node = r3Computed(() => r3Read(a) + r3Read(b))
  const records = snapshotDeps(node as R3Computed<unknown>, null)

  r3SetSignal(a, 99)

  expect(replayDeps(records)).toBe(true)
})

test('replayDeps reads every record even after finding a change', () => {
  // Each recorded dependency has to be read so r3 keeps it linked. A loop that
  // returned early on the first change would drop the rest.
  //
  // The last dependency is a computed rather than a signal, because a computed
  // holds a stale `.value` until something reads it. Asserting on a signal's
  // `.value` here would prove nothing: setSignal writes it directly, so it
  // would hold the new value whether or not replayDeps ever looked.
  const a = r3Signal(1)
  const source = r3Signal(3)
  const derived = r3Computed(() => r3Read(source) * 10)
  const node = r3Computed(() => r3Read(a) + r3Read(derived))
  const records = snapshotDeps(node as R3Computed<unknown>, null)
  expect(records.length).toBe(2)
  expect(derived.value).toBe(30)

  r3SetSignal(a, 99) // first record changes — a naive loop would stop here
  r3SetSignal(source, 5) // `derived` is now stale: still 30, should be 50

  // `replayDeps` must run inside a reactive context. r3's `read` only refreshes
  // a stale computed when there is a context to link into (`../r3/src/index.ts`,
  // the `if (context)` guard in `read`), and the real caller invokes this from
  // inside its own computed body, so the test reproduces that.
  let changed: boolean | undefined
  r3Computed(() => {
    changed = replayDeps(records)
    return null
  })

  expect(changed).toBe(true)
  // Only true if the walk continued past the first change and read `derived`.
  expect(derived.value).toBe(50)
})
