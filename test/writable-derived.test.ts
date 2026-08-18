import { expect, test } from 'vitest'
import { signal } from '../src/derived-signal'
import { use } from '../src/async'

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

test('W3: an update function receives undefined before the derivation has run', () => {
  let seen: unknown = 'not called'
  const [list, setList] = signal(() => ['a'])
  setList((prev) => {
    seen = prev
    return ['seeded']
  })
  expect(seen).toBeUndefined()
  expect(list()).toEqual(['seeded'])
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
  expect(use(list)).toEqual(['a'])
  setList(['b'])
  expect(use(list)).toEqual(['b'])
})
