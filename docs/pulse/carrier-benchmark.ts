// Compares three ways to carry async state with a promise, for the pulse read
// model: (1) chained-promise + fields (the old Awaitable subclass), (2) symbol-tag
// on the existing promise, (3) a WeakMap keyed on the promise. Measures sync
// creation cost, read cost (the hot path), and heap footprint. Run with:
//   node --expose-gc docs/pulse/carrier-benchmark.ts
declare const process: { memoryUsage(): { heapUsed: number } }
declare const global: { gc(): void }

const N = 200_000 // carriers created per trial (≈ async resolutions)
const READS = 20 // reads per carrier per trial (consumers re-read a lot)
const TRIALS = 6
const SYM = Symbol('pulse.state')

type State = { status: string; value: number; reason: unknown }

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const mb = (b: number): string => (b / 1048576).toFixed(1)

// Read indirection identical for all three (simulates a verb like isPending/latest).
function accumulate(readState: (c: unknown) => State, carriers: unknown[]): number {
  let acc = 0
  for (let r = 0; r < READS; r++)
    for (let i = 0; i < N; i++) {
      const s = readState(carriers[i])
      acc += s.status === 'fulfilled' ? s.value : 0
    }
  return acc
}

// (1) chained-promise + fields — models the old resolvedAwaitable/toAwaitable.
function subclass(): unknown[] {
  const carriers: unknown[] = new Array(N)
  for (let i = 0; i < N; i++) {
    const src = Promise.resolve(i)
    const a = src.then((v) => v) as Promise<number> & State
    a.catch(() => {})
    a.status = 'fulfilled'
    a.value = i
    a.reason = undefined
    Object.defineProperty(a, SYM, { value: true, enumerable: false })
    carriers[i] = a
  }
  return carriers
}
const readSubclass = (a: unknown): State => a as State

// (2) symbol-tag a state bag onto the existing promise.
function symbolTag(): unknown[] {
  const carriers: unknown[] = new Array(N)
  for (let i = 0; i < N; i++) {
    const p = Promise.resolve(i)
    Object.defineProperty(p, SYM, {
      value: { status: 'fulfilled', value: i, reason: undefined },
      enumerable: false,
      configurable: true,
      writable: true,
    })
    carriers[i] = p
  }
  return carriers
}
const readSymbol = (p: unknown): State => (p as Record<symbol, State>)[SYM]

// (3) WeakMap keyed on the promise.
const states = new WeakMap<object, State>()
function weakmap(): unknown[] {
  const carriers: unknown[] = new Array(N)
  for (let i = 0; i < N; i++) {
    const p = Promise.resolve(i)
    states.set(p, { status: 'fulfilled', value: i, reason: undefined })
    carriers[i] = p
  }
  return carriers
}
const readWeak = (p: unknown): State => states.get(p as object)!

async function bench(
  name: string,
  create: () => unknown[],
  readState: (c: unknown) => State,
): Promise<void> {
  // warmup (let the JIT specialize)
  for (let w = 0; w < 3; w++) {
    accumulate(readState, create())
    await drain()
  }
  const createMs: number[] = []
  const readMs: number[] = []
  let heap = 0
  for (let t = 0; t < TRIALS; t++) {
    global.gc()
    const h0 = process.memoryUsage().heapUsed
    let s = performance.now()
    const carriers = create()
    createMs.push(performance.now() - s)
    heap = Math.max(heap, process.memoryUsage().heapUsed - h0)
    s = performance.now()
    const acc = accumulate(readState, carriers)
    readMs.push(performance.now() - s)
    if (acc === -1) console.log('unreachable') // block dead-code elimination
    await drain() // let the subclass's chained microtasks run outside the timed region
  }
  const med = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  console.log(
    `${name.padEnd(11)} create ${med(createMs).toFixed(1).padStart(6)}ms   ` +
      `read ${med(readMs).toFixed(1).padStart(6)}ms   heap +${mb(heap)}MB`,
  )
}

async function main(): Promise<void> {
  console.log(`N=${N} carriers, ${READS} reads each, median of ${TRIALS} trials\n`)
  await bench('subclass', subclass, readSubclass)
  await bench('symbol-tag', symbolTag, readSymbol)
  await bench('weakmap', weakmap, readWeak)
}

main()
