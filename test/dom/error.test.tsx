import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  action,
  catchError,
  committed,
  computed,
  effect,
  Errored,
  flush,
  For,
  isErrored,
  Loading,
  microtaskScheduler,
  onCleanup,
  optimistic,
  from,
  render,
  setScheduler,
  Show,
  signal,
  syncScheduler,
  use,
  useErrored,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * An error is graph state, so the boundary that reads it is a SELECTION over that
 * state, not a stream of events. One rejection re-runs the consuming binding three
 * times (the pending signal flipping false, the error signal parking, and the
 * effect's settle-kick), and each re-run re-reads the failed node and re-throws.
 * All three reports come from the same controller, so the collection holds ONE
 * entry and the fallback renders once.
 */
test('one rejection renders the fallback once, however many times the binding re-runs', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  let fallbackRenders = 0
  render(
    () => (
      <Errored
        fallback={(error) => {
          fallbackRenders++
          return <p>{(error as Error).message}</p>
        }}
      >
        {() => <span>{() => use(c)}</span>}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()

  expect(target.textContent).toBe('boom')
  expect(fallbackRenders).toBe(1)
})

/** The boundary is not a latch. It shows the fallback exactly while something under
 *  it is failed — so when the error clears on its own, it returns to the subtree
 *  with no reset() call at all. */
test('the boundary unlatches itself when the error clears', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [id, setId] = signal(1)
  const c = computed(() =>
    id() === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
  )

  render(
    () => (
      <Errored fallback={(error) => <p>{(error as Error).message}</p>}>
        {() => <span>{() => use(c)}</span>}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.textContent).toBe('boom')

  setId(2)
  await tick()
  flush()

  expect(target.textContent).toBe('ok')
})

/** The collection is a set of failed bindings. It empties only when ALL of them
 *  recover. */
test('two failed siblings render one fallback, which clears only when both recover', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [id, setId] = signal(1)
  const a = computed(() =>
    id() === 1 ? Promise.reject(new Error('a-failed')) : Promise.resolve('a-ok'),
  )
  const b = computed(() =>
    id() <= 2 ? Promise.reject(new Error('b-failed')) : Promise.resolve('b-ok'),
  )

  render(
    () => (
      <Errored fallback={() => <p>fallback</p>}>
        {() => (
          <div>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
          </div>
        )}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.textContent).toBe('fallback')

  // `a` recovers; `b` is still failed, so the collection is still non-empty.
  setId(2)
  await tick()
  flush()
  expect(target.textContent).toBe('fallback')

  // Now both are healthy.
  setId(3)
  await tick()
  flush()
  expect(target.textContent).toBe('a-okb-ok')
})

/** `<Errored>` and `catchError` are peers in one walk up the owner chain. The
 *  nearest one wins, so a `catchError` INSIDE an `<Errored>` intercepts first and the
 *  boundary never activates. */
test('a catchError nested inside <Errored> wins, and the boundary never activates', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  const caught: unknown[] = []

  render(
    () => (
      <Errored fallback={() => <p>fallback</p>}>
        {() =>
          catchError(
            () => <span>{() => use(c)}</span>,
            (e) => caught.push(e),
          ) as Node
        }
      </Errored>
    ),
    target,
  )

  await tick()
  flush()

  expect(caught.length).toBeGreaterThan(0)
  expect((caught[0] as Error).message).toBe('boom')
  expect(target.textContent).not.toBe('fallback')
})

/** Suspension is not an error. A pending read routes to `<Loading>` and must never
 *  reach `<Errored>`. */
test('a pending read reaches <Loading>, never <Errored>', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let release!: (v: string) => void
  const c = computed(() => new Promise<string>((r) => (release = r)))

  render(
    () => (
      <Errored fallback={() => <p>failed</p>}>
        {() => (
          <Loading fallback={<p>loading</p>}>
            {() => <span>{() => use(c)}</span>}
          </Loading>
        )}
      </Errored>
    ),
    target,
  )

  flush()
  expect(target.textContent).toBe('loading')

  release('done')
  await tick()
  flush()

  expect(target.textContent).toBe('done')
})

/** The retry button. Nothing in the graph changed, so nothing will re-run on its
 *  own: reset() must clear the parked error on the node that failed and recompute
 *  it — even though that node was created outside the boundary entirely. */
test('reset() retries with unchanged inputs', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let attempt = 0
  const c = computed(() => {
    attempt++
    return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
  })

  render(
    () => (
      <Errored
        fallback={(error, reset) => (
          <button on:click={reset}>{(error as Error).message}</button>
        )}
      >
        {() => <span>{() => use(c)}</span>}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.textContent).toBe('boom')

  target.querySelector('button')!.click()
  await tick()
  flush()

  expect(target.textContent).toBe('ok')
  expect(attempt).toBe(2)
})

/** A downstream stage only PROPAGATES its upstream's error. Resetting it alone
 *  would leave the real source parked and the retry would fail identically, so
 *  reset() walks the upstream chain to the root failed stage. */
