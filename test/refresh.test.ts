/**
 * refresh(x): run a derivation's recipe again with unchanged inputs, and the
 * questions around it — isRefreshing, use during a refresh, refresh inside an
 * action.
 */
import { afterEach, expect, test, vi } from 'vitest'
import {
  action,
  computed,
  effect,
  flush,
  onSettled,
  optimistic,
  from,
  isPending,
  isRefreshing,
  peek,
  refresh,
  signal,
  use,
} from '../src/index'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick()
}

afterEach(() => vi.restoreAllMocks())

/** The test runner's Node process, reached without Node's type definitions. */
const { process } = globalThis as unknown as {
  process: {
    on(event: 'unhandledRejection', listener: (reason: unknown) => void): void
    off(event: 'unhandledRejection', listener: (reason: unknown) => void): void
  }
}

/**
 * A source whose every run waits on a promise the test settles by hand:
 * `runs` counts the runs, and `settle(i, value)` lands run `i`.
 */
function controlledSource() {
  const pending: Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }> = []
  let runs = 0
  const source = computed(() => {
    runs++
    return new Promise<string>((resolve, reject) => pending.push({ resolve, reject }))
  })
  return {
    source,
    runs: () => runs,
    settle: (run: number, value: string) => pending[run - 1].resolve(value),
    fail: (run: number, error: unknown) => pending[run - 1].reject(error),
  }
}

/**
 * @canon spec-refresh-reruns-a-derivations-recipe-with-unchanged-inputs
 */
test('refresh runs the recipe again though no input changed, and the new answer lands', async () => {
  const { source, runs, settle } = controlledSource()
  peek(source)
  settle(1, 'first')
  await ticks(2)
  expect(peek(source)).toBe('first')
  expect(runs()).toBe(1)

  refresh(source)
  await ticks(2)
  expect(runs()).toBe(2)
  settle(2, 'second')
  await ticks(2)
  expect(peek(source)).toBe('second')
})

/**
 * @canon spec-a-refresh-reruns-every-stage-of-its-pipeline-once
 */
test('refresh runs every stage of the pipeline once, even a stage whose input is unchanged, and not the derivations it reads', async () => {
  const [id] = signal(1)
  let readRuns = 0
  const read = computed(() => {
    readRuns++
    return 'prefix'
  })
  const stages = { first: 0, fetch: 0, last: 0 }
  const user = computed(
    () => {
      stages.first++
      return id()
    },
    (value: number) => {
      stages.fetch++
      return Promise.resolve(`${read()}-${value}-${stages.fetch}`)
    },
    (value: string) => {
      stages.last++
      return value
    },
  )
  peek(user)
  await ticks(3)
  expect(stages).toEqual({ first: 1, fetch: 1, last: 1 })
  expect(readRuns).toBe(1)

  refresh(user)
  await ticks(3)
  // The first stage hands on the same id, yet the fetch ran again.
  expect(stages).toEqual({ first: 2, fetch: 2, last: 2 })
  expect(peek(user)).toBe('prefix-1-2')
  // `read` is a derivation of its own: it was not refreshed.
  expect(readRuns).toBe(1)
})

/**
 * @canon spec-a-refresh-of-something-it-cannot-rerun-warns
 */
test('refresh of a plain signal or a plain function runs nothing, warns on every call, and resolves to the current value', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const [plain] = signal(5)
  let called = 0
  const notAccessor = () => {
    called++
    return 1
  }

  const fromSignal = await refresh(plain as never)
  await refresh(plain as never)
  const fromFunction = await refresh(notAccessor as never)

  expect(fromSignal).toBe(5)
  expect(fromFunction).toBeUndefined()
  expect(called).toBe(0)
  expect(warn).toHaveBeenCalledTimes(3)
})

/**
 * @canon spec-a-refresh-of-something-it-cannot-rerun-warns
 */
test('refresh of an optimistic value runs nothing, warns, and resolves to the current value', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let runs = 0
  const [value] = optimistic(() => {
    runs++
    return 'held'
  })
  expect(runs).toBe(1)

  const delivered = await refresh(value)
  await ticks(2)

  expect(delivered).toBe('held')
  expect(runs).toBe(1)
  expect(warn).toHaveBeenCalledTimes(1)
})

/**
 * @canon spec-a-refresh-returns-a-promise-for-the-next-settled-value
 */
