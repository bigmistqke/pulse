import { expect, test } from 'vitest'
import { signal } from '../src/derived-signal'
import { read, use } from '../src/async'
import { isPending } from '../src/pending'
import { onCleanup } from '../src/owner'

test('W2: a write replaces the value and the body does not re-run', () => {
  let runs = 0
  const [count, setCount] = signal(() => {
    runs++
    return 1
  })
  expect(count()).toBe(1)
  expect(runs).toBe(1)

  setCount(7)
  expect(count()).toBe(7)
  expect(runs).toBe(1) // the derivation did not run again
})

test('W2: an update function receives the last resolved value', () => {
  const [list, setList] = signal(() => ['a'])
  expect(list()).toEqual(['a'])
  setList((prev) => [...(prev ?? []), 'b'])
  expect(list()).toEqual(['a', 'b'])
})

test('W3: an update function receives the value an eagerly-run derivation produced', () => {
  let seen: unknown = 'not called'
  const [list, setList] = signal(() => ['a'])
  setList((prev) => {
    seen = prev
    return ['seeded']
  })
  expect(seen).toEqual(['a']) // it ran at creation, so it has a value
  expect(list()).toEqual(['seeded'])
})

test('W3: an update function receives undefined while nothing has resolved yet', () => {
  let seen: unknown = 'not called'
  const [list, setList] = signal(function* () {
    return yield* read(new Promise<string[]>(() => {}))
  })
  setList((prev) => {
    seen = prev
    return ['seeded']
  })
  expect(seen).toBeUndefined() // it ran at creation but suspended, so nothing resolved
})

test('W21: two writes in one tick chain, and the last one wins', () => {
  const [list, setList] = signal(() => ['a'])
  expect(list()).toEqual(['a'])
  setList((prev) => [...(prev ?? []), 'b'])
  setList((prev) => [...(prev ?? []), 'c'])
  expect(list()).toEqual(['a', 'b', 'c'])
})

test('the value form still works and is unchanged', () => {
  const [count, setCount] = signal(0)
  setCount(3)
  expect(count()).toBe(3)
  setCount((n) => n + 1)
  expect(count()).toBe(4)
})

test('a write into a multi-stage pipeline lands on the output', () => {
  const [n, setN] = signal(
    () => 2,
    (v: number) => v * 10,
  )
  expect(n()).toBe(20)
  setN(99)
  expect(n()).toBe(99)
})

test('a bare write into an asynchronously coloured stage keeps the read a promise', async () => {
  const [list, setList] = signal(function* () {
    return ['a']
  })

  // a generator stage publishes a promise, so the raw read is one
  expect(list()).toBeInstanceOf(Promise)
  expect(use(list)).toEqual(['a'])

  setList(['b'])

  // the write must not flip the shape a consumer sees
  expect(list()).toBeInstanceOf(Promise)
  expect(use(list)).toEqual(['b'])
})

test('a write into a synchronously coloured stage does not introduce a promise', () => {
  const [n, setN] = signal(() => 1)
  expect(n()).toBe(1)
  setN(2)
  expect(n()).toBe(2) // still bare, not a promise
})

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('W1: a write abandons the fetch in flight and it never publishes', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(new Promise<string[]>((r) => (resolveList = r)))
  })

  // start the first load and let it settle
  expect(isPending(todos)()).toBe(true)
  resolveList(['a'])
  await tick()
  expect(use(todos)).toEqual(['a'])

  // a refresh starts a second fetch
  setVersion(2)
  await tick()
  expect(isPending(todos)()).toBe(true)

  // the write abandons it
  setTodos(['a', 'saved'])
  expect(isPending(todos)()).toBe(false)
  expect(use(todos)).toEqual(['a', 'saved'])

  resolveList(['a', 'b'])
  await tick()
  expect(use(todos)).toEqual(['a', 'saved']) // the abandoned fetch published nothing
})

test('W13: abandoning a paused stage runs its cleanups', async () => {
  const aborted: string[] = []
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    const v = version()
    onCleanup(() => aborted.push(`run ${v}`))
    return yield* read(new Promise<string[]>(() => {}))
  })

  expect(isPending(todos)()).toBe(true)
  setTodos(['written'])
  expect(aborted).toEqual(['run 1'])
})

test('W9: a write abandons a fetch that is in a middle stage', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
    (server: string[]) => server.filter((t) => t !== 'done'),
  )

  expect(isPending(todos)()).toBe(true)
  setTodos(['written'])
  expect(isPending(todos)()).toBe(false)

  resolveList(['from', 'server'])
  await tick()
  expect(use(todos)).toEqual(['written']) // the middle stage published nothing
})