test('reset() recomputes the root failed stage of a pipeline, not the leaf', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let sourceRuns = 0
  const c = computed(
    () => {
      sourceRuns++
      return sourceRuns === 1
        ? Promise.reject(new Error('boom'))
        : Promise.resolve('raw')
    },
    (v: string) => `${v}-derived`,
  )

  render(
    () => (
      <Errored
        fallback={(error, reset) => (
          <button on:click={reset}>{(error as Error).message}</button>
        )}
      >
        {() => <span>{() => use(c)}</span>}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.textContent).toBe('boom')

  target.querySelector('button')!.click()
  await tick()
  flush()

  // Stage 0 re-ran (the root), and the derived stage rebuilt on top of it.
  expect(sourceRuns).toBe(2)
  expect(target.textContent).toBe('raw-derived')
})

/** A binding that threw a plain error has no failed node behind it (`source` is
 *  null). reset() simply re-runs the binding. */
test('reset() re-runs a binding that threw a plain error', () => {
  const target = document.createElement('section')
  document.body.append(target)

  let throwIt = true

  render(
    () => (
      <Errored
        fallback={(error, reset) => (
          <button on:click={reset}>{(error as Error).message}</button>
        )}
      >
        {() => (
          <span>
            {() => {
              if (throwIt) throw new Error('plain')
              return 'recovered'
            }}
          </span>
        )}
      </Errored>
    ),
    target,
  )

  flush()
  expect(target.textContent).toBe('plain')

  // No signal changed — only reset() can bring this binding back.
  throwIt = false
  target.querySelector('button')!.click()
  flush()

  expect(target.textContent).toBe('recovered')
})

/**
 * Error provenance ("which node failed") lives in module state, set right before a
 * computed's accessor throws its parked error and read by whichever binding catches
 * that throw. The invariant that keeps it from outliving the binding that set it: every
 * consumer of the source clears it on entry. A plain `effect()` with no `<Errored>`
 * boundary above it never reaches a consumer at all — its error is swallowed (routed
 * through `routeErrorFromRerun`, which only logs) — so if the effect does not clear the
 * source itself, it is left dangling in module state indefinitely. A LATER, completely
 * unrelated plain error under a real `<Errored>` boundary must not inherit that stale
 * source: its own `source` is `null` (it never touched a failed computed), and
 * `reset()` must not recompute the computed the first effect happened to leave behind.
 */
test('a stale error source from a swallowed, unboundaried effect does not leak into an unrelated <Errored> reset', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const [id, setId] = signal(1)
  let poisonedRuns = 0
  const poisoned = computed(() => {
    poisonedRuns++
    return id() === 1 ? Promise.resolve('ok') : Promise.reject(new Error('poisoned'))
  })

  // No <Errored> boundary anywhere near this effect. Its first run succeeds; flipping
  // `id` makes it fail on a re-run, which is swallowed silently by
  // `routeErrorFromRerun` — `takeErrorSource()` is never called, so `poisoned`'s
  // accessor is left parked as the module-level error source.
  effect(() => {
    use(poisoned)
  })

  await tick()
  flush()
  expect(poisonedRuns).toBe(1)

  setId(2)
  await tick()
  flush()
  expect(poisonedRuns).toBe(2)

  // Now something entirely unrelated: a plain effect, under a real <Errored> boundary,
  // that throws a plain error with no computed involved at all — its true `source`
  // is `null`.
  let throwIt = true
  render(
    () => (
      <Errored
        fallback={(error, reset) => (
          <button on:click={reset}>{(error as Error).message}</button>
        )}
      >
        {() => {
          effect(() => {
            if (throwIt) throw new Error('plain')
          })
          return <p>ok</p>
        }}
      </Errored>
    ),
    target,
  )

  flush()
  expect(target.textContent).toBe('plain')

  throwIt = false
  target.querySelector('button')!.click()
  flush()

  // The boundary's own binding recovers...
  expect(target.textContent).toBe('ok')
  // ...but `poisoned` — which this boundary never had anything to do with — must
  // not have been reset and recomputed.
  expect(poisonedRuns).toBe(2)
})

/**
 * The previous test's swallowing effect still enters a catch, so it cannot tell
 * apart the real fix (the source is cleared at the START of the binding compute)
 * from a weaker one (the source is cleared only inside the CATCH handler that
 * follows a throw). This test forces that distinction: the effect below reads a
 * failing computed inside its OWN `try/catch`, so the source gets marked but the
 * effect's OWN catch swallows it — the effect body then returns NORMALLY, without
 * throwing. A clear-in-catch fix never runs at all here, since `singleArgEffect`
 * never sees a throw to catch, and the marked source would stay parked in module
 * state. Clear-on-entry does not depend on a throw happening at all.
 */
