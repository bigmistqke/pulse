import { afterEach, expect, test } from 'vitest'
import { catchError, createRoot, getOwner, onCleanup, runWithOwner, findLoadingScope, type LoadingScope } from '../src/owner'
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

test('runWithOwner restores owner even when fn throws', () => {
  createRoot(() => {
    const owner = getOwner()
    expect(() => runWithOwner(null, () => { throw new Error('boom') })).toThrow('boom')
    expect(getOwner()).toBe(owner) // restored despite throw
  })
})

test('dispose is idempotent — calling twice does not throw or re-run cleanups', () => {
  const log: string[] = []
  createRoot((dispose) => {
    onCleanup(() => log.push('cleaned'))
    dispose()
    dispose() // second call must not re-run cleanups
  })
  expect(log).toEqual(['cleaned'])
})

test('catchError invokes the handler on a synchronous throw inside fn', () => {
  const errors: unknown[] = []
  const result = catchError(
    () => { throw new Error('boom') },
    (e) => errors.push(e),
  )
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).message).toBe('boom')
  expect(result).toBeUndefined() // fn threw, no return value
})

test('catchError returns fn return value when fn does not throw', () => {
  const result = catchError(() => 42, () => {})
  expect(result).toBe(42)
})

test('nested catchError: inner handler catches its own subtree', () => {
  const inner: unknown[] = []
  const outer: unknown[] = []
  catchError(() => {
    catchError(
      () => { throw new Error('inner') },
      (e) => inner.push(e),
    )
  }, (e) => outer.push(e))
  expect(inner).toHaveLength(1)
  expect(outer).toHaveLength(0) // outer NOT involved
})

test('handler that throws escalates to the next outer boundary', () => {
  const outer: unknown[] = []
  catchError(() => {
    catchError(
      () => { throw new Error('inner') },
      () => { throw new Error('re-thrown by inner handler') },
    )
  }, (e) => outer.push(e))
  expect(outer).toHaveLength(1)
  expect((outer[0] as Error).message).toBe('re-thrown by inner handler')
})

test('unhandled throw (no boundary) propagates', () => {
  expect(() => {
    catchError(
      () => { throw new Error('inner') },
      () => { throw new Error('escalated') },
    )
  }).toThrow('escalated')
})

test('catchError sub-owner is disposed when its parent root is disposed', () => {
  const log: string[] = []
  createRoot((dispose) => {
    catchError(() => {
      onCleanup(() => log.push('inner cleanup'))
    }, () => {})
    onCleanup(() => log.push('outer cleanup'))
    dispose()
  })
  // Bottom-up: inner sub-owner disposed first, then outer's own cleanups.
  expect(log).toEqual(['inner cleanup', 'outer cleanup'])
})

test('catchError throws when called inside a disposed owner', () => {
  createRoot((dispose) => {
    dispose()
    expect(() => catchError(() => {}, () => {})).toThrow(/disposed/)
  })
})

test('Owner.loadingScope defaults to null', () => {
  createRoot(() => {
    const owner = getOwner()!
    expect(owner.loadingScope).toBe(null)
  })
})

test('findLoadingScope walks parent chain to find first non-null entry', () => {
  let captured: LoadingScope | null = null
  const scope: LoadingScope = {
    pending: () => true,
    register: () => () => {},
  }
  createRoot(() => {
    const outer = getOwner()!
    outer.loadingScope = scope
    catchError(() => {
      // inner owner is a child of outer via createSubOwner inside catchError
      captured = findLoadingScope(getOwner())
    }, () => {})
  })
  expect(captured).toBe(scope)
})

test('findLoadingScope returns null when no scope on chain', () => {
  let captured: LoadingScope | null = { pending: () => false, register: () => () => {} }
  createRoot(() => {
    captured = findLoadingScope(getOwner())
  })
  expect(captured).toBe(null)
})