test('the promise refresh returns delivers the value that lands, and a revision that supersedes it delivers its own', async () => {
  const [n, setN] = signal(1)
  const settlers: Array<(v: number) => void> = []
  const doubled = computed(() => {
    const value = n()
    return new Promise<number>((resolve) => settlers.push(() => resolve(value * 2)))
  })
  peek(doubled)
  settlers[0](0)
  await ticks(2)

  const plain = refresh(doubled)
  await ticks(1)
  settlers[1](0)
  expect(await plain).toBe(2)

  // A revision supersedes a refresh in flight: the promise waits for, and
  // delivers, what finally lands.
  const superseded = refresh(doubled)
  await ticks(1)
  setN(5)
  peek(doubled)
  await ticks(1)
  settlers[settlers.length - 1](0)
  expect(await superseded).toBe(10)
})

/**
 * @canon spec-a-refresh-returns-a-promise-for-the-next-settled-value
 */
test('the promise rejects when the refreshed run fails, and an ignored rejection is not unhandled', async () => {
  const { source, settle, fail } = controlledSource()
  peek(source)
  settle(1, 'ok')
  await ticks(2)

  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  const watched = refresh(source)
  await ticks(1)
  fail(2, new Error('refused'))
  await expect(watched).rejects.toThrow('refused')

  refresh(source) // ignored on purpose
  await ticks(1)
  fail(3, new Error('refused again'))
  await ticks(3)
  process.off('unhandledRejection', unhandled)
  expect(unhandled).not.toHaveBeenCalled()
})

/**
 * @canon spec-a-refresh-abandons-the-run-in-flight
 */
test('several refreshes in one tick run once, and a refresh abandons the run in flight', async () => {
  const { source, runs, settle } = controlledSource()
  peek(source)
  settle(1, 'first')
  await ticks(2)

  refresh(source)
  refresh(source)
  refresh(source)
  await ticks(2)
  expect(runs()).toBe(2)

  // Run 2 is in flight; a refresh abandons it and starts run 3.
  refresh(source)
  await ticks(2)
  expect(runs()).toBe(3)
  const seen: unknown[] = []
  settle(2, 'abandoned')
  await ticks(2)
  seen.push(peek(source))
  settle(3, 'latest')
  await ticks(2)
  seen.push(peek(source))
  // The abandoned run never published.
  expect(seen).toEqual(['first', 'latest'])
})

/**
 * @canon spec-is-refreshing-reports-a-refresh-in-flight
 */
test('isRefreshing is true while a refresh is in flight, and isPending stays false through it', async () => {
  const { source, settle } = controlledSource()
  peek(source)
  settle(1, 'first')
  await ticks(2)
  expect(isRefreshing(source)).toBe(false)

  refresh(source)
  await ticks(2)
  expect(isRefreshing(source)).toBe(true)
  expect(isPending(source)).toBe(false)

  settle(2, 'second')
  await ticks(2)
  expect(isRefreshing(source)).toBe(false)
  expect(isPending(source)).toBe(false)
})

/**
 * @canon spec-is-refreshing-reports-a-refresh-in-flight
 */
test('an effect that reads isRefreshing runs again when a refresh starts and when it lands', async () => {
  const { source, settle } = controlledSource()
  peek(source)
  settle(1, 'first')
  await ticks(2)

  const seen: Array<{ refreshing: boolean; pending: boolean }> = []
  effect(() => {
    seen.push({ refreshing: isRefreshing(source), pending: isPending(source) })
  })
  flush()

  refresh(source)
  await ticks(2)
  flush()
  settle(2, 'second')
  await ticks(2)
  flush()

  expect(seen).toEqual([
    { refreshing: false, pending: false },
    { refreshing: true, pending: false },
    { refreshing: false, pending: false },
  ])
})

/**
 * A source whose every run waits on a promise the test settles by hand, and
 * whose recipe reads the signal `n`, so a write to `n` starts a revision.
 */
function controlledSourceOf(n: () => number) {
  const settlers: Array<(value: string) => void> = []
  const source = computed(() => {
    const value = n()
    return new Promise<string>((resolve) => settlers.push((suffix) => resolve(`${value}${suffix}`)))
  })
  return { source, settle: (run: number, suffix = '') => settlers[run - 1](suffix) }
}

/**
 * @canon spec-is-refreshing-reports-a-refresh-in-flight
 * @canon spec-is-pending-reports-an-unsettled-pipeline
 */
test('a revision that lands in the same run a refresh starts is pending, not refreshing', async () => {
  const [n, setN] = signal(1)
  const { source, settle } = controlledSourceOf(n)
  peek(source)
  settle(1)
  await ticks(2)

  refresh(source)
  // The refresh starts at the end of this tick. The write lands after it
  // starts and before the run it asked for, so one run answers both.
  await Promise.resolve()
  setN(2)
  await ticks(2)

  expect(isPending(source)).toBe(true)
  expect(isRefreshing(source)).toBe(false)
})

/**
 * @canon spec-is-refreshing-reports-a-refresh-in-flight
 * @canon spec-is-pending-reports-an-unsettled-pipeline
 */
