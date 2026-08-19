import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  computed,
  error,
  flush,
  microtaskScheduler,
  render,
  setScheduler,
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
 * `use()` in a reactive child with NO <Loading> boundary above it.
 *
 * Rendering nothing for that binding while pending is correct — that is what
 * suspension means, and a fallback is what <Loading> is for. What must be true:
 *   1. only the suspended BINDING is empty; the rest of the tree still renders;
 *   2. a pending read is NOT an error, so it must not reach an error boundary;
 *   3. it RECOVERS — the content appears once the value settles.
 */

test('use() with no <Loading>: only the suspended binding is empty, and it recovers', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let release!: (v: string) => void
  const c = computed(() => new Promise<string>((r) => (release = r)))

  render(() => <div>before<span>{() => use(c)}</span>after</div>, target)

  // The suspended binding renders nothing — but the surrounding tree must survive.
  expect(target.innerHTML).toContain('before')
  expect(target.innerHTML).toContain('after')
  expect(target.innerHTML).not.toContain('VALUE')

  release('VALUE')
  await tick()
  flush()

  // MUST recover.
  expect(target.innerHTML).toContain('VALUE')
})

test('a pending use() is NOT reported to an error boundary', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const caught: unknown[] = []
  const c = computed(() => new Promise<string>(() => {})) // never settles

  catchError(
    () => {
      render(() => <span>{() => use(c)}</span>, target)
    },
    (e) => caught.push(e),
  )

  await tick()
  flush()

  // A loading state is not an error.
  expect(caught).toEqual([])
})

/**
 * An error boundary must be created INSIDE `render`, not around it.
 *
 * `render` calls `createRoot`, which is always a root: its owner has no parent.
 * So a `catchError` wrapped AROUND `render` is never an ancestor of the bindings
 * inside it, and `routeError`'s walk up the owner chain cannot reach the handler.
 * The boundary belongs in the tree it is guarding.
 */
test('an error boundary inside render catches a real error', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const caught: unknown[] = []
  const c = computed(() => Promise.reject(new Error('boom')))

  render(
    () => catchError(() => <span>{() => use(c)}</span>, (e) => caught.push(e)) as Node,
    target,
  )

  await tick()
  flush()

  expect(caught.length).toBeGreaterThan(0)
  expect((caught[0] as Error).message).toBe('boom')
})

/**
 * A node's own bookkeeping must not depend on whether a CONSUMER happened to have
 * an error boundary.
 *
 * When the promise rejects, the computed's settle handler clears `pending`, and
 * under the sync scheduler that write re-runs the consuming binding immediately —
 * still inside the settle handler's stack. The binding re-reads, throws, and with
 * no boundary above it `routeError` re-throws. That throw used to unwind the settle
 * handler itself, skipping the `setErrorSig` line below it: the computed silently
 * lost its error (`error(c) === null`) and the rejection surfaced as an
 * unhandled rejection.
 *
 * The error is graph state. It parks whether or not anyone is listening.
 */
test('a rejected computed parks its error even when the consumer has no boundary', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const c = computed(() => Promise.reject(new Error('boom')))

  render(() => <span>{() => use(c)}</span>, target)

  await tick()
  flush()

  expect((error(c) as Error)?.message).toBe('boom')
})