test('a source marked and swallowed by the effect body itself (no throw reaches singleArgEffect) does not leak into an unrelated <Errored> reset', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let poisonedRuns = 0
  const poisoned = computed(() => {
    poisonedRuns++
    return Promise.reject(new Error('poisoned'))
  })

  // No <Errored> boundary anywhere near this effect. It reads `poisoned` inside its
  // OWN try/catch: `use(poisoned)` marks `poisoned` as the error source and
  // throws, the effect's own catch swallows that throw, and the effect body
  // returns normally — `singleArgEffect`'s body never sees a throw at all.
  effect(() => {
    try {
      use(poisoned)
    } catch {
      // swallowed here, on purpose — the effect body completes normally
    }
  })

  await tick()
  flush()
  expect(poisonedRuns).toBe(1)

  // Now something entirely unrelated: a plain effect, under a real <Errored>
  // boundary, that throws a plain error with no computed involved at all — its
  // true `source` is `null`.
  let throwIt = true
  render(
    () => (
      <Errored
        fallback={(error, reset) => (
          <button on:click={reset}>{(error as Error).message}</button>
        )}
      >
        {() => {
          effect(() => {
            if (throwIt) throw new Error('plain')
          })
          return <p>ok</p>
        }}
      </Errored>
    ),
    target,
  )

  flush()
  expect(target.textContent).toBe('plain')

  throwIt = false
  target.querySelector('button')!.click()
  flush()

  // The boundary's own binding recovers...
  expect(target.textContent).toBe('ok')
  // ...but `poisoned` — which this boundary never had anything to do with, and
  // which the first effect had already swallowed on its own — must not have been
  // reset and recomputed.
  expect(poisonedRuns).toBe(1)
})

test('a failed action registers with the nearest <Errored> boundary, and its retry button re-runs it', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let attempt = 0
  const [name, setName] = signal('alice')
  const save = () =>
    tick().then(() => {
      attempt++
      if (attempt === 1) throw new Error('save failed')
      return 'bob'
    })

  function saveToBob() {
    action(function* () {
      setName('bob')
      yield* from(save())
    })
  }

  render(
    () => (
      <Errored
        fallback={(error, reset) => (
          <button data-testid="retry" on:click={reset}>
            {(error as Error).message}
          </button>
        )}
      >
        {() => (
          <button data-testid="save" on:click={saveToBob}>
            save
          </button>
        )}
      </Errored>
    ),
    target,
  )

  const clickTestId = (id: string) => {
    const el = target.querySelector(`[data-testid="${id}"]`)
    ;(el as HTMLButtonElement).click()
  }

  clickTestId('save')
  await tick()
  flush()

  expect(target.querySelector('[data-testid="retry"]')).not.toBeNull()
  expect(name()).toBe('alice') // rolled back — the boundary's fallback is showing

  clickTestId('retry')
  await tick()
  flush()

  // reset() calls the failed report's own retry — the same retry() the
  // action's handle exposes — so the action runs again, no separate
  // check()-style binding needed anywhere.
  expect(target.querySelector('[data-testid="retry"]')).toBeNull()
  expect(committed(name)).toBe('bob')
  expect(attempt).toBe(2)
})

test('a mutation triggered from a reference-keyed row still reaches <Errored>, even though its own write recreates that row', async () => {
  // The row-recycling bug this design was fixed for: the mutation's own
  // optimistic write replaces the item with a fresh object, <For> is
  // reference-keyed (src/dom/for.ts), so it tears down and rebuilds the
  // triggering row immediately — before the request even settles. If the
  // action's disposal guard were anchored to the ROW's owner (the owner
  // ambient when action() was called), that immediate disposal would
  // incorrectly suppress the report. It is anchored to the BOUNDARY's
  // owner instead (see the comment on `disposed` in `action()`), which is
  // unaffected by the row being recycled underneath it.
  const target = document.createElement('section')
  document.body.append(target)

  type Item = { id: number; done: boolean }
  const [items] = signal<Item[]>([{ id: 1, done: false }])
  // optimistic(), matching examples/todo-async's overlay: this is what makes
  // the speculative write visible to <For> immediately, the same way it is
  // in the real demo — a plain signal written inside action() would stay
  // isolated in the speculative scope until commit, and this action never
  // commits, so <For> would never see the write and the row would never be
  // rebuilt at all, which would not reproduce the bug this test is about.
  const [overlay, setOverlay] = optimistic(items)
  let rowDisposals = 0

  function toggle(item: Item) {
    action(function* () {
      setOverlay(
        committed(() => overlay()).map((each) =>
          each.id === item.id ? { ...each, done: !each.done } : each,
        ),
      )
      yield* from(Promise.reject(new Error('server refused')))
    })
  }

  render(
    () => (
      <Errored
        fallback={(error) => <p data-testid="error-panel">{(error as Error).message}</p>}
      >
        {() => (
          <ul>
            <For each={overlay()}>
              {(item: Item) => {
                onCleanup(() => {
                  rowDisposals++
                })
                return (
                  <li>
                    <button data-testid={`toggle-${item.id}`} on:click={() => toggle(item)}>
                      toggle
                    </button>
                  </li>
                )
              }}
            </For>
          </ul>
        )}
      </Errored>
    ),
    target,
  )

  const button = target.querySelector('[data-testid="toggle-1"]') as HTMLButtonElement
  button.click()
  flush()

  // Confirms the premise: the row that triggered the mutation really was
  // torn down by the mutation's own optimistic write, not merely assumed to.
  expect(rowDisposals).toBe(1)

  await tick()
  flush()

  // The error still reached the boundary regardless.
  expect(target.querySelector('[data-testid="error-panel"]')).not.toBeNull()
})

