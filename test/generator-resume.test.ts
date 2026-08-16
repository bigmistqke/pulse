import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { signal } from '../src/signal'
import { latest, read } from '../src/async'
import { createRoot } from '../src/owner'
import { failure, resetFailure } from '../src/failure'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick()
}

test('a generator stage that builds its promise inside the body converges', async () => {
  let promisesCreated = 0
  const makePromise = () => {
    promisesCreated++
    return new Promise<number>((resolve) => setTimeout(() => resolve(7), 1))
  }

  const c = computed(function* () {
    const x: number = yield* read(makePromise())
    return x + 100
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(107)
  expect(promisesCreated).toBe(1)
})

test('the code before a pause runs once, not once per settle', async () => {
  let before = 0
  const c = computed(function* () {
    before++
    const x: number = yield* read(
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 1)),
    )
    return x
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(1)
  expect(before).toBe(1)
})

test('a generator with two inline pauses converges and builds each promise once', async () => {
  let firstCreated = 0
  let secondCreated = 0

  const c = computed(function* () {
    const a: number = yield* read(
      new Promise<number>((resolve) => {
        firstCreated++
        setTimeout(() => resolve(1), 1)
      }),
    )
    const b: number = yield* read(
      new Promise<number>((resolve) => {
        secondCreated++
        setTimeout(() => resolve(2), 1)
      }),
    )
    return a + b
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(3)
  expect(firstCreated).toBe(1)
  expect(secondCreated).toBe(1)
})

test('a signal read before a pause stays a dependency across a resume', async () => {
  // The failure this guards against: resuming runs only the code after the
  // pause, so r3 would drop `a` unless the recorded dependencies are replayed.
  const [a, setA] = signal(1)
  let runs = 0

  const c = computed(function* () {
    runs++
    const av: number = yield* read(a)
    const p: number = yield* read(
      new Promise<number>((resolve) => setTimeout(() => resolve(10), 1)),
    )
    return av + p
  })

  c()
  await ticks(10)
  expect(latest(c)).toBe(11)

  setA(2)
  await ticks(10)
  expect(latest(c)).toBe(12)
  expect(runs).toBeGreaterThan(1)
})

test('a dependency changing mid-pause discards the generator and restarts', async () => {
  // The branch that makes retention safe. Without it a stale partial
  // computation would finish and publish a value derived from the old input.
  // Test 4 above changes `a` only after the generator has already resolved, so
  // it exercises a restart from idle, not this branch.
  const [a, setA] = signal(1)
  let bodyRuns = 0
  let promisesCreated = 0

  const c = computed(function* () {
    bodyRuns++
    const av: number = yield* read(a)
    const p: number = yield* read(
      new Promise<number>((resolve) => {
        promisesCreated++
        setTimeout(() => resolve(10), 50)
      }),
    )
    return av + p
  })

  c()
  await tick() // paused on the 50ms promise; nothing has settled
  expect(bodyRuns).toBe(1)
  expect(promisesCreated).toBe(1)

  setA(2) // changes a dependency the generator already read, while it is paused
  await tick()

  expect(bodyRuns).toBe(2) // restarted from the top
  expect(promisesCreated).toBe(2) // built a fresh promise

  await ticks(80)
  // 12, not 11: the restart used the new value of `a`. A resumed stale
  // generator would still be holding 1.
  expect(latest(c)).toBe(12)
})

test('a rejected inline promise reaches the generator try/catch', async () => {
  const c = computed(function* () {
    try {
      yield* read(
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('boom')), 1),
        ),
      )
      return 'unreachable'
    } catch (e) {
      return `caught: ${(e as Error).message}`
    }
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe('caught: boom')
})

test('a discarded generator runs its finally block', async () => {
  const [a, setA] = signal(1)
  let opened = 0
  let closed = 0

  const c = computed(function* () {
    const av: number = yield* read(a)
    opened++
    try {
      const p: number = yield* read(
        new Promise<number>((resolve) => setTimeout(() => resolve(10), 5)),
      )
      return av + p
    } finally {
      closed++
    }
  })

  c()
  await tick() // let the first run reach its pause, but not settle
  setA(2) // dependency read before the pause changed -> discard and restart

  await ticks(10)

  expect(opened).toBe(2)
  expect(closed).toBe(2) // the discarded generator's finally ran, and the second one's
  expect(latest(c)).toBe(12)
})

test('a finally block reading a signal during a discard adds no dependency', async () => {
  // Scoped deliberately to the discard path. `untrack` wraps `gen.return()`,
  // not the whole generator — a `finally` that runs because the generator
  // completed normally runs inside the tracked body, and its reads SHOULD be
  // tracked like any other body code. So this asserts before the replacement
  // generator has had a chance to settle.
  const [a, setA] = signal(1)
  const [unrelated, setUnrelated] = signal(0)
  let runs = 0

  const c = computed(function* () {
    runs++
    const av: number = yield* read(a)
    try {
      const p: number = yield* read(
        new Promise<number>((resolve) => setTimeout(() => resolve(10), 50)),
      )
      return av + p
    } finally {
      unrelated() // read during the discard; must not become a dependency
    }
  })

  c()
  await tick()
  setA(2) // discards the first generator, running its finally untracked
  await tick()

  // The replacement is paused on its own 50ms promise and has not run its
  // finally. If the discard leaked a dependency, this write restarts the stage.
  const runsWhilePaused = runs
  setUnrelated(99)
  await ticks(3)

  expect(runs).toBe(runsWhilePaused)
})

test('resetting a parked failure discards a generator that has since re-paused', async () => {
  // Covers the `discardGen()` call in the failure entry's `reset`. Reaching a
  // live generator there takes three steps: the stage fails and parks the
  // failure (which leaves no retained generator); an unrelated dependency
  // change then reruns the body, which starts a fresh generator and pauses,
  // without clearing the stale parked failure; and only then does a reset
  // arrive, landing on a generator that is genuinely mid-pause.
  const [a, setA] = signal(1)
  let attempt = 0
  let closed = 0

  const c = computed(function* () {
    attempt++
    const mine = attempt
    const av: number = yield* read(a)
    try {
      if (mine === 1) {
        yield* read(Promise.reject(new Error('boom')))
      }
      const p: number = yield* read(
        new Promise<number>((resolve) => setTimeout(() => resolve(10), 100)),
      )
      return av + p
    } finally {
      closed++
    }
  })

  c()
  await ticks(5)
  expect(failure(c)).toBeInstanceOf(Error) // parked, no generator retained
  const closedAfterFailure = closed

  setA(2) // unrelated change: a fresh generator starts and pauses
  await tick()
  expect(closed).toBe(closedAfterFailure) // still paused, finally has not run

  resetFailure(c) // must tear down the live generator
  expect(closed).toBe(closedAfterFailure + 1)
})

test('disposing the owner runs a paused generator finally block', async () => {
  let closed = 0
  let dispose!: () => void

  createRoot((d) => {
    dispose = d
    const c = computed(function* () {
      try {
        return yield* read(
          new Promise<number>((resolve) => setTimeout(() => resolve(1), 50)),
        )
      } finally {
        closed++
      }
    })
    c()
  })

  await tick()
  expect(closed).toBe(0) // still paused

  dispose()
  expect(closed).toBe(1)
})
