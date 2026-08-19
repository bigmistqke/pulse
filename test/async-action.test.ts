import { expect, test, vi } from 'vitest'
import { action, committed, computed, read, signal } from '../src/index'
import {
  catchError,
  createRoot,
  createSubOwner,
  getOwner,
  runWithOwner,
  type FailedScope,
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
 * resolves either way, and a failure is reported through `error()` instead.
 */

test('an async action holds the speculation open across the await and commits on success', async () => {
  const [name, setName] = signal('alice')
  const save = (v: string) => tick().then(() => v)

  const handle = action(function* () {
    setName('bob') // optimistic write
    const saved: string = yield* read(save('bob')) // the mutation; scope stays open
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

test('an async action rolls back every speculative write when the mutation fails', async () => {
  const [name, setName] = signal('alice')
  const save = () => tick().then<string>(() => Promise.reject(new Error('save failed')))

  const handle = action(function* () {
    setName('bob')
    yield* read(save())
    setName('never') // unreachable
  })

  await handle.settled
  // Discarded: the speculative writes vanish; committed state never moved.
  expect(name()).toBe('alice')
  expect(committed(name)).toBe('alice')
  expect(handle.error()).toBeInstanceOf(Error)
  expect((handle.error() as Error).message).toBe('save failed')
})

test('derived state follows the speculation across the await', async () => {
  const [n, setN] = signal(1)
  const doubled = computed(() => n() * 2)
  const save = () => tick()

  const handle = action(function* () {
    setN(5)
    yield* read(save())
    // Resumed inside the scope: the derivation still sees the speculative value.
    expect(doubled()).toBe(10)
    expect(committed(doubled)).toBe(2)
  })

  await handle.settled
  expect(doubled()).toBe(10)
})

// ---- async (non-generator) bodies: the common write-then-await shape ----

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

test('two concurrent async actions are isolated from each other', async () => {
  const [a, setA] = signal('a0')
  const [b, setB] = signal('b0')
  const slow = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const first = action(function* () {
    setA('a1')
    yield* read(slow(20))
  })
  const second = action(function* () {
    setB('b1')
    yield* read(slow(5))
  })

  await Promise.all([first.settled, second.settled])
  expect(committed(a)).toBe('a1')
  expect(committed(b)).toBe('b1')
})

// ---- ActionHandle-specific behaviour ----

test('a sync body that throws does not throw synchronously; the failure is reported through error()', async () => {
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

test('retry() re-runs the action from scratch after a failure', async () => {
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
    yield* read(save())
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

test('settled reflects whichever attempt is current, so reading it again after retry() gives a new promise', async () => {
  let attempt = 0
  const save = () =>
    tick().then(() => {
      attempt++
      if (attempt === 1) throw new Error('save failed')
    })

  const handle = action(function* () {
    yield* read(save())
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
    yield* read(save())
  })

  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)

  handle.retry()
  // The retried attempt is still in flight (parked on resolveSecond below),
  // but error() must already be cleared rather than stuck on the previous
  // attempt's failure.
  expect(handle.error()).toBeNull()

  resolveSecond!()
  await handle.settled
  expect(handle.error()).toBeNull()
})

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
    yield* read(save())
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

test('action() skips a nearer FailedScope whose for declines the error, registering with a farther one that accepts', async () => {
  const outerReports: unknown[] = []
  const innerReports: unknown[] = []

  const handle = createRoot(() => {
    const outer = createSubOwner(getOwner())
    outer.boundaries.failed = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      register: () => ({
        report: (state) => {
          if (state.status === 'failed') outerReports.push(state.error)
        },
        unregister: () => {},
      }),
      reset: () => {},
    }

    return runWithOwner(outer, () => {
      const inner = createSubOwner(getOwner())
      inner.boundaries.failed = {
        kind: 'failed',
        active: () => false,
        error: () => null,
        for: (e): e is RangeError => e instanceof RangeError,
        register: () => ({
          report: (state) => {
            if (state.status === 'failed') innerReports.push(state.error)
          },
          unregister: () => {},
        }),
        reset: () => {},
      }

      return runWithOwner(inner, () =>
        action(function* () {
          yield* read(Promise.reject(new TypeError('boom')))
        }),
      )
    })
  })

  await handle.settled

  expect(innerReports).toEqual([])
  expect(outerReports).toHaveLength(1)
  expect((outerReports[0] as Error).message).toBe('boom')
})

test('action() with no explicit <Failed> anywhere still reaches the implicit root, unaffected by candidate collection', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const handle = createRoot(() =>
    action(function* () {
      yield* read(Promise.reject(new Error('boom')))
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

test('action() stops candidate-collection at the nearest catchError, never reaching a farther <Failed> (the implicit root)', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  let handle!: ReturnType<typeof action>
  createRoot(() => {
    catchError(
      () => {
        handle = action(function* () {
          yield* read(Promise.reject(new Error('boom')))
        })
      },
      () => {},
    )
  })
  await handle.settled
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
})

test('action() moves a claim to a boundary that now accepts a retry, releasing the one that claimed an earlier, differently-typed failure', async () => {
  const outerReports: unknown[] = []
  const outerUnregisters: number[] = []
  const innerReports: unknown[] = []
  const innerUnregisters: number[] = []
  let attempt = 0

  const handle = createRoot(() => {
    const outer = createSubOwner(getOwner())
    outer.boundaries.failed = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      register: () => ({
        report: (state) => {
          if (state.status === 'failed') outerReports.push(state.error)
        },
        unregister: () => outerUnregisters.push(1),
      }),
      reset: () => {},
    }

    return runWithOwner(outer, () => {
      const inner = createSubOwner(getOwner())
      inner.boundaries.failed = {
        kind: 'failed',
        active: () => false,
        error: () => null,
        for: (e): e is RangeError => e instanceof RangeError,
        register: () => ({
          report: (state) => {
            if (state.status === 'failed') innerReports.push(state.error)
          },
          unregister: () => innerUnregisters.push(1),
        }),
        reset: () => {},
      }

      return runWithOwner(inner, () =>
        action(function* () {
          attempt++
          yield* read(
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
  // on a failure that now belongs to a different boundary.
  expect(innerUnregisters).toEqual([1])
})

test('action() moves a claim back to a nearer boundary once a retry fails with an error that boundary accepts, even though a farther boundary already claimed an earlier failure', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const innerReports: unknown[] = []
  let attempt = 0

  const handle = createRoot(() => {
    const inner = createSubOwner(getOwner())
    inner.boundaries.failed = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      for: (e): e is RangeError => e instanceof RangeError,
      register: () => ({
        report: (state) => {
          if (state.status === 'failed') innerReports.push(state.error)
        },
        unregister: () => {},
      }),
      reset: () => {},
    }

    return runWithOwner(inner, () =>
      action(function* () {
        attempt++
        yield* read(Promise.reject(attempt === 1 ? new TypeError('t') : new RangeError('r')))
      }),
    )
  })

  await handle.settled
  // Nothing explicit accepts a TypeError here — the implicit root (the only
  // farther candidate) claims it, exactly like any other unboundaried failure.
  expect(innerReports).toEqual([])
  expect(spy).toHaveBeenCalledTimes(1)

  handle.retry() // fails with a RangeError this time — the inner, nearer,
  // explicit boundary accepts it, even though the farther implicit root
  // (which accepts everything) already holds the claim from the first failure.
  await handle.settled

  expect(innerReports).toHaveLength(1)
  expect((innerReports[0] as Error).message).toBe('r')
  // The root must not receive a second report — the claim moved, not copied.
  expect(spy).toHaveBeenCalledTimes(1)
  spy.mockRestore()
})
