import { afterEach, expect, test, vi } from 'vitest'
import { computed as r3Computed, stabilize } from 'r3'
import {
  catchError,
  createFailedScope,
  createRoot,
  createSubOwner,
  findBoundaryScope,
  findNearestFailedScope,
  getOwner,
  onCleanup,
  runWithOwner,
  type FailedScope,
  type FailureReport,
  type LoadingScope,
} from '../src/owner'
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

test('catchError with a declining for lets the error propagate to an outer catchError', () => {
  const outerCaught: unknown[] = []
  const innerCaught: unknown[] = []
  createRoot(() => {
    catchError(
      () => {
        catchError(
          () => {
            throw new TypeError('boom')
          },
          (e) => innerCaught.push(e),
          { for: (e): e is RangeError => e instanceof RangeError },
        )
      },
      (e) => outerCaught.push(e),
    )
  })
  expect(innerCaught).toEqual([])
  expect(outerCaught).toHaveLength(1)
  expect((outerCaught[0] as Error).message).toBe('boom')
})

test('catchError with an accepting for claims the error itself, not an outer catchError', () => {
  const outerCaught: unknown[] = []
  const innerCaught: unknown[] = []
  createRoot(() => {
    catchError(
      () => {
        catchError(
          () => {
            throw new TypeError('boom')
          },
          (e) => innerCaught.push(e),
          { for: (e): e is TypeError => e instanceof TypeError },
        )
      },
      (e) => outerCaught.push(e),
    )
  })
  expect(innerCaught).toHaveLength(1)
  expect((innerCaught[0] as Error).message).toBe('boom')
  expect(outerCaught).toEqual([])
})

test('catchError with a declining for and no outer handler re-throws, same as no handler at all', () => {
  expect(() => {
    createRoot(() => {
      catchError(
        () => {
          throw new TypeError('boom')
        },
        () => {},
        { for: (e): e is RangeError => e instanceof RangeError },
      )
    })
  }).toThrow('boom')
})

test('catchError omitting for still accepts everything, exactly as before', () => {
  const caught: unknown[] = []
  createRoot(() => {
    catchError(
      () => {
        throw new Error('boom')
      },
      (e) => caught.push(e),
    )
  })
  expect(caught).toHaveLength(1)
})

test('findNearestFailedScope skips a FailedScope whose for declines the error, finding a farther one that accepts', () => {
  createRoot(() => {
    const outer = createSubOwner(getOwner())
    const outerScope: FailedScope = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      reports: () => [],
      register: () => ({ report: () => {}, unregister: () => {} }),
      reset: () => {},
      resetMatching: () => {},
    }
    outer.boundaries.failed = outerScope

    const found = runWithOwner(outer, () => {
      const inner = createSubOwner(getOwner())
      const innerScope: FailedScope = {
        kind: 'failed',
        active: () => false,
        error: () => null,
        reports: () => [],
        for: (e): e is RangeError => e instanceof RangeError,
        register: () => ({ report: () => {}, unregister: () => {} }),
        reset: () => {},
        resetMatching: () => {},
      }
      inner.boundaries.failed = innerScope
      return runWithOwner(inner, () => findNearestFailedScope(getOwner(), new TypeError('boom')))
    })

    expect(found?.scope).toBe(outerScope)
  })
})

test('findNearestFailedScope claims the error at the nearest FailedScope whose for accepts it', () => {
  createRoot(() => {
    let innerScope!: FailedScope
    const found = runWithOwner(createSubOwner(getOwner()), () => {
      const inner = createSubOwner(getOwner())
      innerScope = {
        kind: 'failed',
        active: () => false,
        error: () => null,
        reports: () => [],
        for: (e): e is TypeError => e instanceof TypeError,
        register: () => ({ report: () => {}, unregister: () => {} }),
        reset: () => {},
        resetMatching: () => {},
      }
      inner.boundaries.failed = innerScope
      return runWithOwner(inner, () => findNearestFailedScope(getOwner(), new TypeError('boom')))
    })

    expect(found?.scope).toBe(innerScope)
  })
})

test('findNearestFailedScope omitting for still accepts everything, exactly as before', () => {
  createRoot(() => {
    const found = findNearestFailedScope(getOwner(), new Error('x'))
    expect(found).not.toBeNull()
  })
})

test('a nearer, accepting catchError still wins over a farther FailedScope, exactly as before', () => {
  createRoot(() => {
    const outer = createSubOwner(getOwner())
    outer.boundaries.failed = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      reports: () => [],
      register: () => ({ report: () => {}, unregister: () => {} }),
      reset: () => {},
      resetMatching: () => {},
    }

    const found = runWithOwner(outer, () =>
      catchError(
        () => findNearestFailedScope(getOwner(), new Error('boom')),
        () => {},
      ),
    )

    expect(found).toBeNull()
  })
})

