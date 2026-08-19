import { expect, test } from 'vitest'
import { computed, error, isPending, latest, signal, use } from '../src/index'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * TARGET — error as node state (not implemented yet; these are red).
 *
 * An error is graph state, exactly like pending: it is parked out of band, it
 * propagates along the upstream chain, and it does NOT destroy the value the node
 * last resolved to. Each read verb takes its own stance on it:
 *
 *   use(c)    -> throws the reason   (fatal read; feeds an error boundary)
 *   latest(c) -> the stale value     (tolerant read; never throws)
 *   error(c)  -> the error, or null  (query)
 */

test('a failed refetch keeps the stale value readable through latest', async () => {
  const [id, setId] = signal(1)
  const c = computed(() =>
    id() === 1 ? Promise.resolve('v1') : Promise.reject(new Error('boom')),
  )
  try {
    c()
  } catch {
    /* prime */
  }
  await tick()
  expect(latest(c)).toBe('v1')

  // Refetch fails. The stale value must survive — that is the whole point of a
  // tolerant read. (Today the computed publishes the error reason OVER the value,
  // and latest throws instead of degrading.)
  setId(2)
  await tick()
  expect(latest(c)).toBe('v1') // degrade, do not throw
  expect(isPending(c)()).toBe(false)
})

test('error() reports the error, and null while healthy', async () => {
  const [id, setId] = signal(1)
  const c = computed(() =>
    id() === 1 ? Promise.resolve('v1') : Promise.reject(new Error('boom')),
  )
  try {
    c()
  } catch {
    /* prime */
  }
  await tick()
  expect(error(c)).toBe(null) // healthy

  setId(2)
  await tick()
  expect((error(c) as Error).message).toBe('boom')
})

test('use() still throws on error — the fatal read is unchanged', async () => {
  const c = computed(() => Promise.reject(new Error('boom')))
  try {
    c()
  } catch {
    /* prime */
  }
  await tick()
  expect(() => use(c)).toThrow('boom')
})

test('latest returns undefined (not a throw) when a node fails with no prior value', async () => {
  const c = computed(() => Promise.reject(new Error('boom')))
  try {
    c()
  } catch {
    /* prime */
  }
  await tick()
  expect(latest(c)).toBeUndefined() // nothing to degrade to — but still no throw
  expect((error(c) as Error).message).toBe('boom')
})

test('a recovery clears the error', async () => {
  const [id, setId] = signal(1)
  const c = computed(() =>
    id() === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
  )
  try {
    c()
  } catch {
    /* prime */
  }
  await tick()
  expect((error(c) as Error).message).toBe('boom')

  setId(2)
  await tick()
  expect(error(c)).toBe(null)
  expect(latest(c)).toBe('ok')
})

test('error propagates downstream along the pipeline', async () => {
  const c = computed(
    () => Promise.reject(new Error('upstream boom')),
    (v: string) => `${v}!`,
  )
  try {
    c()
  } catch {
    /* prime */
  }
  await tick()
  // The downstream stage is failed because its upstream is — the same upstream
  // walk isPending already does.
  expect((error(c) as Error).message).toBe('upstream boom')
})
