/**
 * One test per decision: a rule that holds other rules. Each test pins the
 * decision's own statement as a whole, through a scenario its nested rules do
 * not cover on their own.
 */
import { afterEach, expect, test } from 'vitest'
import {
  action,
  catchError,
  committed,
  computed,
  createRoot,
  effect,
  error,
  flush,
  from,
  getOwner,
  isPending,
  microtaskScheduler,
  onCleanup,
  optimistic,
  peek,
  runWithOwner,
  setScheduler,
  signal,
  syncScheduler,
  type Owner,
} from '../src/index'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

afterEach(() => setScheduler(microtaskScheduler(flush)))

/**
 * @canon rule-ambient-context-is-set-for-a-call-and-restored-after
 */
test('the ambient owner and the ambient speculation are both restored after a call that throws', async () => {
  const [n, setN] = signal(0)
  let outer: Owner | null = null
  let ownerAfterAction: Owner | null = null
  createRoot(() => {
    outer = getOwner()
    action(() => {
      setN(1)
      throw new Error('the action fails')
    })
    ownerAfterAction = getOwner()
  })
  expect(ownerAfterAction).toBe(outer)
  expect(getOwner()).toBe(null)
  setN(2) // no speculation is ambient any more, so this write commits at once
  expect(committed(n)).toBe(2)
})

/**
 * @canon rule-reads-pull-and-consumers-are-pushed
 */
test('a read is current at once while an effect waits for the batch and runs once for it', async () => {
  const [a, setA] = signal(1)
  const doubled = computed(() => a() * 2)
  const seenByEffect: number[] = []
  createRoot(() => effect(() => void seenByEffect.push(doubled())))
  expect(seenByEffect).toEqual([2])
  setA(2)
  setA(3)
  expect(seenByEffect).toEqual([2]) // the effect waits for the batch
  expect(doubled()).toBe(6) // the read does not
  await tick()
  expect(seenByEffect).toEqual([2, 6]) // and the effect ran once for both writes
})

/**
 * @canon rule-a-paused-computation-is-re-entered-at-its-pause
 */
test('a settle resumes a generator at its pause without re-running the stage before it, and a new input starts over', async () => {
  const [source, setSource] = signal(1)
  let stageRuns = 0
  let beforePause = 0
  let afterPause = 0
  const c = computed(
    () => {
      stageRuns++
      return source()
    },
    function* (input: number) {
      beforePause++
      const extra: number = yield* from(new Promise<number>((resolve) => setTimeout(() => resolve(10), 1)))
      afterPause++
      return input + extra
    },
  )
  createRoot(() => effect(() => void c()))
  for (let i = 0; i < 5; i++) await tick()
  expect(peek(c)).toBe(11)
  expect([stageRuns, beforePause, afterPause]).toEqual([1, 1, 1])
  setSource(2)
  for (let i = 0; i < 5; i++) await tick()
  expect(peek(c)).toBe(12)
  expect([stageRuns, beforePause, afterPause]).toEqual([2, 2, 2])
})

/**
 * @canon rule-the-value-of-an-async-node-is-taken-out-at-the-read-site
 */
test('pulse never unwraps an async value for its reader, before or after it settles', async () => {
  const c = computed(() => Promise.resolve(5))
  const seen: unknown[] = []
  createRoot(() => effect(() => void seen.push(c())))
  for (let i = 0; i < 3; i++) await tick()
  expect(seen.length).toBeGreaterThan(0)
  for (const value of seen) expect(value).toBeInstanceOf(Promise)
  expect(c()).toBeInstanceOf(Promise)
  expect(peek(c)).toBe(5) // a verb at the read site is what takes it out
})

/**
 * @canon rule-a-lifetime-belongs-to-an-owner
 */
test('disposing an owner ends its computeds and effects and leaves its signals working', () => {
  setScheduler(syncScheduler(flush))
  const [a, setA] = signal(1)
  let computedRuns = 0
  let effectRuns = 0
  let mine!: ReturnType<typeof signal<number>>
  createRoot((dispose) => {
    mine = signal(10)
    const c = computed(() => {
      computedRuns++
      return a()
    })
    effect(() => {
      effectRuns++
      c()
    })
    dispose()
  })
  const [counter, setCounter] = mine
  setA(2)
  expect([computedRuns, effectRuns]).toEqual([1, 1])
  setCounter(11)
  expect(counter()).toBe(11)
})

/**
 * @canon rule-teardown-unwinds
 */
test('closing runs callbacks newest first, and one that throws stops neither the rest nor the close', () => {
  const order: string[] = []
  let disposeRoot!: () => void
  createRoot((dispose) => {
    disposeRoot = dispose
    onCleanup(() => order.push('first'))
    onCleanup(() => {
      order.push('second')
      throw new Error('a cleanup fails')
    })
    onCleanup(() => order.push('third'))
  })
  expect(() => disposeRoot()).not.toThrow()
  expect(order).toEqual(['third', 'second', 'first'])
})

/**
 * @canon rule-error-boundaries-are-sub-owners
 */
test('an error goes to the boundary above the owner it happened under, not the one whose call is running', () => {
  setScheduler(syncScheduler(flush))
  const heardByA: unknown[] = []
  const heardByB: unknown[] = []
  let ownerInsideA: Owner | null = null
  createRoot(() => {
    catchError(
      () => {
        ownerInsideA = getOwner()
      },
      (e) => heardByA.push(e),
    )
    catchError(
      () => {
        runWithOwner(ownerInsideA, () =>
          effect(() => {
            throw new Error('under A')
          }),
        )
      },
      (e) => heardByB.push(e),
    )
  })
  expect(ownerInsideA).not.toBe(null)
  expect(heardByA.map((e) => (e as Error).message)).toEqual(['under A'])
  expect(heardByB).toEqual([])
})

/**
 * @canon rule-an-error-is-graph-state-not-an-event
 */
test('a failure is held on the node and seen downstream, and a recovery clears it', () => {
  setScheduler(syncScheduler(flush))
  const [fail, setFail] = signal(true)
  const source = computed(() => {
    if (fail()) throw new Error('broken')
    return 1
  })
  const downstream = computed(() => source() + 1)
  createRoot(() => catchError(() => effect(() => void downstream()), () => {}))
  // Asked twice, the same failure answers twice: it is held, not consumed.
  expect((error(source) as Error).message).toBe('broken')
  expect((error(source) as Error).message).toBe('broken')
  expect((error(downstream) as Error).message).toBe('broken')
  setFail(false)
  expect(error(source)).toBe(null)
  expect(error(downstream)).toBe(null)
  expect(downstream()).toBe(2)
})

/**
 * @canon rule-an-optimistic-value-is-a-signal-variant
 */
test('an optimistic value is an ordinary node whose setter only writes a prediction in front of it', async () => {
  const [source, setSource] = signal(1)
  const [view, setView] = optimistic(() => source() * 10)
  expect(view()).toBe(10)
  expect(isPending(view)).toBe(false)
  const gate = Promise.withResolvers<void>()
  let duringPrediction: unknown
  const handle = action(function* () {
    setView(99)
    yield* from(gate.promise)
  })
  duringPrediction = view()
  setSource(2) // the derivation underneath keeps following its source
  const underneath = peek(view)
  gate.resolve()
  await handle.settled
  await tick()
  expect(duringPrediction).toBe(99)
  expect(underneath).toBe(99)
  expect(view()).toBe(20) // the prediction is gone, the derivation shows through
})