test('a revision of an earlier stage during a refresh leaves the later stages pending, not refreshing', async () => {
  const [n, setN] = signal(1)
  const first: Array<(value: number) => void> = []
  const second: Array<(value: string) => void> = []
  const pipeline = computed(
    () => {
      const value = n()
      return new Promise<number>((resolve) => first.push(() => resolve(value)))
    },
    (value: number) => new Promise<string>((resolve) => second.push(() => resolve(`user ${value}`))),
  )
  peek(pipeline)
  first[0](0)
  await ticks(2)
  second[0]('')
  await ticks(2)
  expect(peek(pipeline)).toBe('user 1')

  refresh(pipeline)
  await ticks(2) // the refresh's run of the first stage is in flight
  setN(2) // a revision supersedes it
  await ticks(2)
  first[first.length - 1](0)
  await ticks(2) // the second stage now runs for the revision

  expect(second.length).toBe(2)
  expect(isPending(pipeline)).toBe(true)
  expect(isRefreshing(pipeline)).toBe(false)
})

/**
 * @canon spec-use-returns-the-standing-answer-during-a-refresh
 */
test('during a refresh, use returns the standing answer instead of suspending', async () => {
  const { source, settle } = controlledSource()
  peek(source)
  settle(1, 'standing')
  await ticks(2)

  refresh(source)
  await ticks(2)
  let read: unknown = null
  let threw: unknown = null
  try {
    read = use(source)
  } catch (e) {
    threw = e
  }
  expect(threw).toBeNull()
  expect(read).toBe('standing')
})

/**
 * @canon spec-a-refresh-inside-an-action-is-part-of-its-speculation
 */
test('a refresh inside an action is seen inside it, reaches committed state at commit, and is discarded with it', async () => {
  const { source, settle } = controlledSource()
  peek(source)
  settle(1, 'committed')
  await ticks(2)

  // Commit: the refreshed answer is visible inside, and outside only once committed.
  let insideAfterRefresh: unknown = null
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const committing = action(function* () {
    insideAfterRefresh = yield* from(refresh(source))
    yield* from(held) // keep the action open after the refresh has landed
  })
  await ticks(2) // the refreshed run has started inside the action
  settle(2, 'refreshed')
  await ticks(2)
  const outsideBeforeCommit = peek(source)
  release()
  await committing.settled
  expect(insideAfterRefresh).toBe('refreshed')
  expect(outsideBeforeCommit).toBe('committed')
  expect(peek(source)).toBe('refreshed')

  // Discard: the refreshed answer goes with the action.
  const discarding = action(function* () {
    yield* from(refresh(source))
    throw new Error('a later step failed')
  })
  await ticks(2)
  settle(3, 'discarded')
  await discarding.settled
  expect(peek(source)).toBe('refreshed')
})

/**
 * @canon spec-a-refresh-inside-an-action-is-part-of-its-speculation
 * @canon spec-is-refreshing-reports-a-refresh-in-flight
 */
test('a refresh an action commits is not pending, whether it has landed by then or is still in flight', async () => {
  const { source, settle } = controlledSource()
  peek(source)
  settle(1, 'committed')
  await ticks(2)

  // Landed before the commit: committed state takes the answer at once.
  let atCommit: unknown = null
  const landed = action(function* () {
    yield* from(refresh(source))
    onSettled(() => {
      atCommit = { pending: isPending(source), refreshing: isRefreshing(source), value: peek(source) }
    })
  })
  await ticks(1)
  settle(2, 'landed')
  await landed.settled
  expect(atCommit).toEqual({ pending: false, refreshing: false, value: 'landed' })

  // Still in flight at the commit: committed state carries it as a refresh.
  const inFlight = action(function* () {
    refresh(source)
  })
  await inFlight.settled
  const whileInFlight = { pending: isPending(source), refreshing: isRefreshing(source), value: peek(source) }
  settle(3, 'carried')
  await ticks(2)
  expect(whileInFlight).toEqual({ pending: false, refreshing: true, value: 'landed' })
  expect({ pending: isPending(source), refreshing: isRefreshing(source), value: peek(source) }).toEqual({
    pending: false,
    refreshing: false,
    value: 'carried',
  })
})

/**
 * @canon exception-a-refresh-after-an-await-escapes-the-speculation
 */
test('in an async action body, a refresh after the first await lands in committed state, even when the action is discarded', async () => {
  const { source, settle } = controlledSource()
  peek(source)
  settle(1, 'before')
  await ticks(2)

  const run = action(async () => {
    await tick()
    refresh(source)
    await ticks(5)
    throw new Error('the action fails')
  })
  await ticks(3) // the refresh after the await has started its run
  settle(2, 'escaped')
  await run.settled
  await ticks(2)
  expect(peek(source)).toBe('escaped')
})
