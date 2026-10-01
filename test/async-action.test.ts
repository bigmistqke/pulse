import { expect, test, vi } from 'vitest'
import { action, committed, computed, from, signal } from '../src/index'
import {
  catchError,
  createRoot,
  createSubOwner,
  getOwner,
  runWithOwner,
  type ErrorScope,
} from '../src/owner'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * TARGET BEHAVIOUR — async actions.
 *
 * An action body may be a generator. The driver resumes it inside the action's
 * scope, so the speculation stays open across a `yield*` and writes made AFTER
 * the await are still speculative. The action commits when the body completes and
 * discards (rolling back every speculative write) when it throws.
 *
 * `action()` returns an ActionHandle rather than a promise that rejects: `settled`
 * resolves either way, and an error is reported through `error()` instead.
 */

/**
 * @canon rule-an-action-body-is-speculative-while-pulse-drives-it
 */
test('an async action holds the speculation open across the await and commits on success', async () => {
  const [name, setName] = signal('alice')
  const save = (v: string) => tick().then(() => v)

  const handle = action(function* () {
    setName('bob') // optimistic write
    const saved: string = yield* from(save('bob')) // the mutation; scope stays open
    setName(`${saved}!`) // a write AFTER the await must still be speculative
  })

  // In flight: committed state is untouched.
  expect(committed(name)).toBe('alice')

  await handle.settled
  // Completed: every write in the body commits together, atomically.
  expect(committed(name)).toBe('bob!')
  expect(name()).toBe('bob!')
  expect(handle.error()).toBeNull()
})

/**
 * @canon rule-a-discard-leaves-no-trace
 */
test('an async action rolls back every speculative write when the mutation fails', async () => {
  const [name, setName] = signal('alice')
  const save = () => tick().then<string>(() => Promise.reject(new Error('save failed')))

  const handle = action(function* () {
    setName('bob')
    yield* from(save())
    setName('never') // unreachable
  })

  await handle.settled
  // Discarded: the speculative writes vanish; committed state never moved.
  expect(name()).toBe('alice')
  expect(committed(name)).toBe('alice')
  expect(handle.error()).toBeInstanceOf(Error)
  expect((handle.error() as Error).message).toBe('save failed')
})

/**
 * @canon rule-an-action-body-is-speculative-while-pulse-drives-it
 */
test('derived state follows the speculation across the await', async () => {
  const [n, setN] = signal(1)
  const doubled = computed(() => n() * 2)
  const save = () => tick()

  const handle = action(function* () {
    setN(5)
    yield* from(save())
    // Resumed inside the scope: the derivation still sees the speculative value.
    expect(doubled()).toBe(10)
    expect(committed(doubled)).toBe(2)
  })

  await handle.settled
  expect(doubled()).toBe(10)
})

// ---- async (non-generator) bodies: the common write-then-await shape ----

/**
 * @canon rule-an-action-body-is-speculative-while-pulse-drives-it
 */
test('an async body: the sync prefix is speculative and commits when the mutation resolves', async () => {
  const [name, setName] = signal('alice')
  const handle = action(async () => {
    setName('bob') // sync prefix — runs under the scope
    expect(committed(name)).toBe('alice') // isolated
    await tick() // the mutation
  })
  expect(committed(name)).toBe('alice') // in flight — not committed yet
  await handle.settled
  expect(committed(name)).toBe('bob') // resolved → committed
})

/**
 * @canon rule-a-discard-leaves-no-trace
 */
test('an async body rolls back when the mutation rejects', async () => {
  const [name, setName] = signal('alice')
  const handle = action(async () => {
    setName('bob')
    await tick().then(() => Promise.reject(new Error('save failed')))
  })
  await handle.settled
  expect(name()).toBe('alice') // rolled back
  expect(committed(name)).toBe('alice')
  expect(handle.error()).toBeInstanceOf(Error)
  expect((handle.error() as Error).message).toBe('save failed')
})

// SHARP EDGE — documented behaviour, not a bug to fix.
//
// In an ASYNC body only the synchronous prefix runs under the scope. After the
// first `await` the async function has returned to us and the ambient scope has
// unwound, so the continuation runs with the scope back at root: a write there
// lands in COMMITTED state immediately, and the action's later commit then
// promotes the earlier speculative value on top of it — losing the write.
//
// Use a GENERATOR body when you need to write after awaiting (see the tests
// above): pulse drives those resumptions itself and re-enters the scope.
/**
 * @canon exception-a-write-after-an-await-escapes-the-speculation
 */
