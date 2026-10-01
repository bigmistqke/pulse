import { expect, test } from 'vitest'
import { signal } from '../src/signal'
import { computed } from '../src/computed'
import { isPending } from '../src/pending'
import { peek } from '../src/async'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * @canon spec-a-signal-reads-back-its-last-write
 */
test('signal holds an initial value', () => {
  const [count] = signal(0)
  expect(count()).toBe(0)
})

/**
 * @canon spec-a-signal-reads-back-its-last-write
 */
test('setter updates the value, accessor reflects it', () => {
  const [count, setCount] = signal(0)
  setCount(5)
  expect(count()).toBe(5)
})

/**
 * @canon spec-a-signal-reads-back-its-last-write
 */
test('signal works with non-number values', () => {
  const [name, setName] = signal('alice')
  expect(name()).toBe('alice')
  setName('bob')
  expect(name()).toBe('bob')
})

/**
 * @canon spec-an-update-function-on-a-signal-receives-its-current-value
 */
test('setter supports updater function', () => {
  const [count, setCount] = signal(0)
  setCount((prev) => prev + 1)
  expect(count()).toBe(1)
  setCount((prev) => prev * 3)
  expect(count()).toBe(3)
})

/**
 * @canon spec-a-computed-has-no-setter
 */
test('computed accessor is not writable (type-level)', () => {
  const c = computed(() => 1)
  // @ts-expect-error - computed accessor has no setter
  c.nonexistent
})

/**
 * @canon spec-a-signals-type-is-the-type-it-stores
 */
test('a signal holding a promise is typed as the promise, not the awaited value (compile-time)', () => {
  // Exact type equality, so a read widened to `Awaited<T> | T` fails to
  // compile, not just one that is unassignable.
  type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
  const [s] = signal(Promise.resolve(42))
  const read: Equal<ReturnType<typeof s>, Promise<number>> = true
  void read
  const [union] = signal<number | Promise<number>>(0)
  const unionRead: Equal<ReturnType<typeof union>, number | Promise<number>> = true
  void unionRead
})

/**
 * @canon spec-a-signal-stores-a-promise-as-it-is
 */
test('a signal stores a Promise value as-is (no auto-resolve)', async () => {
  // Write-back was removed: signal stores exactly what you put in it. For
  // async derivations use computed; for one-shot reads use `use(s())`.
  const [s] = signal(Promise.resolve(42))
  expect(isPending(s)).toBe(true)
  await tick()
  expect(s()).toBeInstanceOf(Promise)
  expect(await s()).toBe(42)
})

/**
 * @canon spec-a-signal-stores-a-promise-as-it-is
 */
test('a signal written a promise reads back as the plain promise it was given', async () => {
  const [s, setS] = signal<number | Promise<number>>(0)
  const p = Promise.resolve(42)
  setS(p)
  expect(s()).toBe(p) // the plain promise, not a wrapper
  expect(isPending(s)).toBe(true)
  await tick()
  expect(isPending(s)).toBe(false)
  expect(peek(s)).toBe(42)
})

/**
 * @canon spec-an-async-node-keeps-its-last-value-while-it-refreshes
 */
test('SWR: while a refetch is pending the prior resolved value stays available via peek', async () => {
  const [s, setS] = signal<number | Promise<number>>(0)
  setS(Promise.resolve(1))
  await tick()
  setS(new Promise(() => {})) // never settles
  expect(isPending(s)).toBe(true)
  expect(peek(s)).toBe(1) // prior held (seeded from the current node value)
})

/**
 * @canon spec-an-equal-value-does-not-propagate
 */
