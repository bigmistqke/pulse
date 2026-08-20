import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { signal } from '../src/signal'
import { peek, from, use } from '../src/async'
import { createRoot } from '../src/owner'
import { error, resetError } from '../src/error'

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
    const x: number = yield* from(makePromise())
    return x + 100
  })

  c()
  await ticks(10)

  expect(peek(c)).toBe(107)
  expect(promisesCreated).toBe(1)
})

test('the code before a pause runs once, not once per settle', async () => {
  let before = 0
  const c = computed(function* () {
    before++
    const x: number = yield* from(
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 1)),
    )
    return x
  })

  c()
  await ticks(10)

  expect(peek(c)).toBe(1)
  expect(before).toBe(1)
})

test('a generator with two inline pauses converges and builds each promise once', async () => {
  let firstCreated = 0
  let secondCreated = 0

  const c = computed(function* () {
    const a: number = yield* from(
      new Promise<number>((resolve) => {
        firstCreated++
        setTimeout(() => resolve(1), 1)
      }),
    )
    const b: number = yield* from(
      new Promise<number>((resolve) => {
        secondCreated++
        setTimeout(() => resolve(2), 1)
      }),
    )
    return a + b
  })

  c()
  await ticks(10)

  expect(peek(c)).toBe(3)
  expect(firstCreated).toBe(1)
  expect(secondCreated).toBe(1)
})

