import { afterEach, expect, test } from 'vitest'
import { createRoot, getOwner, onCleanup, runWithOwner } from '../src/owner'
import { flush, microtaskScheduler, setScheduler } from '../src/scheduler'

afterEach(() => setScheduler(microtaskScheduler(flush)))

test('createRoot returns the callback return value', () => {
  const result = createRoot(() => 'hello')
  expect(result).toBe('hello')
})

test('getOwner is null outside any root', () => {
  expect(getOwner()).toBeNull()
})

test('getOwner returns the current owner inside createRoot', () => {
  createRoot(() => {
    expect(getOwner()).not.toBeNull()
  })
})

test('createRoot disposes its onCleanup callbacks', () => {
  const log: string[] = []
  createRoot((dispose) => {
    onCleanup(() => log.push('a'))
    onCleanup(() => log.push('b'))
    dispose()
  })
  // Bottom-up: cleanups run in LIFO order ('b' before 'a').
  expect(log).toEqual(['b', 'a'])
})

test('createRoot is always a root — nested createRoot is independent', () => {
  let innerDispose!: () => void
  let innerCleanupRan = false
  createRoot((outerDispose) => {
    createRoot((d) => {
      innerDispose = d
      onCleanup(() => { innerCleanupRan = true })
    })
    outerDispose() // outer dispose should NOT cascade to inner
  })
  expect(innerCleanupRan).toBe(false) // inner is independent
  innerDispose() // dispose inner explicitly
  expect(innerCleanupRan).toBe(true)
})

test('runWithOwner sets the ambient owner for fn execution and restores after', () => {
  let captured: ReturnType<typeof getOwner> = null
  createRoot(() => {
    const owner = getOwner()
    runWithOwner(null, () => {
      expect(getOwner()).toBeNull()
    })
    expect(getOwner()).toBe(owner) // restored
    runWithOwner(owner, () => {
      captured = getOwner()
    })
  })
  expect(captured).not.toBeNull()
})

test('runWithOwner on a disposed owner throws', () => {
  let disposedOwner!: ReturnType<typeof getOwner>
  createRoot((dispose) => {
    disposedOwner = getOwner()
    dispose()
  })
  expect(() => runWithOwner(disposedOwner, () => {})).toThrow(/disposed/)
})

test('onCleanup outside any context is a no-op (permissive)', () => {
  // Should not throw, should not crash.
  expect(() => onCleanup(() => {})).not.toThrow()
})