test('an action that fails after its owning row unmounted (but the boundary is still mounted) still reaches the boundary', async () => {
  // The counterpart to the reference-keyed-row test above, stated directly:
  // disposal of the calling owner alone is no longer a suppression signal.
  // Only the boundary's own disposal is — see the next test.
  const target = document.createElement('section')
  document.body.append(target)

  let reject: ((e: Error) => void) | null = null
  const pending = new Promise<void>((_, r) => {
    reject = r
  })
  const [visible, setVisible] = signal(true)

  function Widget() {
    return (
      <button
        data-testid="save"
        on:click={() => {
          action(function* () {
            yield* from(pending)
          })
        }}
      >
        save
      </button>
    )
  }

  render(
    () => (
      <Errored
        fallback={(error) => <p data-testid="error-panel">{(error as Error).message}</p>}
      >
        {() => <Show when={visible()}>{() => <Widget />}</Show>}
      </Errored>
    ),
    target,
  )

  flush()

  const clickTestId = (id: string) => {
    const el = target.querySelector(`[data-testid="${id}"]`)
    ;(el as HTMLButtonElement).click()
  }

  clickTestId('save') // the action starts; its promise stays pending on `reject`

  // Unmount the widget while the action is still in flight — its owner
  // disposes before anything has failed. The boundary itself stays mounted.
  setVisible(false)
  flush()
  expect(target.querySelector('[data-testid="save"]')).toBeNull()

  // Only now does the mutation actually fail.
  reject!(new Error('too late'))
  await tick()
  flush()

  // The boundary is still alive, so it still shows the error — this is
  // exactly the shape of the reference-keyed row bug, just triggered by
  // <Show> instead of <For>'s re-keying.
  expect(target.querySelector('[data-testid="error-panel"]')).not.toBeNull()
})

test('an action that fails after its <Errored> boundary itself unmounted escalates to the implicit root instead of registering a stale entry', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const target = document.createElement('section')
  document.body.append(target)

  let reject: ((e: Error) => void) | null = null
  const pending = new Promise<void>((_, r) => {
    reject = r
  })
  const [boundaryVisible, setBoundaryVisible] = signal(true)

  function Widget() {
    return (
      <button
        data-testid="save"
        on:click={() => {
          action(function* () {
            yield* from(pending)
          })
        }}
      >
        save
      </button>
    )
  }

  render(
    () => (
      <Show when={boundaryVisible()}>
        {() => (
          <Errored
            fallback={(error) => <p data-testid="error-panel">{(error as Error).message}</p>}
          >
            {() => <Widget />}
          </Errored>
        )}
      </Show>
    ),
    target,
  )

  flush()

  const clickTestId = (id: string) => {
    const el = target.querySelector(`[data-testid="${id}"]`)
    ;(el as HTMLButtonElement).click()
  }

  clickTestId('save') // the action starts; its promise stays pending on `reject`

  // Unmount the BOUNDARY itself (not just the widget beneath it) while the
  // action is still in flight.
  setBoundaryVisible(false)
  flush()
  expect(target.querySelector('[data-testid="save"]')).toBeNull()

  // Only now does the mutation actually fail — after the boundary that would
  // have shown it no longer exists.
  reject!(new Error('too late'))
  await tick()
  flush()

  // The explicit boundary is gone, so its fallback never shows...
  expect(target.querySelector('[data-testid="error-panel"]')).toBeNull()
  // ...but the error is not silently dropped: candidate collection walks
  // past the now-disposed boundary to the next one, which is always the
  // implicit root createRoot() installs — the same place any other
  // unboundaried error ends up, logged the same way.
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: 'too late' }))
  spy.mockRestore()
})

test('<Errored> without a fallback keeps its children mounted through an error', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  // Without this spy, the pre-fix crash (calling undefined as a function) is
  // silently swallowed by routeErrorFromRerun's console.error, leaving the
  // DOM untouched and this test passing for the wrong reason — nothing ever
  // attempted to swap it out, rather than <Errored> correctly declining to.
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

  render(
    () => (
      <Errored>
        {() => (
          <div>
            <span data-testid="content">static</span>
            <p>{() => use(c)}</p>
          </div>
        )}
      </Errored>
    ),
    target,
  )

  const before = target.querySelector('[data-testid="content"]')
  expect(before).not.toBeNull()

  await tick()
  flush()

  // Something inside failed, but <Errored> has no fallback to swap to — the
  // exact same node is still there, not torn down and rebuilt, and nothing
  // crashed trying to call a fallback that doesn't exist.
  expect(target.querySelector('[data-testid="content"]')).toBe(before)
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
})

test('useErrored() reflects the nearest boundary reactively, with nothing swapped', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  let state!: ReturnType<typeof useErrored>

  render(
    () => (
      <Errored>
        {() => {
          state = useErrored()
          return <p>{() => use(c)}</p>
        }}
      </Errored>
    ),
    target,
  )

  expect(state.active()).toBe(false)

  await tick()
  flush()

  expect(state.active()).toBe(true)
  expect((state.error() as Error).message).toBe('boom')
})

