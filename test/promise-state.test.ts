import { expect, test } from 'vitest'
import { latest } from '../src/async'
import { signal } from '../src/signal'

test('latest of a plain (non-promise) signal returns the value itself', () => {
  const [n] = signal(5)
  // A bare value is returned as-is — it is NOT treated as pending, and its
  // `.value` is NOT read (would be undefined for a number).
  expect(latest(n)).toBe(5)
})
