import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  action,
  catchError,
  committed,
  computed,
  effect,
  Failed,
  flush,
  For,
  Loading,
  microtaskScheduler,
  onCleanup,
  optimistic,
  read,
  render,
  setScheduler,
  Show,
  signal,
  syncScheduler,
  use,
  useFailed,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * A failure is graph state, so the boundary that reads it is a SELECTION over that
 * state, not a stream of events. One rejection re-runs the consuming binding three
 * times (the pending signal flipping false, the failure signal parking, and the
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
      <Failed
        fallback={(error) => {
          fallbackRenders++
          return <p>{(error as Error).message}</p>
        }}
      >
        {() => <span>{() => use(c)}</span>}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()

  expect(target.textContent).toBe('boom')
  expect(fallbackRenders).toBe(1)
})

/** The boundary is not a latch. It shows the fallback exactly while something under
 *  it is failed — so when the failure clears on its own, it returns to the subtree
 *  with no reset() call at all. */
test('the boundary unlatches itself when the failure clears', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [id, setId] = signal(1)
  const c = computed(() =>
    id() === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
  )

  render(
    () => (
      <Failed fallback={(error) => <p>{(error as Error).message}</p>}>
        {() => <span>{() => use(c)}</span>}
      </Failed>
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
      <Failed fallback={() => <p>fallback</p>}>
        {() => (
          <div>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
          </div>
        )}
      </Failed>
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

/** `<Failed>` and `catchError` are peers in one walk up the owner chain. The
 *  nearest one wins, so a `catchError` INSIDE a `<Failed>` intercepts first and the
 *  boundary never activates. */
test('a catchError nested inside <Failed> wins, and the boundary never activates', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  const caught: unknown[] = []

  render(
    () => (
      <Failed fallback={() => <p>fallback</p>}>
        {() =>
          catchError(
            () => <span>{() => use(c)}</span>,
            (e) => caught.push(e),
          ) as Node
        }
      </Failed>
    ),
    target,
  )

  await tick()
  flush()

  expect(caught.length).toBeGreaterThan(0)
  expect((caught[0] as Error).message).toBe('boom')
  expect(target.textContent).not.toBe('fallback')
})

/** Suspension is not a failure. A pending read routes to `<Loading>` and must never
 *  reach `<Failed>`. */
test('a pending read reaches <Loading>, never <Failed>', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let release!: (v: string) => void
  const c = computed(() => new Promise<string>((r) => (release = r)))

  render(
    () => (
      <Failed fallback={() => <p>failed</p>}>
        {() => (
          <Loading fallback={<p>loading</p>}>
            {() => <span>{() => use(c)}</span>}
          </Loading>
        )}
      </Failed>
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
 *  own: reset() must clear the parked failure on the node that failed and recompute
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
      <Failed
        fallback={(error, reset) => (
          <button on:click={reset}>{(error as Error).message}</button>
        )}
      >
        {() => <span>{() => use(c)}</span>}
      </Failed>
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

/** A downstream stage only PROPAGATES its upstream's failure. Resetting it alone
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
      <Failed
        fallback={(error, reset) => (
          <button on:click={reset}>{(error as Error).message}</button>
        )}
      >
        {() => <span>{() => use(c)}</span>}
      </Failed>
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
      <Failed
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
      </Failed>
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
 * Failure provenance ("which node failed") lives in module state, set right before a
 * computed's accessor throws its parked failure and read by whichever binding catches
 * that throw. The invariant that keeps it from outliving the binding that set it: every
 * consumer of the source clears it on entry. A plain `effect()` with no `<Failed>`
 * boundary above it never reaches a consumer at all — its failure is swallowed (routed
 * through `routeErrorFromRerun`, which only logs) — so if the effect does not clear the
 * source itself, it is left dangling in module state indefinitely. A LATER, completely
 * unrelated plain error under a real `<Failed>` boundary must not inherit that stale
 * source: its own `source` is `null` (it never touched a failed computed), and
 * `reset()` must not recompute the computed the first effect happened to leave behind.
 */
test('a stale failure source from a swallowed, unboundaried effect does not leak into an unrelated <Failed> reset', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const [id, setId] = signal(1)
  let poisonedRuns = 0
  const poisoned = computed(() => {
    poisonedRuns++
    return id() === 1 ? Promise.resolve('ok') : Promise.reject(new Error('poisoned'))
  })

  // No <Failed> boundary anywhere near this effect. Its first run succeeds; flipping
  // `id` makes it fail on a re-run, which is swallowed silently by
  // `routeErrorFromRerun` — `takeFailureSource()` is never called, so `poisoned`'s
  // accessor is left parked as the module-level failure source.
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

  // Now something entirely unrelated: a plain effect, under a real <Failed> boundary,
  // that throws a plain error with no computed involved at all — its true `source`
  // is `null`.
  let throwIt = true
  render(
    () => (
      <Failed
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
      </Failed>
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
test('a source marked and swallowed by the effect body itself (no throw reaches singleArgEffect) does not leak into an unrelated <Failed> reset', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let poisonedRuns = 0
  const poisoned = computed(() => {
    poisonedRuns++
    return Promise.reject(new Error('poisoned'))
  })

  // No <Failed> boundary anywhere near this effect. It reads `poisoned` inside its
  // OWN try/catch: `use(poisoned)` marks `poisoned` as the failure source and
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

  // Now something entirely unrelated: a plain effect, under a real <Failed>
  // boundary, that throws a plain error with no computed involved at all — its
  // true `source` is `null`.
  let throwIt = true
  render(
    () => (
      <Failed
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
      </Failed>
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

test('a failed action registers with the nearest <Failed> boundary, and its retry button re-runs it', async () => {
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
      yield* read(save())
    })
  }

  render(
    () => (
      <Failed
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
      </Failed>
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

test('a mutation triggered from a reference-keyed row still reaches <Failed>, even though its own write recreates that row', async () => {
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
      yield* read(Promise.reject(new Error('server refused')))
    })
  }

  render(
    () => (
      <Failed
        fallback={(error) => <p data-testid="error-panel">{(error as Error).message}</p>}
      >
        {() => (
          <ul>
            <For each={overlay}>
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
      </Failed>
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

  // The failure still reached the boundary regardless.
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
            yield* read(pending)
          })
        }}
      >
        save
      </button>
    )
  }

  render(
    () => (
      <Failed
        fallback={(error) => <p data-testid="error-panel">{(error as Error).message}</p>}
      >
        {() => <Show when={visible}>{() => <Widget />}</Show>}
      </Failed>
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

  // The boundary is still alive, so it still shows the failure — this is
  // exactly the shape of the reference-keyed row bug, just triggered by
  // <Show> instead of <For>'s re-keying.
  expect(target.querySelector('[data-testid="error-panel"]')).not.toBeNull()
})

test('an action that fails after its <Failed> boundary itself unmounted does not register a stale entry anywhere', async () => {
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
            yield* read(pending)
          })
        }}
      >
        save
      </button>
    )
  }

  render(
    () => (
      <Show when={boundaryVisible}>
        {() => (
          <Failed
            fallback={(error) => <p data-testid="error-panel">{(error as Error).message}</p>}
          >
            {() => <Widget />}
          </Failed>
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

  // Nothing left to register with, and nothing stuck: no fallback anywhere.
  expect(target.querySelector('[data-testid="error-panel"]')).toBeNull()
})

test('<Failed> without a fallback keeps its children mounted through a failure', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  // Without this spy, the pre-fix crash (calling undefined as a function) is
  // silently swallowed by routeErrorFromRerun's console.error, leaving the
  // DOM untouched and this test passing for the wrong reason — nothing ever
  // attempted to swap it out, rather than <Failed> correctly declining to.
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <span data-testid="content">static</span>
            <p>{() => use(c)}</p>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  const before = target.querySelector('[data-testid="content"]')
  expect(before).not.toBeNull()

  await tick()
  flush()

  // Something inside failed, but <Failed> has no fallback to swap to — the
  // exact same node is still there, not torn down and rebuilt, and nothing
  // crashed trying to call a fallback that doesn't exist.
  expect(target.querySelector('[data-testid="content"]')).toBe(before)
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
})

test('useFailed() reflects the nearest boundary reactively, with nothing swapped', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  let state!: ReturnType<typeof useFailed>

  render(
    () => (
      <Failed>
        {() => {
          state = useFailed()
          return <p>{() => use(c)}</p>
        }}
      </Failed>
    ),
    target,
  )

  expect(state.active()).toBe(false)

  await tick()
  flush()

  expect(state.active()).toBe(true)
  expect((state.error() as Error).message).toBe('boom')
})

test('useFailed().retry retries every failed report, the same operation reset() performs', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let attempt = 0
  const c = computed(() => {
    attempt++
    return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
  })
  let state!: ReturnType<typeof useFailed>

  render(
    () => (
      <Failed>
        {() => {
          state = useFailed()
          return <p>{() => use(c)}</p>
        }}
      </Failed>
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

test('useFailed() called with no owner at all returns a safe, always-inactive state', () => {
  const state = useFailed()
  expect(state.active()).toBe(false)
  expect(state.error()).toBeNull()
  expect(() => state.retry()).not.toThrow()
})

test('Failed.Error renders nothing while the boundary is healthy, and the error UI once it fails', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <Failed.Error>
              {(error) => <p data-testid="error-ui">{(error as Error).message}</p>}
            </Failed.Error>
            <span>{() => use(c)}</span>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  expect(target.querySelector('[data-testid="error-ui"]')).toBeNull()

  await tick()
  flush()

  expect(target.querySelector('[data-testid="error-ui"]')?.textContent).toBe('boom')
})

test('Failed.Error disposes what its render prop constructed when the failure clears', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [id, setId] = signal(1)
  const c = computed(() =>
    id() === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
  )
  let disposals = 0

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <Failed.Error>
              {() => {
                onCleanup(() => {
                  disposals++
                })
                return <p data-testid="error-ui">failed</p>
              }}
            </Failed.Error>
            <span>{() => use(c)}</span>
          </div>
        )}
      </Failed>
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

  // The failure cleared — Failed.Error's own content must be GONE, and its
  // onCleanup must actually have fired, not just have been hidden while
  // still alive underneath.
  expect(target.querySelector('[data-testid="error-ui"]')).toBeNull()
  expect(disposals).toBe(1)
})

test('Failed.Error\'s retry() clears the failure, the same as useFailed().retry()', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let attempt = 0
  const c = computed(() => {
    attempt++
    return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
  })

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <Failed.Error>
              {(_error, retry) => (
                <button data-testid="retry" on:click={retry}>
                  retry
                </button>
              )}
            </Failed.Error>
            <span>{() => use(c)}</span>
          </div>
        )}
      </Failed>
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
