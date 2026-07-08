import { expect, test } from 'vitest'
import { Awaitable, toAwaitable } from '../src/awaitable'

const tick = () => new Promise<void>((r) => setTimeout(r))

test('an Awaitable is a Promise carrying status/value/reason', async () => {
  const a = toAwaitable(Promise.resolve(42))
  expect(a).toBeInstanceOf(Promise)
  expect(a.status).toBe('pending')
  expect(a.value).toBeUndefined()
  await tick()
  expect(a.status).toBe('fulfilled')
  expect(a.value).toBe(42)
  expect(await a).toBe(42)
})

test('a pending Awaitable is seeded with the prior value (SWR)', () => {
  const a = toAwaitable(new Promise(() => {}), /* prior */ 7)
  expect(a.status).toBe('pending')
  expect(a.value).toBe(7) // stale-while-revalidate: prior visible while pending
})

test('a rejected Awaitable records the reason', async () => {
  const a = toAwaitable(Promise.reject(new Error('x')))
  a.catch(() => {}) // avoid unhandled rejection
  await tick()
  expect(a.status).toBe('rejected')
  expect(a.reason).toBeInstanceOf(Error)
})

import { track } from '../src/async'

test("track returns an Awaitable's own live state", async () => {
  const a = toAwaitable(Promise.resolve(1))
  const state = track(a)
  expect(state.status).toBe('pending')
  await tick()
  // reading the Awaitable's fields reflects the settled state
  expect(track(a).status).toBe('fulfilled')
  expect(track(a).value).toBe(1)
})
