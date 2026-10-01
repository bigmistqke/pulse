import { expect, test } from 'vitest'
import { resolvedPromise } from '../src/async'
import { runStage } from '../src/driver'
import { computed, error, peek } from '../src/index'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * @canon spec-the-driver-reads-settledness-from-the-promise-map
 */
test('the driver uses a promise the map records as fulfilled at once, on the first run that sees it', () => {
  // A fresh promise is unknown to the map, so its first run suspends even
  // though it has already settled.
  expect(runStage(() => Promise.resolve(5), 0).pending).toBe(true)
  // resolvedPromise records its promise as fulfilled when it is made, and the
  // driver reads that record rather than waiting a microtask.
  expect(runStage(() => resolvedPromise(5), 0)).toEqual({ pending: false, value: 5 })
})

/**
 * @canon spec-a-returned-promise-rejection-skips-the-generators-catch
 */
test("a rejection of a generator stage's returned promise skips its try/catch and parks as the stage error", async () => {
  let caught = false
  const c = computed(function* () {
    try {
      return Promise.reject(new Error('late'))
    } catch {
      caught = true
      return 'caught'
    }
  })
  c()
  await tick()
  await tick()
  expect(caught).toBe(false)
  expect((error(c) as Error).message).toBe('late')
  expect(peek(c)).toBeUndefined()
})
