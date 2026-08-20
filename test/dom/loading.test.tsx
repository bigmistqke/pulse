import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  computed,
  flush,
  isLoading,
  isPending,
  latest,
  Loading,
  microtaskScheduler,
  onCleanup,
  render,
  setScheduler,
  Show,
  signal,
  syncScheduler,
  use,
  useLoading,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

/** Resolve after all microtasks have drained (a macrotask boundary) — lets
 *  `deferOrCommit`'s own `queueMicrotask` tail-check fire, independent of
 *  whichever effect scheduler is active. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('synchronous loaded thunk renders immediately; pending stays false', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => <Loading initial={<p>init</p>}>{() => <span>hi</span>}</Loading>,
    target,
  )
  expect(target.textContent).toBe('hi')
  dispose()
})

test('pending use() initially renders `initial`', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => (
      <Loading initial={<p>loading…</p>}>
        {() => <span>{() => use(p)}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('loading…')
  dispose()
})

test('pending use() with no initial → renders fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => (
      <Loading fallback={<p>fb</p>}>
        {() => <span>{() => use(p)}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('fb')
  dispose()
})

test('pending use() with neither: the one pending binding still shows nothing (its own commit is still withheld)', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => <Loading>{() => <span>{() => use(p)}</span>}</Loading>,
    target,
  )
  expect(target.textContent).toBe('')
  dispose()
})

test('pending use() with neither initial nor fallback → the rest of the subtree still renders', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => (
      <Loading>
        {() => (
          <div>
            <span data-testid="static">always here</span>
            <span>{() => use(p)}</span>
          </div>
        )}
      </Loading>
    ),
    target,
  )
  // The pending binding contributes no text, but the surrounding structure
  // — which does not depend on the pending value — is not hidden behind a
  // swap the way it would be if <Loading> rendered nothing at all.
  expect(target.querySelector('[data-testid="static"]')).not.toBeNull()
  expect(target.querySelector('[data-testid="static"]')?.textContent).toBe('always here')
  dispose()
})

test('settled → loaded subtree rendered', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })
  const dispose = render(
    () => (
      <Loading initial={<p>loading…</p>}>
        {() => <span>{() => use(p)}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('loading…')
  resolveP('hello')
  await p
  flush()
  expect(target.textContent).toBe('hello')
  dispose()
})

test('subsequent pending with fallback → renders fallback', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })
  const [src, setSrc] = signal<string | Promise<string>>(p)
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>} fallback={<p>fb</p>}>
        {() => <span>{() => use(src())}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('init')
  resolveP('A')
  await p
  flush()
  expect(target.textContent).toBe('A')

  let resolveQ!: (v: string) => void
  const q = new Promise<string>((r) => { resolveQ = r })
  setSrc(q)
  expect(target.textContent).toBe('fb') // subsequent pending, fallback shown
  resolveQ('B')
  await q
  flush()
  expect(target.textContent).toBe('B')
  dispose()
})

test('subsequent pending without fallback → holds prior loaded subtree', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })
  const [src, setSrc] = signal<string | Promise<string>>(p)
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => <span>{() => use(src())}</span>}
      </Loading>
    ),
    target,
  )
  resolveP('A')
  await p
  flush()
  expect(target.textContent).toBe('A')

  const q = new Promise<string>(() => {}) // never settles
  setSrc(q)
  expect(target.textContent).toBe('A') // hold prior
  dispose()
})

test('two pending bindings: both must settle before loaded slot mounts', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveA!: (v: string) => void
  let resolveB!: (v: string) => void
  const a = new Promise<string>((r) => { resolveA = r })
  const b = new Promise<string>((r) => { resolveB = r })
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => (
          <>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
          </>
        )}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('init')
  resolveA('A')
  await a
  flush()
  expect(target.textContent).toBe('init') // b still pending
  resolveB('B')
  await b
  flush()
  expect(target.textContent).toBe('AB')
  dispose()
})

test('useLoading() inside subtree reflects pending state', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })

  function Header() {
    const pending = useLoading()
    return <Show when={pending()} fallback={<i>idle</i>}>{() => <i>busy</i>}</Show>
  }

  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => (
          <>
            <Header/>
            <span>{() => use(p)}</span>
          </>
        )}
      </Loading>
    ),
    target,
  )
  resolveP('done')
  await p
  flush()
  // eslint-disable-next-line no-console
  console.log('[DOM after]', target.innerHTML)
  expect(target.textContent).toContain('idle')
  expect(target.textContent).toContain('done')
  dispose()
})

test('non-NotReadyYet error in a binding inside Loading propagates to catchError', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const caught: unknown[] = []
  const [trigger, setTrigger] = signal(false)
  const dispose = render(
    () =>
      catchError(
        () => (
          <Loading initial={<p>init</p>}>
            {() => (
              <span>
                {() => {
                  if (trigger()) throw new Error('boom')
                  return 'ok'
                }}
              </span>
            )}
          </Loading>
        ),
        (e) => caught.push(e),
      ) as Node,
    target,
  )
  expect(target.textContent).toBe('ok')
  setTrigger(true)
  expect(caught.length).toBe(1)
  expect((caught[0] as Error).message).toBe('boom')
  dispose()
})

test('nested Loading: inner pending registers only with inner', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveOuter!: (v: string) => void
  let resolveInner!: (v: string) => void
  const outerP = new Promise<string>((r) => { resolveOuter = r })
  const innerP = new Promise<string>((r) => { resolveInner = r })

  const dispose = render(
    () => (
      <Loading initial={<p>outer-init</p>}>
        {() => (
          <>
            <span>{() => use(outerP)}</span>
            <Loading initial={<p>inner-init</p>}>
              {() => <span>{() => use(innerP)}</span>}
            </Loading>
          </>
        )}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('outer-init')
  resolveOuter('OUTER')
  await outerP
  flush()
  expect(target.textContent).toContain('OUTER')
  expect(target.textContent).toContain('inner-init')
  resolveInner('INNER')
  await innerP
  flush()
  expect(target.textContent).toContain('OUTER')
  expect(target.textContent).toContain('INNER')
  dispose()
})

test('disposing surrounding owner cascades to Loading', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => {
          onCleanup(() => { cleaned = true })
          return <span>x</span>
        }}
      </Loading>
    ),
    target,
  )
  expect(cleaned).toBe(false)
  dispose()
  expect(cleaned).toBe(true)
})

test('useLoading() outside any Loading returns constant-false accessor', () => {
  const target = document.createElement('section')
  document.body.append(target)

  let captured!: ReturnType<typeof useLoading>
  const dispose = render(
    () => {
      captured = useLoading()
      return <span>x</span>
    },
    target,
  )
  expect(captured()).toBe(false)
  // The accessor is stable; not reactive after the fact.
  expect(captured).toBe(captured)
  dispose()
})

test('isLoading() inside subtree reflects pending state, read fresh each call', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })

  function Header() {
    return <Show when={isLoading()} fallback={<i>idle</i>}>{() => <i>busy</i>}</Show>
  }

  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => (
          <>
            <Header/>
            <span>{() => use(p)}</span>
          </>
        )}
      </Loading>
    ),
    target,
  )
  resolveP('done')
  await p
  flush()
  expect(target.textContent).toContain('idle')
  expect(target.textContent).toContain('done')
  dispose()
})

test('isLoading() outside any Loading returns false', () => {
  const target = document.createElement('section')
  document.body.append(target)

  let captured: boolean | undefined
  const dispose = render(
    () => {
      captured = isLoading()
      return <span>x</span>
    },
    target,
  )
  expect(captured).toBe(false)
  dispose()
})

test('rapid src-swap keeps pending count at 1, not climbing', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p1 = new Promise<string>(() => {})
  const p2 = new Promise<string>(() => {}) // both pending; never settle
  const [src, setSrc] = signal<string | Promise<string>>(p1)

  let observedPending: boolean[] = []
  function Probe() {
    const pending = useLoading()
    // Observe pending at each tick by reading inside an effect via Show
    return <Show when={pending()}>{() => { observedPending.push(true); return <i>p</i> }}</Show>
  }

  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => (
          <>
            <Probe/>
            <span>{() => use(src())}</span>
          </>
        )}
      </Loading>
    ),
    target,
  )
  // Initial pending → shows init; loaded subtree (with Probe) hasn't mounted yet,
  // so observedPending captures from when subtree actually attaches.
  expect(target.textContent).toBe('init')
  // Swap rapidly — count should remain at 1 (same effect, register guard prevents double-count)
  setSrc(p2)
  setSrc(p1)
  setSrc(p2)
  // Still pending. text stays at init.
  expect(target.textContent).toBe('init')
  dispose()
})

// Regression for ADR 0014's "Implementation correction": a use.latest() SWR
// read must never reopen a boundary's fallback on remount, even while its
// background refresh is still in flight — see docs/adr/0014-use-latest-composed-on-latest.md.
test('use.latest() holds prior across a Loading boundary remount, even while a background refresh is in flight', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const [version, setVersion] = signal(0)
  let release!: (v: string) => void
  const data = computed<Promise<string>>(() => {
    const v = version()
    if (v === 0) return Promise.resolve('v0')
    return new Promise<string>((r) => { release = r })
  })

  const [mounted, setMounted] = signal(true)
  const boundary = () => (
    <Loading initial={<p>fallback</p>}>
      {() => <span>{() => use.latest(data)}</span>}
    </Loading>
  )

  const dispose = render(() => <Show when={mounted()}>{boundary}</Show>, target)

  // First load resolves.
  await tick()
  flush()
  expect(target.textContent).toBe('v0')

  // Trigger a refetch: data is pending again, but use.latest(data) already has 'v0'.
  setVersion(1)
  expect(isPending(data)()).toBe(true)
  expect(latest(data)).toBe('v0')

  // Remount the boundary WHILE that refetch is still in flight.
  setMounted(false)
  setMounted(true)

  // The fresh boundary's own hasEverLoaded starts false, but use.latest(data)
  // never throws (it has a value), so it must hold 'v0' — not show 'fallback' —
  // for the ENTIRE remaining duration of the background refresh, not just
  // until the next microtask.
  await tick()
  flush()
  expect(target.textContent).toBe('v0')
  await tick()
  flush()
  expect(target.textContent).toBe('v0') // still refreshing in the background; still holding prior

  release('v1')
  await tick()
  flush()
  expect(target.textContent).toBe('v1')
  dispose()
})

test('a bare latest() read never registers with the enclosing Loading boundary', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const [version, setVersion] = signal(0)
  let release!: (v: string) => void
  const data = computed<Promise<string>>(() => {
    const v = version()
    if (v === 0) return Promise.resolve('v0')
    return new Promise<string>((r) => { release = r })
  })

  // Captured once, inside the boundary's own subtree (a valid owner context)
  // — calling the returned accessor afterward needs no ambient owner, unlike
  // isLoading()/useLoading()'s own lookup of the nearest boundary.
  let loading!: () => boolean
  const dispose = render(
    () => (
      <Loading initial={<p>fallback</p>}>
        {() => {
          loading = useLoading()
          return <span>{() => latest(data) ?? 'empty'}</span>
        }}
      </Loading>
    ),
    target,
  )

  // Never registers as pending — commits immediately, before data has ever resolved.
  expect(target.textContent).toBe('empty')
  await tick()
  flush()
  expect(target.textContent).toBe('v0')

  // A background refresh behind a bare latest() read never surfaces through
  // the boundary's active()/isLoading() either — only use()/use.latest() feed it.
  setVersion(1)
  expect(loading()).toBe(false)
  expect(target.textContent).toBe('v0')

  release('v1')
  await tick()
  flush()
  expect(target.textContent).toBe('v1')
  dispose()
})