test('useErrored().retry retries every failed report, the same operation reset() performs', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let attempt = 0
  const c = computed(() => {
    attempt++
    return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
  })
  let state!: ReturnType<typeof useErrored>

  render(
    () => (
      <Errored>
        {() => {
          state = useErrored()
          return <p>{() => use(c)}</p>
        }}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()
  expect(state.active()).toBe(true)

  state.retry()
  await tick()
  flush()

  expect(state.active()).toBe(false)
  expect(attempt).toBe(2)
})

test('useErrored() called with no owner at all returns a safe, always-inactive state', () => {
  const state = useErrored()
  expect(state.active()).toBe(false)
  expect(state.error()).toBeNull()
  expect(() => state.retry()).not.toThrow()
})

test('isErrored() reflects the nearest boundary, read fresh each call', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  render(
    () => (
      <Errored>
        {() => (
          // No static wrapper element needed: a component sitting directly
          // under a bare Fragment still reaches the boundary's owner.
          <>
            <Show when={isErrored() !== undefined} fallback={<i>healthy</i>}>
              {() => <i>errored</i>}
            </Show>
            <p>{use(c)}</p>
          </>
        )}
      </Errored>
    ),
    target,
  )
  // Show's own binding-effect, for a component sitting directly under a
  // Fragment, is created one effect-nesting level deep (inside Errored's
  // own wrapping effect) — an explicit flush() settles it, the same as a
  // microtask tick would in production under the default scheduler.
  flush()

  expect(target.textContent).toContain('healthy')

  await tick()
  flush()

  expect(target.textContent).toContain('errored')
  expect(target.textContent).not.toContain('healthy')
})

test('isErrored().retry retries every failed report, the same operation reset() performs', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let attempt = 0
  const c = computed(() => {
    attempt++
    return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
  })
  let retry: (() => void) | undefined

  render(
    () => (
      <Errored>
        {() => (
          <>
            {/* isErrored(predicate) written as a type guard narrows the
                Truthy branch Show hands to `children` — `state.error` comes
                back typed as `Error`, not `unknown`. */}
            <Show when={isErrored((error): error is Error => error instanceof Error)}>
              {(state) => {
                retry = state.retry
                return <p>{state.error.message}</p>
              }}
            </Show>
            <p>{use(c)}</p>
          </>
        )}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()
  expect(retry).toBeDefined()
  expect(target.textContent).toContain('boom')

  retry!()
  await tick()
  flush()

  expect(attempt).toBe(2)
})

test('isErrored() called with no owner at all returns undefined', () => {
  expect(isErrored()).toBeUndefined()
})

test('Errored.Error renders nothing while the boundary is healthy, and the error UI once it fails', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  render(
    () => (
      <Errored>
        {() => (
          <div>
            <Errored.Error>
              {(error) => <p data-testid="error-ui">{(error as Error).message}</p>}
            </Errored.Error>
            <span>{() => use(c)}</span>
          </div>
        )}
      </Errored>
    ),
    target,
  )

  expect(target.querySelector('[data-testid="error-ui"]')).toBeNull()

  await tick()
  flush()

  expect(target.querySelector('[data-testid="error-ui"]')?.textContent).toBe('boom')
})

test('Errored.Error disposes what its render prop constructed when the error clears', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [id, setId] = signal(1)
  const c = computed(() =>
    id() === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
  )
  let disposals = 0

  render(
    () => (
      <Errored>
        {() => (
          <div>
            <Errored.Error>
              {() => {
                onCleanup(() => {
                  disposals++
                })
                return <p data-testid="error-ui">failed</p>
              }}
            </Errored.Error>
            <span>{() => use(c)}</span>
          </div>
        )}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.querySelector('[data-testid="error-ui"]')).not.toBeNull()
  expect(disposals).toBe(0)

  setId(2)
  await tick()
  flush()

  // The error cleared — Errored.Error's own content must be GONE, and its
  // onCleanup must actually have fired, not just have been hidden while
  // still alive underneath.
  expect(target.querySelector('[data-testid="error-ui"]')).toBeNull()
  expect(disposals).toBe(1)
})