test('SHARP EDGE: a write after an await in an async body escapes the speculation', async () => {
  const [name, setName] = signal('alice')
  const handle = action(async () => {
    setName('bob') // speculative
    await tick()
    setName('after') // NOT speculative — goes straight to committed state
  })
  await handle.settled
  // The post-await write hit committed state, then commit promoted 'bob' over it.
  expect(committed(name)).toBe('bob')
})

/**
 * @canon exception-a-write-after-an-await-escapes-the-speculation
 */
test('a write after an await is visible outside the action before the action settles', async () => {
  const [name, setName] = signal('alice')
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const handle = action(async () => {
    await tick()
    setName('after')
    await gate
  })
  await tick()
  await tick()
  expect(name()).toBe('after')
  expect(committed(name)).toBe('after')
  release()
  await handle.settled
})

/**
 * @canon exception-a-write-after-an-await-escapes-the-speculation
 */
test('a discard leaves a write made after an await in place', async () => {
  const [name, setName] = signal('alice')
  const [other, setOther] = signal('x0')
  const handle = action(async () => {
    setOther('x1') // speculative: discarded with the action
    await tick()
    setName('after') // escaped: already committed
    throw new Error('fail')
  })
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  expect(committed(other)).toBe('x0')
  expect(committed(name)).toBe('after')
})

/**
 * @canon rule-sibling-speculations-do-not-see-each-other
 */
test('two concurrent async actions are isolated from each other', async () => {
  const [a, setA] = signal('a0')
  const [b, setB] = signal('b0')
  const slow = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const seenByFirst: string[] = []
  const seenBySecond: string[] = []

  const first = action(function* () {
    setA('a1')
    yield* from(slow(20))
    seenByFirst.push(b()) // the second action has written b, and is still open or committed
  })
  const second = action(function* () {
    setB('b1')
    seenBySecond.push(a()) // the first action has written a and is still open
    yield* from(slow(5))
  })

  await Promise.all([first.settled, second.settled])
  expect(seenBySecond).toEqual(['a0']) // never the first action's open write
  expect(seenByFirst).toEqual(['b1']) // the second action had committed by then
  expect(committed(a)).toBe('a1')
  expect(committed(b)).toBe('b1')
})

/**
 * @canon rule-overlapping-writes-resolve-by-commit-order
 */
test('two actions writing the same signal: the one that commits last wins', async () => {
  const [x, setX] = signal('x0')
  const firstGate = Promise.withResolvers<void>()
  const secondGate = Promise.withResolvers<void>()

  const first = action(function* () {
    setX('first') // written first
    yield* from(firstGate.promise)
  })
  const second = action(function* () {
    setX('second') // written second
    yield* from(secondGate.promise)
  })

  secondGate.resolve()
  await second.settled
  expect(committed(x)).toBe('second')

  firstGate.resolve() // commits last, though it wrote first
  await first.settled
  expect(committed(x)).toBe('first')
})

// ---- ActionHandle-specific behaviour ----

/**
 * @canon rule-a-failed-action-is-reported-not-thrown
 */
test('a sync body that throws does not throw synchronously; the error is reported through error()', async () => {
  let ran = false
  const handle = action(() => {
    ran = true
    throw new Error('sync boom')
  })
  expect(ran).toBe(true) // the body did run
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  expect((handle.error() as Error).message).toBe('sync boom')
})

/**
 * @canon rule-retry-runs-the-action-again-as-a-new-speculation
 */
test('retry() re-runs the action from scratch after an error', async () => {
  const [name, setName] = signal('alice')
  let attempt = 0
  const save = () =>
    tick().then(() => {
      attempt++
      if (attempt === 1) throw new Error('save failed')
      return 'bob'
    })

  const handle = action(function* () {
    setName('bob')
    yield* from(save())
  })

  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  expect(name()).toBe('alice') // rolled back

  handle.retry()
  await handle.settled
  expect(handle.error()).toBeNull()
  expect(committed(name)).toBe('bob')
  expect(attempt).toBe(2)
})

/**
 * @canon rule-the-handle-reports-its-newest-attempt
 */
test('settled reflects whichever attempt is current, so reading it again after retry() gives a new promise', async () => {
  let attempt = 0
  const save = () =>
    tick().then(() => {
      attempt++
      if (attempt === 1) throw new Error('save failed')
    })

  const handle = action(function* () {
    yield* from(save())
  })

  const first = handle.settled
  await first
  expect(handle.error()).toBeInstanceOf(Error)

  handle.retry()
  const second = handle.settled
  expect(second).not.toBe(first)
  await second
  expect(handle.error()).toBeNull()
})

