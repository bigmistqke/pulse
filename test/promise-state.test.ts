import { expect, test } from 'vitest'
import { peek } from '../src/async'
import { signal } from '../src/signal'

test('peek of a plain (non-promise) signal returns the value itself', () => {
  const [n] = signal(5)
  // A bare value is returned as-is — it is NOT treated as pending, and its
  // `.value` is NOT read (would be undefined for a number).
  expect(peek(n)).toBe(5)
})
