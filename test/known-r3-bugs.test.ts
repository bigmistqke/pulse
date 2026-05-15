/**
 * Tests that document known bugs in r3, surfaced from pulse's perspective.
 *
 * Each test here uses vitest's `test.fails` — vitest expects the test body to
 * fail, so the test "passes" when the documented bug is still present. When r3
 * is fixed, the bug-demonstrating test body will start passing → vitest will
 * report this test as failing → at that point promote it to a regular `test(…)`
 * (and delete the `.fails` modifier).
 *
 * Catalogue these alongside an entry in `docs/follow-ups.md` so the trail from
 * "this test failed because vitest expected it to fail" → "the bug is fixed,
 * here is the spec to promote" is easy to follow.
 */

import { expect, test } from 'vitest'
import { computed, setSignal, signal } from '../src/index'

/**
 * r3 phantom re-trigger after a partial-throw run.
 *
 * Background: `recompute` resets `el.depsTail = null` at the start of each run,
 * then `link()` appends to deps as the body reads signals. Post-run cleanup
 * (`unlinkSubs` against `depsTail.nextDep`) unlinks deps that were not re-read.
 *
 * With Plan 2c's `try/finally`, `context` and `flags` are restored on throw —
 * but the post-`try` cleanup is still skipped. So a body that reads `a` then
 * throws (before reading `b`) leaves `b` linked from the previous successful
 * run. A subsequent `setSignal(b, …)` re-triggers the computed even though the
 * body no longer reads `b`.
 *
 * After the r3 fix, this test will pass (runs stays at 2), which makes
 * `test.fails` fail — promote to `test(…)` then.
 *
 * Tracked: `docs/follow-ups.md` (r3-side findings → "dep-list partially stale
 * after a throw in `recompute`").
 */
test.fails('r3 phantom re-trigger: throwing body retains deps it did not re-read', () => {
  const a = signal(0)
  const b = signal(0)
  let throwOnNext = false
  let runs = 0

  const c = computed(() => {
    runs++
    const av = a()
    if (throwOnNext) throw new Error('mid-run throw')
    const bv = b()
    return av + bv
  })

  // Initial: clean run, reads both `a` and `b`. `c` is subscribed to both.
  expect(c()).toBe(0)
  expect(runs).toBe(1)

  // Force a throwing run: body throws between read(a) and read(b).
  throwOnNext = true
  setSignal(a, 1)
  expect(() => c()).toThrow('mid-run throw')
  expect(runs).toBe(2)

  // Change `b`. With correct dep cleanup, `b` is no longer a dep of `c`
  // (the throwing run never re-read it), so `c` should NOT be re-triggered.
  // With current r3, `b` stays linked → setSignal(b) marks `c` dirty →
  // a subsequent `c()` re-runs the body → `runs` becomes 3.
  throwOnNext = false
  setSignal(b, 1)
  c()
  expect(runs).toBe(2) // BUG: actually becomes 3 today.
})