test('a SameValueZero-equal value re-runs no consumer, wherever it enters the graph', async () => {
  const { createRoot } = await import('../src/owner')
  const { effect } = await import('../src/effect')
  const { use } = await import('../src/async')

  // Each entry point holds `first`, then takes in `next`. `consumer` counts the
  // runs of whatever reads the value directly from that entry point.
  type Entry = (first: number, next: number, consumer: (v: number) => number) => () => void
  const entries: Record<string, Entry> = {
    'a signal write': (first, next, consumer) => {
      const [s, setS] = signal(first)
      const c = computed(() => consumer(s()))
      effect(() => { c() })
      return () => setS(next)
    },
    'a sync stage result': (first, next, consumer) => {
      const [on, setOn] = signal(false)
      const c = computed(() => (on() ? next : first), consumer)
      effect(() => { c() })
      return () => setOn(true)
    },
    'an async stage settle': (first, next, consumer) => {
      const [on, setOn] = signal(false)
      const c = computed(() => on(), (v: boolean) => Promise.resolve(v ? next : first), consumer)
      effect(() => { c() })
      return () => setOn(true)
    },
    'a promise a use settles': (first, next, consumer) => {
      const [p, setP] = signal(Promise.resolve(first))
      const c = computed(() => use(p()), consumer)
      effect(() => { c() })
      return () => setP(Promise.resolve(next))
    },
  }
  const pairs: Array<[number, number]> = [[Number.NaN, Number.NaN], [0, -0], [-0, 0], [1, 2]]

  const reruns: Record<string, number[]> = {}
  for (const [name, entry] of Object.entries(entries)) {
    reruns[name] = []
    for (const [first, next] of pairs) {
      let runs = 0
      let change!: () => void
      createRoot(() => {
        change = entry(first, next, (v) => { runs++; return v })
      })
      await tick()
      runs = 0
      change()
      await tick()
      reruns[name].push(runs)
    }
  }
  // NaN after NaN, 0 after -0 and -0 after 0 re-run nothing; 1 after 2 is a
  // real change, so each entry point is shown to propagate one.
  expect(reruns).toEqual({
    'a signal write': [0, 0, 0, 1],
    'a sync stage result': [0, 0, 0, 1],
    'an async stage settle': [0, 0, 0, 1],
    'a promise a use settles': [0, 0, 0, 1],
  })
})

// ---- an equal committed write re-runs nothing ----

async function runsAfterWrite<T>(initial: T, next: T): Promise<number> {
  const { createRoot } = await import('../src/owner')
  const { effect } = await import('../src/effect')
  const [value, setValue] = signal(initial)
  let runs = 0
  createRoot(() => {
    effect(() => {
      value()
      runs++
    })
  })
  await tick()
  runs = 0
  setValue(next)
  await tick()
  return runs
}

/**
 * @canon spec-an-equal-committed-signal-write-is-dropped
 */
test('writing the same number again re-runs nothing', async () => {
  expect(await runsAfterWrite(1, 1)).toBe(0)
})

/**
 * @canon spec-an-equal-committed-signal-write-is-dropped
 */
test('writing NaN over NaN re-runs nothing', async () => {
  expect(await runsAfterWrite(Number.NaN, Number.NaN)).toBe(0)
})

/**
 * @canon spec-an-equal-committed-signal-write-is-dropped
 */
test('writing 0 over -0 re-runs nothing', async () => {
  expect(await runsAfterWrite(-0, 0)).toBe(0)
})

/**
 * @canon spec-an-equal-committed-signal-write-is-dropped
 */
test('writing the same object again re-runs nothing, and a different object re-runs once', async () => {
  const same = { a: 1 }
  expect(await runsAfterWrite(same, same)).toBe(0)
  expect(await runsAfterWrite({ a: 1 }, { a: 1 })).toBe(1)
})

/**
 * @canon spec-an-equal-speculative-write-dirties-nothing
 */
test('inside an action, writing the value the action already reads recomputes nothing', async () => {
  const { action } = await import('../src/index')
  const [n, setN] = signal(1)
  let runs = 0
  const doubled = computed(() => {
    runs++
    return n() * 2
  })
  const recomputes: Record<string, number> = {}
  const measure = (label: string, write: () => void) => {
    const before = runs
    write()
    doubled()
    recomputes[label] = runs - before
  }
  const handle = action(() => {
    doubled()
    measure('equal to the committed value', () => setN(1))
    measure('a real change', () => setN(3))
    measure('equal to the action\'s own write', () => setN(3))
    measure('NaN', () => setN(Number.NaN))
    measure('NaN over NaN', () => setN(Number.NaN))
  })
  await handle.settled
  expect(handle.error()).toBe(null)
  expect(recomputes).toEqual({
    'equal to the committed value': 0,
    'a real change': 1,
    "equal to the action's own write": 0,
    NaN: 1,
    'NaN over NaN': 0,
  })
})