test('Errored.Error\'s retry() clears the error, the same as useErrored().retry()', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let attempt = 0
  const c = computed(() => {
    attempt++
    return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
  })

  render(
    () => (
      <Errored>
        {() => (
          <div>
            <Errored.Error>
              {(_error, retry) => (
                <button data-testid="retry" on:click={retry}>
                  retry
                </button>
              )}
            </Errored.Error>
            <span>{() => use(c)}</span>
          </div>
        )}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()
  const button = target.querySelector('[data-testid="retry"]') as HTMLButtonElement
  expect(button).not.toBeNull()

  button.click()
  await tick()
  flush()

  expect(target.querySelector('[data-testid="retry"]')).toBeNull()
  expect(attempt).toBe(2)
})

test('Errored.Error does not reconstruct its content while the boundary stays active, even if the underlying error changes', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [failA, setFailA] = signal(true)
  const a = computed(() =>
    failA() ? Promise.reject(new Error('first')) : Promise.resolve('ok'),
  )
  const b = computed(() => Promise.reject(new Error('second')))
  let renders = 0

  render(
    () => (
      <Errored>
        {() => (
          <div>
            <Errored.Error>
              {() => {
                renders++
                return <p data-testid="error-ui">shown</p>
              }}
            </Errored.Error>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
          </div>
        )}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.querySelector('[data-testid="error-ui"]')).not.toBeNull()
  expect(renders).toBe(1)

  // `a` recovers while `b` is still failing — the collection shrinks from
  // two entries to one, its reported error changes from a's message to
  // b's, but `active` never goes false in between. The render prop must
  // not be re-invoked for a change that isn't an active/inactive transition.
  setFailA(false)
  await tick()
  flush()

  expect(target.querySelector('[data-testid="error-ui"]')).not.toBeNull()
  expect(renders).toBe(1)
})

test('a computed error with no explicit <Errored> anywhere still registers with the implicit root boundary, and still logs', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  render(() => <span>{() => use(c)}</span>, target)

  await tick()
  flush()

  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
  spy.mockRestore()
})

test('useErrored() with no explicit <Errored> reports the implicit root boundary, aggregating unrelated errors', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  let state!: ReturnType<typeof useErrored>

  render(
    () => (
      <div>
        <span>{() => use(c)}</span>
        <p data-testid="unrelated">
          {() => {
            state = useErrored()
            return 'unrelated content'
          }}
        </p>
      </div>
    ),
    target,
  )

  expect(state.active()).toBe(false)

  await tick()
  flush()

  // Nothing explicit connects these two siblings — no <Errored> boundary
  // scopes either of them. With no explicit boundary anywhere, useErrored()
  // reports the implicit root boundary, which aggregates every unboundaried
  // error in the whole root, not just ones structurally "near" this call.
  expect(state.active()).toBe(true)
  expect((state.error() as Error).message).toBe('boom')
  spy.mockRestore()
})

test('<Errored> with a declining for lets a computed rejection propagate to a farther, accepting <Errored>', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new TypeError('boom')))

  render(
    () => (
      <Errored
        for={(e: unknown): e is Error => e instanceof Error}
        fallback={(error) => <p data-testid="outer-panel">{(error as Error).message}</p>}
      >
        {() => (
          <Errored
            for={(e: unknown): e is RangeError => e instanceof RangeError}
            fallback={() => <p data-testid="inner-panel">inner</p>}
          >
            {() => <span>{() => use(c)}</span>}
          </Errored>
        )}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()

  expect(target.querySelector('[data-testid="inner-panel"]')).toBeNull()
  expect(target.querySelector('[data-testid="outer-panel"]')?.textContent).toBe('boom')
})

test('a computed that re-fails with a different error type re-routes to the boundary that accepts it, not the one that claimed its earlier error', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [errorKind, setErrorKind] = signal<'range' | 'type'>('range')
  const c = computed(() =>
    errorKind() === 'range'
      ? Promise.reject(new RangeError('range boom'))
      : Promise.reject(new TypeError('type boom')),
  )

  render(
    () => (
      <Errored
        for={(e: unknown): e is TypeError => e instanceof TypeError}
        fallback={(error) => <p data-testid="outer-panel">{(error as Error).message}</p>}
      >
        {() => (
          <Errored
            for={(e: unknown): e is RangeError => e instanceof RangeError}
            fallback={(error) => <p data-testid="inner-panel">{(error as Error).message}</p>}
          >
            {() => <span>{() => use(c)}</span>}
          </Errored>
        )}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()

  expect(target.querySelector('[data-testid="inner-panel"]')?.textContent).toBe('range boom')
  expect(target.querySelector('[data-testid="outer-panel"]')).toBeNull()

  setErrorKind('type')
  await tick()
  flush()

  // The second error is a different type. The inner boundary already
  // claimed the first one, but it declines this one — the report must
  // move to the outer boundary, not stay latched onto the inner one.
  expect(target.querySelector('[data-testid="inner-panel"]')).toBeNull()
  expect(target.querySelector('[data-testid="outer-panel"]')?.textContent).toBe('type boom')
})

test('action() skips a nearer <Errored> whose for declines the error, and registers with a farther one that accepts', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  render(
    () => (
      <Errored
        for={(e: unknown): e is Error => e instanceof Error}
        fallback={(error) => <p data-testid="outer-panel">{(error as Error).message}</p>}
      >
        {() => (
          <Errored
            for={(e: unknown): e is RangeError => e instanceof RangeError}
            fallback={() => <p data-testid="inner-panel">inner</p>}
          >
            {() => (
              <button
                data-testid="trigger"
                on:click={() =>
                  action(function* () {
                    yield* from(Promise.reject(new TypeError('boom')))
                  })
                }
              >
                trigger
              </button>
            )}
          </Errored>
        )}
      </Errored>
    ),
    target,
  )

  // Nested <Errored> boundaries defer their innermost commit by one flush,
  // unlike a single <Errored> wrapping a button directly — flush() once
  // before querying, or the button is not in the DOM yet to click.
  flush()
  const button = target.querySelector('[data-testid="trigger"]') as HTMLButtonElement
  button.click()
  await tick()
  flush()

  expect(target.querySelector('[data-testid="inner-panel"]')).toBeNull()
  expect(target.querySelector('[data-testid="outer-panel"]')?.textContent).toBe('boom')
})

