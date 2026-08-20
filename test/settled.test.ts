import { expect, test } from 'vitest'
import { computed, effect, isPending, settled, signal, use } from '../src/index'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('settled waits for ALL inputs, then produces the combined frame atomically', async () => {
  let ra!: (v: number) => void
  let rb!: (v: number) => void
  const A = computed(() => new Promise<number>((r) => (ra = r)))
  const B = computed(() => new Promise<number>((r) => (rb = r)))
  const preview = computed(function* () {
    const [a, b] = yield* settled([A, B])
    return a + b
  })
  preview() // kick first eval
  await tick()
  expect(isPending(preview)).toBe(true) // both inputs pending

  ra(10)
  await tick()
  // Only A has settled — the barrier must still hold (no half-updated frame).
  expect(isPending(preview)).toBe(true)

  rb(20)
  await tick()
  expect(isPending(preview)).toBe(false)
  expect(use(preview)).toBe(30) // both settled → the combined frame appears at once
})

test('a consumer never observes a partial frame', async () => {
  const observed: string[] = []
  let ra!: (v: number) => void
  let rb!: (v: number) => void
  const A = computed(() => new Promise<number>((r) => (ra = r)))
  const B = computed(() => new Promise<number>((r) => (rb = r)))
  const preview = computed(function* () {
    const [a, b] = yield* settled([A, B])
    return `${a}+${b}`
  })
  effect(() => {
    try {
      observed.push(use(preview))
    } catch {
      /* still pending — no frame */
    }
  })
  await tick()
  ra(10)
  await tick()
  // A has settled, B has not: the consumer must see NO frame at all.
  expect(observed).toEqual([])
  rb(20)
  await tick()
  // Exactly one frame, and it is fully coherent — never a half-updated one.
  expect(observed).toEqual(['10+20'])
})

test('an already-settled raw promise input converges (no re-suspend loop)', async () => {
  // Regression: settled used to re-add an already-settled promise to the wait set
  // on every re-run, yielding a fresh (always-pending) Promise.all — suspending,
  // kicking, re-running forever and starving the event loop.
  const A = computed(async () => 7)
  await tick()
  const p = Promise.resolve(42)
  const c = computed(function* () {
    const [a, b] = yield* settled([A, p])
    return `${a}|${b}`
  })
  await tick()
  expect(use(c)).toBe('7|42')
})

test('settled throws a rejected input instead of silently yielding undefined', async () => {
  const [s] = signal(Promise.reject(new Error('nope')) as Promise<number>)
  await tick() // let the rejection settle
  const c = computed(function* () {
    const [v] = yield* settled([s])
    return v
  })
  expect(() => c()).toThrow('nope')
})

test('settled resolves immediately when every input is already settled', async () => {
  const A = computed(async () => 2)
  const B = computed(async () => 3)
  await tick() // let both settle first
  const combined = computed(function* () {
    const [a, b] = yield* settled([A, B])
    return a * b
  })
  await tick()
  expect(use(combined)).toBe(6)
})

test('settled re-runs and re-coordinates when an input refetches', async () => {
  let ra!: (v: number) => void
  let rb!: (v: number) => void
  const [seed, setSeed] = (await import('../src/index')).signal(0)
  const A = computed(() => {
    seed() // dep: bumping seed refetches A
    return new Promise<number>((r) => (ra = r))
  })
  const B = computed(() => new Promise<number>((r) => (rb = r)))
  const preview = computed(function* () {
    const [a, b] = yield* settled([A, B])
    return `${a}:${b}`
  })
  preview()
  await tick()
  ra(1)
  rb(2)
  await tick()
  expect(use(preview)).toBe('1:2')

  // Refetch A; the barrier must wait for the new A before swapping the frame.
  setSeed(1)
  await tick()
  expect(isPending(preview)).toBe(true) // A refetching — barrier holds
  ra(9)
  await tick()
  expect(use(preview)).toBe('9:2')
})
