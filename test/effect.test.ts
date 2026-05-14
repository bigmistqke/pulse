import { afterEach, expect, test } from 'vitest'
import { effect, onCleanup } from '../src/effect'
import {
  flush,
  microtaskScheduler,
  setScheduler,
  syncScheduler,
} from '../src/scheduler'
import { signal, setSignal } from '../src/signal'

// These tests use the synchronous scheduler so writes flush immediately.
afterEach(() => setScheduler(microtaskScheduler(flush)))

test('effect runs once immediately on creation', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const count = signal(0)
  effect(() => { seen.push(count()) })
  expect(seen).toEqual([0])
})

test('effect re-runs when a dependency changes', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const count = signal(0)
  effect(() => { seen.push(count()) })
  setSignal(count, 1)
  setSignal(count, 2)
  expect(seen).toEqual([0, 1, 2])
})

test('onCleanup runs before an effect re-runs', () => {
  setScheduler(syncScheduler(flush))
  const log: string[] = []
  const count = signal(0)
  effect(() => {
    const c = count()
    log.push(`run ${c}`)
    onCleanup(() => log.push(`cleanup ${c}`))
  })
  expect(log).toEqual(['run 0'])
  setSignal(count, 1)
  expect(log).toEqual(['run 0', 'cleanup 0', 'run 1'])
})
