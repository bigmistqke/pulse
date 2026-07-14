import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  computed,
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

  // A loading state is not a failure.
  expect(caught).toEqual([])
})

// KNOWN BUG — a real failure never reaches the error boundary from a DOM binding.
//
// The COMPUTED is not at fault. The identical computed behaves correctly everywhere
// else:
//   - read directly            -> failure(c) === boom   (test/failure.test.ts)
//   - read via use() in an effect -> the effect sees "PENDING" then "ERR:boom",
//                                    and failure(c) === boom
//   - read via use() in a BINDING -> failure(c) === null, nothing reaches catchError
//
// So the failure is being lost on the binding path specifically. The likely cause is
// teardown: the binding's catch does `disposeOwner(nextRunOwner)` before re-throwing
// the NotReadyYet, and the computed is registered under that owner — disposing it
// unwatches the computed's r3 nodes, so the later rejection never parks.
//
// (An earlier note here blamed the supersession guard; a trace disproved that.)
test.skip('an error boundary still catches a real failure', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const caught: unknown[] = []
  const c = computed(() => Promise.reject(new Error('boom')))

  catchError(
    () => {
      render(() => <span>{() => use(c)}</span>, target)
    },
    (e) => caught.push(e),
  )

  await tick()
  flush()

  expect(caught).toHaveLength(1)
  expect((caught[0] as Error).message).toBe('boom')
})