test('a signal read before a pause stays a dependency across a resume', async () => {
  // The error this guards against: resuming runs only the code after the
  // pause, so r3 would drop `a` unless the recorded dependencies are replayed.
  const [a, setA] = signal(1)
  let runs = 0

  const c = computed(function* () {
    runs++
    const av: number = yield* from(a)
    const p: number = yield* from(
      new Promise<number>((resolve) => setTimeout(() => resolve(10), 1)),
    )
    return av + p
  })

  c()
  await ticks(10)
  expect(peek(c)).toBe(11)

  setA(2)
  await ticks(10)
  expect(peek(c)).toBe(12)
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
    const av: number = yield* from(a)
    const p: number = yield* from(
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
  expect(peek(c)).toBe(12)
})

test('a rejected inline promise reaches the generator try/catch', async () => {
  const c = computed(function* () {
    try {
      yield* from(
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

  expect(peek(c)).toBe('caught: boom')
})

test('a discarded generator runs its finally block', async () => {
  const [a, setA] = signal(1)
  let opened = 0
  let closed = 0

  const c = computed(function* () {
    const av: number = yield* from(a)
    opened++
    try {
      const p: number = yield* from(
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
  expect(peek(c)).toBe(12)
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
    const av: number = yield* from(a)
    try {
      const p: number = yield* from(
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

test('resetting a parked error discards a generator that has since re-paused', async () => {
  // Covers the `discardGen()` call in the error entry's `reset`. Reaching a
  // live generator there takes three steps: the stage fails and parks the
  // error (which leaves no retained generator); an unrelated dependency
  // change then reruns the body, which starts a fresh generator and pauses,
  // without clearing the stale parked error; and only then does a reset
  // arrive, landing on a generator that is genuinely mid-pause.
  const [a, setA] = signal(1)
  let attempt = 0
  let closed = 0

  const c = computed(function* () {
    attempt++
    const mine = attempt
    const av: number = yield* from(a)
    try {
      if (mine === 1) {
        yield* from(Promise.reject(new Error('boom')))
      }
      const p: number = yield* from(
        new Promise<number>((resolve) => setTimeout(() => resolve(10), 100)),
      )
      return av + p
    } finally {
      closed++
    }
  })

  c()
  await ticks(5)
  expect(error(c)).toBeInstanceOf(Error) // parked, no generator retained
  const closedAfterError = closed

  setA(2) // unrelated change: a fresh generator starts and pauses
  await tick()
  expect(closed).toBe(closedAfterError) // still paused, finally has not run

  resetError(c) // must tear down the live generator
  expect(closed).toBe(closedAfterError + 1)
})

test('disposing the owner runs a paused generator finally block', async () => {
  let closed = 0
  let dispose!: () => void

  createRoot((d) => {
    dispose = d
    const c = computed(function* () {
      try {
        return yield* from(
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

test('a generator stage repeatedly hitting use() on the same still-pending promise attaches no extra settle listener', async () => {
  // Regression guard for an interaction between two fixes: discarding a
  // generator that reached the NotReadyYet catch (a `use()` call, not a
  // `yield`) must not disturb `suspendedOn` when it is still tracking the
  // very promise about to be re-suspended on. If it did, `suspendOn`'s
  // same-promise dedup guard (`if (suspendedOn === p) return`) would be
  // defeated on every repeat hit, each one attaching another `.then`
  // listener to the same promise. That was measured directly: the
  // downstream symptom (an extra body run) is masked because the kick
  // signal that wakes the body coalesces repeat writes into one recompute,
  // so it does not by itself distinguish one listener from several — the
  // attachment count is the direct, load-bearing thing to assert.
  //
  // The baseline count is 2, not 1: `use`'s own `track()` (`src/async.ts`)
  // attaches a `.then` of its own the first time it sees a promise, memoized
  // in a WeakMap independent of `suspendOn` — so what this test asserts is
  // that the count does not grow past that baseline across repeat hits, not
  // that it is exactly 1.
  const [x, setX] = signal(0)
  let resolveP!: (v: number) => void
  let thenCalls = 0
  const p = new Promise<number>((resolve) => {
    resolveP = resolve
  })
  const originalThen = p.then.bind(p)
  p.then = ((...args: Parameters<typeof originalThen>) => {
    thenCalls++
    return originalThen(...args)
  }) as typeof p.then

  const c = computed(function* () {
    x() // read so unrelated writes force a body re-run while p is still pending
    return use(p) as number
  })

  c()
  await tick()
  const baseline = thenCalls
  expect(baseline).toBeGreaterThan(0)

  setX(1)
  await tick()
  setX(2)
  await tick()
  // p is still pending; the body has hit the NotReadyYet catch on it three
  // times in total now, all on the same promise.

  expect(thenCalls).toBe(baseline)

  resolveP(42)
  await ticks(10)

  expect(peek(c)).toBe(42)
})

test('use(promise) inside a generator stage resolves and the stage publishes the derived result', async () => {
  // use() throws NotReadyYet directly out of gen.next() (not via a yield),
  // straight into the sync-stage NotReadyYet catch in makeStageNode. That
  // branch must clear the terminated generator, or every later run takes the
  // dead resume path (replaying an empty dep list, matching input, no
  // stashed resumption) and returns early forever.
  const p = new Promise<number>((r) => setTimeout(() => r(5), 5))
  const c = computed(function* () {
    const x = use(p)
    return (x as number) * 2
  })

  c()
  await ticks(10)

  expect(peek(c)).toBe(10)
})

test('use(...) then yield* from(...) inside a generator stage converges', async () => {
  const [a, setA] = signal(1)
  const c = computed(function* () {
    const viaUse = use(a) as number
    const viaRead: number = yield* from(
      new Promise<number>((resolve) => setTimeout(() => resolve(10), 1)),
    )
    return viaUse + viaRead
  })

  c()
  await ticks(10)
  expect(peek(c)).toBe(11)

  setA(2)
  await ticks(10)
  expect(peek(c)).toBe(12)
})

test('a discarded generator does not leave its abandoned promise able to re-run the stage', async () => {
  // The reproduction: restart into a synchronously-throwing generator, then
  // let the FIRST (abandoned) generator's promise settle. If discardGen()
  // does not clear the in-flight-promise field, the old promise's settle
  // callback still matches (`suspendedOn === p`) and kicks a third run.
  const [a, setA] = signal(1)
  let bodyRuns = 0

  const c = computed(function* () {
    bodyRuns++
    const av: number = yield* from(a)
    if (av === 2) {
      throw new Error('boom')
    }
    const p: number = yield* from(
      new Promise<number>((resolve) => setTimeout(() => resolve(10), 50)),
    )
    return av + p
  })

  c()
  await tick() // paused on the 50ms promise; nothing has settled
  expect(bodyRuns).toBe(1)

  setA(2) // discards the paused generator; the fresh one throws synchronously
  await tick()
  expect(bodyRuns).toBe(2)
  expect(error(c)).toBeInstanceOf(Error)

  // Let the abandoned first generator's promise settle.
  await ticks(80)

  expect(bodyRuns).toBe(2) // not 3 — the abandoned promise must not re-run the stage
})

test('a generator stage that returns a pending promise resolves to its value', async () => {
  const c = computed(function* () {
    return new Promise<number>((resolve) => setTimeout(() => resolve(7), 5))
  })

  c()
  await ticks(20)

  expect(peek(c)).toBe(7)
})

test('a generator stage that pauses and then returns a pending promise resolves to its value', async () => {
  // The same ending reached from a resumed generator rather than a fresh one:
  // the body pauses on a yield, is resumed, and then returns a promise. The
  // generator is finished at that point, so the promise is its result and not
  // a pause to re-enter.
  const c = computed(function* () {
    const first: number = yield* from(
      new Promise<number>((resolve) => setTimeout(() => resolve(3), 5)),
    )
    return new Promise<number>((resolve) => setTimeout(() => resolve(first * 10), 5))
  })

  c()
  await ticks(30)

  expect(peek(c)).toBe(30)
})

test('a generator stage that pauses, resumes, then returns a promise stays reactive', async () => {
  // The reactive guard for the resumed path. The test below covers the same
  // property for a generator that never paused; this one reaches the returned
  // promise through a resumption, which is the path that leaves a generator
  // recorded for longest.
  const [a, setA] = signal(2)
  let bodyRuns = 0

  const c = computed(function* () {
    bodyRuns++
    const av: number = yield* from(a)
    const paused: number = yield* from(
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 5)),
    )
    return new Promise<number>((resolve) => setTimeout(() => resolve(av * 10 + paused), 5))
  })

  c()
  await ticks(30)
  expect(peek(c)).toBe(21)

  setA(5)
  await ticks(30)

  expect(peek(c)).toBe(51)
  expect(bodyRuns).toBe(2)
})

test('a generator stage whose returned promise rejects parks the error', async () => {
  // The rejected half of the same decision. A generator that has already
  // returned cannot catch its returned promise's rejection — the try/catch
  // below is around the `return`, and by the time the promise settles the body
  // is finished, exactly as it would be in an async function.
  const rejecting = computed(function* () {
    return new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error('server said no')), 5),
    )
  })

  rejecting()
  await ticks(30)

  expect(error(rejecting)).toBeInstanceOf(Error)
  expect((error(rejecting) as Error).message).toBe('server said no')
})

test('a generator stage returning a pending promise stays reactive to its dependencies', async () => {
  // Ending the finished generator must also clear the retained-generator field.
  // Left set, the next run would find a finished generator with an empty
  // dependency record, see nothing to resume, and return early forever.
  const [a, setA] = signal(2)

  const c = computed(function* () {
    const av: number = yield* from(a)
    return new Promise<number>((resolve) => setTimeout(() => resolve(av * 10), 5))
  })

  c()
  await ticks(20)
  expect(peek(c)).toBe(20)

  setA(5)
  await ticks(20)

  expect(peek(c)).toBe(50)
})