test('a mutation triggered from a reference-keyed row still reaches a filtered <Errored>, even though its own write recreates that row', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  type Item = { id: number; done: boolean }
  const [items] = signal<Item[]>([{ id: 1, done: false }])
  const [overlay, setOverlay] = optimistic(items)
  let rowDisposals = 0

  function toggle(item: Item) {
    action(function* () {
      setOverlay(
        committed(() => overlay()).map((each) =>
          each.id === item.id ? { ...each, done: !each.done } : each,
        ),
      )
      yield* from(Promise.reject(new Error('server refused')))
    })
  }

  render(
    () => (
      <Errored
        for={(e: unknown): e is Error => e instanceof Error}
        fallback={(error) => <p data-testid="error-panel">{(error as Error).message}</p>}
      >
        {() => (
          <ul>
            <For each={overlay()}>
              {(item: Item) => {
                onCleanup(() => {
                  rowDisposals++
                })
                return (
                  <li>
                    <button data-testid={`toggle-${item.id}`} on:click={() => toggle(item)}>
                      toggle
                    </button>
                  </li>
                )
              }}
            </For>
          </ul>
        )}
      </Errored>
    ),
    target,
  )

  const button = target.querySelector('[data-testid="toggle-1"]') as HTMLButtonElement
  button.click()
  flush()

  // Confirms the premise, same as the equivalent unfiltered test from the
  // earlier session's work: the row that triggered the mutation really was
  // torn down by the mutation's own optimistic write, not merely assumed to.
  expect(rowDisposals).toBe(1)

  await tick()
  flush()

  // The error still reached the filtered boundary regardless — proving
  // the multi-candidate restructuring did not regress the disposal-anchor
  // fix this exact scenario exists to guard.
  expect(target.querySelector('[data-testid="error-panel"]')).not.toBeNull()
})

test('useErrored(predicate) finds a match that is not the first-registered report, under one unfiltered boundary', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let rejectA!: (e: Error) => void
  let rejectB!: (e: Error) => void
  const a = computed(() => new Promise<never>((_, reject) => { rejectA = reject }))
  const b = computed(() => new Promise<never>((_, reject) => { rejectB = reject }))
  let filtered!: ReturnType<typeof useErrored<TypeError>>
  let unfiltered!: ReturnType<typeof useErrored>

  render(
    () => (
      <Errored>
        {() => (
          <div>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
            <p>
              {() => {
                filtered = useErrored((e): e is TypeError => e instanceof TypeError)
                unfiltered = useErrored()
                return 'x'
              }}
            </p>
          </div>
        )}
      </Errored>
    ),
    target,
  )

  flush()

  // a fails first, becoming the boundary's own "first" report.
  rejectA(new RangeError('a-failed'))
  await tick()
  flush()

  // b fails second, with the type the predicate actually wants.
  rejectB(new TypeError('b-failed'))
  await tick()
  flush()

  // The boundary's own, unfiltered error() is a's — it registered first.
  expect(unfiltered.error()).toBeInstanceOf(RangeError)
  // The predicate correctly finds b's, even though it is not first.
  expect(filtered.active()).toBe(true)
  expect(filtered.error()).toBeInstanceOf(TypeError)
  expect((filtered.error() as TypeError).message).toBe('b-failed')
})

test('useErrored(predicate).retry() retries only matching reports, leaving a non-matching one still active', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let attemptA = 0
  let attemptB = 0
  const a = computed(() => {
    attemptA++
    return attemptA === 1 ? Promise.reject(new RangeError('a-failed')) : Promise.resolve('a-ok')
  })
  const b = computed(() => {
    attemptB++
    return Promise.reject(new TypeError('b-failed'))
  })
  let filtered!: ReturnType<typeof useErrored<RangeError>>
  let unfiltered!: ReturnType<typeof useErrored>

  render(
    () => (
      <Errored>
        {() => (
          <div>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
            <p>
              {() => {
                filtered = useErrored((e): e is RangeError => e instanceof RangeError)
                unfiltered = useErrored()
                return 'x'
              }}
            </p>
          </div>
        )}
      </Errored>
    ),
    target,
  )

  await tick()
  flush()

  expect(filtered.active()).toBe(true)
  expect(attemptA).toBe(1)
  expect(attemptB).toBe(1)

  filtered.retry()
  await tick()
  flush()

  // Only a's RangeError-matching report was retried.
  expect(attemptA).toBe(2)
  // b's TypeError report was never touched.
  expect(attemptB).toBe(1)
  // a recovered, so the predicate no longer finds a match.
  expect(filtered.active()).toBe(false)
  // The boundary as a whole is still active — b's error is still there.
  expect(unfiltered.active()).toBe(true)
})

