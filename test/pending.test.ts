// test/pending.test.ts
import { describe, expect, test } from 'vitest'
import { signal } from '../src/signal'
import { isPending, promiseOf } from '../src/pending'

describe('pending tracker — basics', () => {
  test('isPending returns a reactive accessor; false for plain signal', () => {
    const [s] = signal(42)
    const acc = isPending(s)
    expect(typeof acc).toBe('function')
    expect(acc()).toBe(false)
  })

  test('promiseOf returns a reactive accessor; null for plain signal', () => {
    const [s] = signal(42)
    const acc = promiseOf(s)
    expect(typeof acc).toBe('function')
    expect(acc()).toBe(null)
  })
})
