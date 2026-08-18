import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  action,
  catchError,
  committed,
  computed,
  effect,
  Failed,
  flush,
  Loading,
  microtaskScheduler,
  read,
  render,
  setScheduler,
  signal,
  syncScheduler,
  use,
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

  expect(target.querySelector('[data-testid="retry"]')).toBeNull()
  expect(committed(name)).toBe('bob')
  expect(attempt).toBe(2)
})