test('a nearer catchError that declines the error lets a farther FailedScope claim it', () => {
  createRoot(() => {
    const outer = createSubOwner(getOwner())
    const outerScope: FailedScope = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      reports: () => [],
      register: () => ({ report: () => {}, unregister: () => {} }),
      reset: () => {},
      resetMatching: () => {},
    }
    outer.boundaries.failed = outerScope

    const found = runWithOwner(outer, () =>
      catchError(
        () => findNearestFailedScope(getOwner(), new TypeError('boom')),
        () => {},
        { for: (e): e is RangeError => e instanceof RangeError },
      ),
    )

    expect(found?.scope).toBe(outerScope)
  })
})

test('Owner.boundaries.pending defaults to null', () => {
  createRoot(() => {
    const owner = getOwner()!
    expect(owner.boundaries.pending).toBe(null)
  })
})

test('createRoot installs a default FailedScope on the root owner', () => {
  createRoot(() => {
    const owner = getOwner()!
    expect(owner.boundaries.failed).not.toBeNull()
  })
})

test('the default FailedScope tracks active/error like any other FailedScope', () => {
  createRoot(() => {
    const found = findNearestFailedScope(getOwner(), new Error('x'))!
    expect(found.scope.active()).toBe(false)
    expect(found.scope.error()).toBeNull()

    const error = new Error('x')
    const controller = found.scope.register()
    controller.report({ status: 'failed', error, source: null, retry: () => {} })
    expect(found.scope.active()).toBe(true)
    expect(found.scope.error()).toBe(error)

    controller.report({ status: 'idle' })
    expect(found.scope.active()).toBe(false)
    expect(found.scope.error()).toBeNull()
  })
})

test('the default FailedScope logs every failed report to console.error', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const error = new Error('boom')
  createRoot(() => {
    const found = findNearestFailedScope(getOwner(), error)!
    const controller = found.scope.register()
    controller.report({ status: 'failed', error, source: null, retry: () => {} })
  })
  expect(spy).toHaveBeenCalledWith(error)
  spy.mockRestore()
})

test('an explicit FailedScope nested inside createRoot still wins over the root default', () => {
  createRoot(() => {
    const rootFound = findNearestFailedScope(getOwner(), new Error('x'))!
    const sub = createSubOwner(getOwner())
    const nestedScope: FailedScope = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      reports: () => [],
      register: () => ({ report: () => {}, unregister: () => {} }),
      reset: () => {},
      resetMatching: () => {},
    }
    sub.boundaries.failed = nestedScope
    const found = runWithOwner(sub, () => findNearestFailedScope(getOwner(), new Error('x')))!
    expect(found.scope).toBe(nestedScope)
    expect(found.scope).not.toBe(rootFound.scope)
  })
})

test('findBoundaryScope walks parent chain to find first non-null entry', () => {
  let captured: LoadingScope | null = null
  const scope: LoadingScope = {
    kind: 'pending',
    active: () => true,
    register: () => ({ report() {}, unregister() {} }),
    deferOrCommit(commit) { commit() },
  }
  createRoot(() => {
    const outer = getOwner()!
    outer.boundaries.pending = scope
    catchError(() => {
      // inner owner is a child of outer via createSubOwner inside catchError
      captured = findBoundaryScope(getOwner(), 'pending')
    }, () => {})
  })
  expect(captured).toBe(scope)
})

test('findBoundaryScope returns null when no scope on chain', () => {
  let captured: LoadingScope | null = { kind: 'pending', active: () => false, register: () => ({ report() {}, unregister() {} }), deferOrCommit(commit) { commit() } }
  createRoot(() => {
    captured = findBoundaryScope(getOwner(), 'pending')
  })
  expect(captured).toBe(null)
})

test('FailedScope.reports() reflects every currently-registered failed controller, in registration order', () => {
  const scope = createFailedScope()
  const errorA = new Error('a')
  const errorB = new Error('b')
  const controllerA = scope.register()
  const controllerB = scope.register()

  controllerA.report({ status: 'failed', error: errorA, source: null, retry: () => {} })
  controllerB.report({ status: 'failed', error: errorB, source: null, retry: () => {} })

  const reports = scope.reports()
  expect(reports).toHaveLength(2)
  expect(reports[0].error).toBe(errorA)
  expect(reports[1].error).toBe(errorB)
})