/**
 * @canon rule-retry-runs-the-action-again-as-a-new-speculation
 */
test('retry() clears error() synchronously, before the new attempt has settled', async () => {
  let attempt = 0
  let resolveSecond: (() => void) | null = null
  const save = () =>
    new Promise<void>((resolve, reject) => {
      attempt++
      if (attempt === 1) reject(new Error('first failed'))
      else resolveSecond = resolve
    })

  const handle = action(function* () {
    yield* from(save())
  })

  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)

  handle.retry()
  // The retried attempt is still in flight (parked on resolveSecond below),
  // but error() must already be cleared rather than stuck on the previous
  // attempt's error.
  expect(handle.error()).toBeNull()

  resolveSecond!()
  await handle.settled
  expect(handle.error()).toBeNull()
})

/**
 * @canon rule-the-handle-reports-its-newest-attempt
 */
test('a superseded attempt settling later does not overwrite the outcome of a newer one', async () => {
  let callCount = 0
  let resolveSlow: (() => void) | null = null
  const save = () =>
    new Promise<void>((resolve, reject) => {
      callCount++
      if (callCount === 1) reject(new Error('first failed'))
      else if (callCount === 2) resolveSlow = resolve // superseded before it settles
      else reject(new Error('third failed')) // the attempt that supersedes it
    })

  const handle = action(function* () {
    yield* from(save())
  })

  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error) // attempt 1 failed

  handle.retry() // attempt 2 starts — slow, parked on resolveSlow
  handle.retry() // attempt 3 starts, superseding attempt 2 — fails right away
  await handle.settled
  expect((handle.error() as Error).message).toBe('third failed')

  resolveSlow!() // the superseded attempt 2 finally settles, long after attempt 3
  await tick()
  expect((handle.error() as Error).message).toBe('third failed') // unchanged
})

/**
 * @canon rule-a-failed-action-reports-to-the-nearest-accepting-boundary-above-its-caller
 */
test('action() skips a nearer ErrorScope whose for declines the error, registering with a farther one that accepts', async () => {
  const outerReports: unknown[] = []
  const innerReports: unknown[] = []

  const handle = createRoot(() => {
    const outer = createSubOwner(getOwner())
    outer.boundaries.error = {
      kind: 'error',
      active: () => false,
      error: () => null,
      reports: () => [],
      register: () => ({
        report: (state) => {
          if (state.status === 'error') outerReports.push(state.error)
        },
        unregister: () => {},
      }),
      reset: () => {},
      resetMatching: () => {},
    }

    return runWithOwner(outer, () => {
      const inner = createSubOwner(getOwner())
      inner.boundaries.error = {
        kind: 'error',
        active: () => false,
        error: () => null,
        reports: () => [],
        for: (e): e is RangeError => e instanceof RangeError,
        register: () => ({
          report: (state) => {
            if (state.status === 'error') innerReports.push(state.error)
          },
          unregister: () => {},
        }),
        reset: () => {},
        resetMatching: () => {},
      }

      return runWithOwner(inner, () =>
        action(function* () {
          yield* from(Promise.reject(new TypeError('boom')))
        }),
      )
    })
  })

  await handle.settled

  expect(innerReports).toEqual([])
  expect(outerReports).toHaveLength(1)
  expect((outerReports[0] as Error).message).toBe('boom')
})

/**
 * @canon rule-every-root-has-an-error-boundary
 */
test('action() with no explicit <Errored> anywhere still reaches the implicit root, unaffected by candidate collection', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const handle = createRoot(() =>
    action(function* () {
      yield* from(Promise.reject(new Error('boom')))
    }),
  )
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  // handle.error() is set unconditionally by the settle handler regardless
  // of candidate collection — the implicit root actually being reached is
  // what this test is about, so assert its own, distinct signal too.
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
  spy.mockRestore()
})

/**
 * @canon rule-a-failed-action-reports-to-the-nearest-accepting-boundary-above-its-caller
 */
test('a failed action under a catchError calls its handler, and the root boundary beyond it hears nothing', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const handled: unknown[] = []
  let handle!: ReturnType<typeof action>
  createRoot(() => {
    catchError(
      () => {
        handle = action(function* () {
          yield* from(Promise.reject(new Error('boom')))
        })
      },
      (e) => handled.push(e),
    )
  })
  await handle.settled
  expect((handled[0] as Error).message).toBe('boom') // the catchError claimed it
  expect(handled).toHaveLength(1)
  expect(spy).not.toHaveBeenCalled() // the root's default boundary never logged it
  expect((handle.error() as Error).message).toBe('boom')
  spy.mockRestore()
})

