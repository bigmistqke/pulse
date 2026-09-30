import { expect, test } from 'vitest'
import { signal } from '../src/signal'
import { action } from '../src/scope'

/**
 * @canon rule-a-commit-promotes-every-write-at-once
 */
test('an action commits a public signal write', () => {
  const [count, setCount] = signal(0)
  action(() => setCount(5))
  expect(count()).toBe(5)
})

/**
 * @canon rule-a-discard-leaves-no-trace
 */
test('an action discards a public signal write on throw (rollback)', () => {
  const [count, setCount] = signal(0)
  action(() => {
    setCount(5)
    throw new Error('boom')
  })
  expect(count()).toBe(0) // rolled back — never committed
})

/**
 * @canon rule-a-speculation-reads-its-own-writes
 */
test('a public signal write inside an action is isolated from committed state until commit', () => {
  const [count, setCount] = signal(0)
  const seen: number[] = []
  action(() => {
    setCount(5)
    seen.push(count()) // inside the action: sees its own speculative write
  })
  expect(seen).toEqual([5])
  expect(count()).toBe(5) // committed after the action returns
})

/**
 * @canon rule-a-speculation-reads-its-own-writes
 */
test('the updater form reads the scope-appropriate previous value', () => {
  const [count, setCount] = signal(10)
  action(() => {
    setCount((prev) => prev + 1) // prev is the committed 10 → 11 speculative
    setCount((prev) => prev + 1) // prev is now the speculative 11 → 12
  })
  expect(count()).toBe(12)
})
