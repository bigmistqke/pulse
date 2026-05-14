import { expect, test } from 'vitest'
import {
  flush,
  microtaskScheduler,
  setScheduler,
  syncScheduler,
  type FlushFn,
} from '../src/scheduler'
import { signal, setSignal } from '../src/signal'

test('syncScheduler flushes immediately on request', () => {
  let flushes = 0
  const flushFn: FlushFn = () => { flushes++ }
  const sched = syncScheduler(flushFn)
  sched.request()
  expect(flushes).toBe(1)
  sched.request()
  expect(flushes).toBe(2)
})

test('microtaskScheduler batches requests into a single flush', async () => {
  let flushes = 0
  const flushFn: FlushFn = () => { flushes++ }
  const sched = microtaskScheduler(flushFn)
  sched.request()
  sched.request()
  sched.request()
  expect(flushes).toBe(0) // batched — not flushed synchronously
  await Promise.resolve() // let the microtask run
  expect(flushes).toBe(1) // exactly one flush for the batch
})

test('setSignal requests a flush from the active scheduler', () => {
  let requests = 0
  setScheduler({ request: () => { requests++ } })
  const s = signal(0)
  setSignal(s, 1)
  expect(requests).toBe(1)
  // restore the default so other test files are unaffected
  setScheduler(microtaskScheduler(flush))
})