/**
 * @canon rule-a-failed-action-reports-to-the-nearest-accepting-boundary-above-its-caller
 */
test('a catchError whose for declines the error passes a failed action on to the boundary beyond it', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const handled: unknown[] = []
  let handle!: ReturnType<typeof action>
  createRoot(() => {
    catchError(
      () => {
        handle = action(function* () {
          yield* from(Promise.reject(new Error('boom')))
        })
      },
      (e) => handled.push(e),
      { for: () => false },
    )
  })
  await handle.settled
  expect(handled).toEqual([]) // declined
  expect(spy).toHaveBeenCalled() // the root's default boundary took it and logged it
  spy.mockRestore()
})

/**
 * @canon rule-a-failed-action-chooses-its-boundary-again-on-every-failure
 */
test('action() moves a claim to a boundary that now accepts a retry, releasing the one that claimed an earlier, differently-typed error', async () => {
  const outerReports: unknown[] = []
  const outerUnregisters: number[] = []
  const innerReports: unknown[] = []
  const innerUnregisters: number[] = []
  let attempt = 0

  const handle = createRoot(() => {
    const outer = createSubOwner(getOwner())
    outer.boundaries.error = {
      kind: 'error',
      active: () => false,
      error: () => null,
      reports: () => [],
      register: () => ({
        report: (state) => {
          if (state.status === 'error') outerReports.push(state.error)
        },
        unregister: () => outerUnregisters.push(1),
      }),
      reset: () => {},
      resetMatching: () => {},
    }

    return runWithOwner(outer, () => {
      const inner = createSubOwner(getOwner())
      inner.boundaries.error = {
        kind: 'error',
        active: () => false,
        error: () => null,
        reports: () => [],
        for: (e): e is RangeError => e instanceof RangeError,
        register: () => ({
          report: (state) => {
            if (state.status === 'error') innerReports.push(state.error)
          },
          unregister: () => innerUnregisters.push(1),
        }),
        reset: () => {},
        resetMatching: () => {},
      }

      return runWithOwner(inner, () =>
        action(function* () {
          attempt++
          yield* from(
            Promise.reject(attempt === 1 ? new RangeError('r') : new TypeError('t')),
          )
        }),
      )
    })
  })

  await handle.settled
  expect(innerReports).toHaveLength(1) // inner claimed the RangeError
  expect(outerReports).toEqual([])

  handle.retry() // fails with a TypeError this time — inner declines it
  await handle.settled

  expect(innerReports).toHaveLength(1) // inner never received the TypeError
  expect(outerReports).toHaveLength(1) // outer received it instead
  expect((outerReports[0] as Error).message).toBe('t')
  expect(outerUnregisters).toEqual([]) // outer was never claimed-then-released
  // inner WAS claimed and then released: this is the actual release the
  // claim's move depends on — without it, inner would stay latched active
  // on an error that now belongs to a different boundary.
  expect(innerUnregisters).toEqual([1])
})

/**
 * @canon rule-a-failed-action-chooses-its-boundary-again-on-every-failure
 */
test('action() moves a claim back to a nearer boundary once a retry fails with an error that boundary accepts, even though a farther boundary already claimed an earlier error', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const innerReports: unknown[] = []
  let attempt = 0

  const handle = createRoot(() => {
    const inner = createSubOwner(getOwner())
    inner.boundaries.error = {
      kind: 'error',
      active: () => false,
      error: () => null,
      reports: () => [],
      for: (e): e is RangeError => e instanceof RangeError,
      register: () => ({
        report: (state) => {
          if (state.status === 'error') innerReports.push(state.error)
        },
        unregister: () => {},
      }),
      reset: () => {},
      resetMatching: () => {},
    }

    return runWithOwner(inner, () =>
      action(function* () {
        attempt++
        yield* from(Promise.reject(attempt === 1 ? new TypeError('t') : new RangeError('r')))
      }),
    )
  })

  await handle.settled
  // Nothing explicit accepts a TypeError here — the implicit root (the only
  // farther candidate) claims it, exactly like any other unboundaried error.
  expect(innerReports).toEqual([])
  expect(spy).toHaveBeenCalledTimes(1)

  handle.retry() // fails with a RangeError this time — the inner, nearer,
  // explicit boundary accepts it, even though the farther implicit root
  // (which accepts everything) already holds the claim from the first error.
  await handle.settled

  expect(innerReports).toHaveLength(1)
  expect((innerReports[0] as Error).message).toBe('r')
  // The root must not receive a second report — the claim moved, not copied.
  expect(spy).toHaveBeenCalledTimes(1)
  spy.mockRestore()
})