test('FailedScope.reports() removes an entry once its controller reports idle or unregisters', () => {
  const scope = createFailedScope()
  const errorA = new Error('a')
  const errorB = new Error('b')
  const controllerA = scope.register()
  const controllerB = scope.register()

  controllerA.report({ status: 'failed', error: errorA, source: null, retry: () => {} })
  controllerB.report({ status: 'failed', error: errorB, source: null, retry: () => {} })
  expect(scope.reports()).toHaveLength(2)

  controllerA.report({ status: 'idle' })
  expect(scope.reports()).toHaveLength(1)
  expect(scope.reports()[0].error).toBe(errorB)

  controllerB.unregister()
  expect(scope.reports()).toHaveLength(0)
})

test('a controller re-reporting the identical error does not publish a new reports array', () => {
  const scope = createFailedScope()
  const error = new Error('boom')
  const controller = scope.register()

  controller.report({ status: 'failed', error, source: null, retry: () => {} })
  const first = scope.reports()

  controller.report({ status: 'failed', error, source: null, retry: () => {} })
  const second = scope.reports()

  expect(second).toBe(first)
})

test('a later report of the identical error still refreshes source/retry, even though the published collection is not rewritten', () => {
  const scope = createFailedScope()
  const error = new Error('boom')
  const controller = scope.register()
  let firstRetryCalls = 0
  let secondRetryCalls = 0

  // A pending-to-failed settle can report before the source it will act on
  // is attached, and a later re-run of the same binding reports the
  // identical error again but this time with the retry that actually
  // recovers it. The published collection does not change between these
  // two reports (that is the no-op-report guarantee above), but reset()
  // must still act on the second report's retry, not the first.
  controller.report({ status: 'failed', error, source: null, retry: () => { firstRetryCalls++ } })
  const published = scope.reports()

  controller.report({ status: 'failed', error, source: null, retry: () => { secondRetryCalls++ } })
  expect(scope.reports()).toBe(published)

  scope.reset()
  expect(firstRetryCalls).toBe(0)
  expect(secondRetryCalls).toBe(1)
})

test('onFailedReport still fires on every failed report, even one that does not change the published collection', () => {
  const seen: unknown[] = []
  const scope = createFailedScope((error) => seen.push(error))
  const error = new Error('boom')
  const controller = scope.register()

  controller.report({ status: 'failed', error, source: null, retry: () => {} })
  controller.report({ status: 'failed', error, source: null, retry: () => {} })

  expect(seen).toEqual([error, error])
})

test('FailedScope.error()/active() still report the first entry, unaffected by reports() existing', () => {
  const scope = createFailedScope()
  const errorA = new Error('a')
  const errorB = new Error('b')
  const controllerA = scope.register()
  const controllerB = scope.register()

  expect(scope.active()).toBe(false)
  expect(scope.error()).toBe(null)

  controllerA.report({ status: 'failed', error: errorA, source: null, retry: () => {} })
  controllerB.report({ status: 'failed', error: errorB, source: null, retry: () => {} })

  expect(scope.active()).toBe(true)
  expect(scope.error()).toBe(errorA)
})

test('a change to a non-first report does not re-notify a consumer that only reads error()/active()', () => {
  const scope = createFailedScope()
  const controllerA = scope.register()
  const controllerB = scope.register()
  controllerA.report({ status: 'failed', error: new Error('a'), source: null, retry: () => {} })

  let runs = 0
  const c = r3Computed(() => {
    runs++
    return scope.error()
  })
  // Outside any ambient reactive context, read() does not force settlement
  // (it only does that dance when called from inside another computed) —
  // stabilize() is what actually walks and recomputes anything dirty,
  // mirroring exactly how error()/active()/reports() read themselves
  // outside a context. A computed created after its own dependency already
  // changed (errorNode/activeNode were created while reportsNode was still
  // empty, then reportsNode changed once before c was ever created) settles
  // its value correctly, but r3 may still charge one extra, value-identical
  // recompute the first time something actually reads through it — a
  // scheduling artifact of that ordering, not a bug in this file. Baseline
  // against the count AFTER this first settle, not against a fixed number.
  stabilize()
  const baseline = runs

  // B reports a genuinely new error. The full reports() set changes, but
  // the first entry (A's) does not, so error()/active() must not re-notify.
  controllerB.report({ status: 'failed', error: new Error('b1'), source: null, retry: () => {} })
  stabilize()
  expect(runs).toBe(baseline)

  controllerB.report({ status: 'failed', error: new Error('b2'), source: null, retry: () => {} })
  stabilize()
  expect(runs).toBe(baseline)

  // A's own report changing is what should actually re-notify.
  controllerA.report({ status: 'failed', error: new Error('a2'), source: null, retry: () => {} })
  stabilize()
  expect(runs).toBe(baseline + 1)
})