test("Errored.Error's for prop narrows what it displays to reports matching it", async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let rejectA!: (e: Error) => void
  let rejectB!: (e: Error) => void
  const a = computed(() => new Promise<never>((_, reject) => { rejectA = reject }))
  const b = computed(() => new Promise<never>((_, reject) => { rejectB = reject }))

  render(
    () => (
      <Errored>
        {() => (
          <div>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
            <Errored.Error for={(e: unknown): e is TypeError => e instanceof TypeError}>
              {/* error is narrowed to TypeError by the type-guard for prop
                  above — .message reads directly, no cast needed. */}
              {(error) => <p data-testid="type-error-only">{error.message}</p>}
            </Errored.Error>
          </div>
        )}
      </Errored>
    ),
    target,
  )

  flush()
  rejectA(new RangeError('a-failed'))
  await tick()
  flush()

  // Only a (RangeError) has failed so far — the TypeError-only display stays hidden.
  expect(target.querySelector('[data-testid="type-error-only"]')).toBeNull()

  rejectB(new TypeError('b-failed'))
  await tick()
  flush()

  expect(target.querySelector('[data-testid="type-error-only"]')?.textContent).toBe('b-failed')
})

// Regression: an error boundary must be driven by its OWN write, not by
// incidental traffic elsewhere in the tree. `createErrorScope`'s `recompute`
// (src/owner.ts) writes r3's `reportsNode` directly, and r3's `setSignal` only
// marks subscribers dirty in its heap — something must call `stabilize()` to
// drain it. That write used to skip `requestFlush()`, so every consumer of the
// scope (`<Errored.Error>`, `isErrored()`, `useErrored()`) sat dirty and never
// recomputed until some unrelated write happened to request a flush. In a tree
// where something else called `use()` on every pass, that incidental flush
// always arrived and the bug was invisible; remove the last such call and the
// error boundary silently went dead.
//
// The manual `flush()` calls the other tests in this file make would mask it —
// this one deliberately makes none after the click, so the framework's own
// writer-side scheduling is what has to drive the update.
test('an action rejection reaches Errored.Error with no manual flush (boundary drives its own write)', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  render(
    () => (
      <Errored for={(e): e is Error => e instanceof Error}>
        {() => (
          <div>
            <Errored.Error>
              {(error) => <p data-testid="error-ui">{(error as Error).message}</p>}
            </Errored.Error>
            <button
              data-testid="trigger"
              on:click={() =>
                action(function* () {
                  yield* from(Promise.reject(new Error('boom')))
                })
              }
            >
              trigger
            </button>
          </div>
        )}
      </Errored>
    ),
    target,
  )

  flush()
  expect(target.querySelector('[data-testid="error-ui"]')).toBeNull()

  const button = target.querySelector('[data-testid="trigger"]') as HTMLButtonElement
  button.click()
  await tick()

  expect(target.querySelector('[data-testid="error-ui"]')?.textContent).toBe('boom')
})

// The same pairing, for the other direct r3 writer: `makeErrorCell`'s
// `setError` (src/scope.ts), which backs `action().error`. It has to be read
// through a BINDING here, not called at top level: the accessor takes the
// `getContext() === null` branch for an untracked read and calls `stabilize()`
// itself, which papers over the missing flush. Only a tracked read — the r3
// `read` branch, which is what a real UI does — actually depends on the write
// having requested one.
test('action().error reaches a binding that displays it, with no manual flush', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  // The action is created up front, so the binding below can actually track
  // its error cell; it fails later, when the promise it is waiting on rejects.
  let rejectIt!: (e: unknown) => void
  const pending = new Promise<never>((_, reject) => {
    rejectIt = reject
  })

  render(
    () => {
      const handle = action(function* () {
        yield* from(pending)
      })
      return <p data-testid="err">{() => (handle.error() as Error | null)?.message ?? 'none'}</p>
    },
    target,
  )

  flush()
  expect(target.querySelector('[data-testid="err"]')?.textContent).toBe('none')

  rejectIt(new Error('boom'))
  await tick()

  expect(target.querySelector('[data-testid="err"]')?.textContent).toBe('boom')
})

// `handle.retry()` clears the error cell via `setError(null)` with NO
// accompanying boundary report, so `createErrorScope`'s own `requestFlush` (in
// src/owner.ts) does not cover this path — `makeErrorCell`'s write has to
// request the flush itself.
test('action().retry() clears a displayed error with no manual flush', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let rejectFirst!: (e: unknown) => void
  const first = new Promise<never>((_, reject) => {
    rejectFirst = reject
  })
  let attempt = 0
  let handle!: ReturnType<typeof action>

  render(
    () => {
      handle = action(function* () {
        attempt++
        yield* from(attempt === 1 ? first : new Promise<never>(() => {}))
      })
      return <p data-testid="err">{() => (handle.error() as Error | null)?.message ?? 'none'}</p>
    },
    target,
  )

  flush()
  rejectFirst(new Error('boom'))
  await tick()
  expect(target.querySelector('[data-testid="err"]')?.textContent).toBe('boom')

  // Retry directly on the handle. The second attempt never settles, so the
  // only thing that should reach the DOM is the error clearing to null.
  handle.retry()
  await tick()

  expect(target.querySelector('[data-testid="err"]')?.textContent).toBe('none')
})
