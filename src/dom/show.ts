import { untrack } from 'r3'
import { isPromise } from '../is-promise'
import {
  createSubOwner,
  disposeOwner,
  getOwner,
  runWithOwner,
  type Owner,
} from '../owner'
import type { Child } from './h'
import { readDynamic } from './resolve'

/** Type-level narrowing for `Show`'s function-child: the value passed in
 *  is the input minus its falsy components (including pending Promises,
 *  which Show treats as falsy). */
export type Truthy<T> = Exclude<T, false | null | undefined | 0 | '' | Promise<unknown>>

export interface ShowProps<T> {
  when: T | (() => T)
  fallback?: Child
  children: Child | ((value: Truthy<T>) => Child)
}

/**
 * Conditional render. When `when` evaluates truthy (and is not a pending
 * promise), the children are rendered; otherwise `fallback`. The function-
 * child form receives the narrowed truthy value.
 *
 * Branch caching: same-truthy or same-falsy re-runs preserve the rendered
 * subtree (children function is NOT re-called when the value updates but
 * the branch stays). Truthy↔falsy transitions dispose the old branch's
 * sub-owner and mount the new under a fresh one.
 *
 * Note: the function-child form is called ONCE per truthy transition, not on
 * each truthy value update. `<Show when={user}>{u => <span>{u.name}</span>}</Show>`
 * captures `u` at transition time; if `user.name` changes (same object, mutated),
 * the rendered DOM doesn't update unless the children body has its own reactive
 * read (e.g. `<span>{() => user().name}</span>`).
 */
export function Show<T>(props: ShowProps<T>): () => unknown {
  const parentOwner = getOwner()
  let lastBranch: 'truthy' | 'falsy' | null = null
  let cachedNode: Child | undefined
  let branchOwner: Owner | null = null

  return () => {
    const raw = readDynamic(props, 'when') as T
    const isTruthy = !!raw && !isPromise(raw)
    const branch = isTruthy ? 'truthy' : 'falsy'

    if (branch === lastBranch) return cachedNode

    if (branchOwner !== null) disposeOwner(branchOwner)
    branchOwner = createSubOwner(parentOwner)
    // untrack: the children/fallback construction may call onCleanup or
    // create effects. Without untrack, those would route to the calling
    // binding-effect's r3 per-run cleanup instead of the branch sub-owner,
    // disposing them on the very next re-run. Same pattern as mapArray.
    cachedNode = untrack(() => runWithOwner(branchOwner!, () => {
      if (isTruthy) {
        // readDynamic distinguishes a getter (already resolved - even to
        // another component's live accessor, e.g. a nested <Show>, which
        // must be left as a function for insertChild to wrap in its own
        // effect) from a genuine hand-written render-prop function (which
        // needs calling, with the narrowed value).
        return readDynamic(props, 'children', raw as Truthy<T>) as Child
      }
      // Read directly: this closure re-runs on every reactive pass (via
      // insertChild's effect), so a getter-backed fallback is already
      // live here.
      return props.fallback
    }))
    lastBranch = branch
    return cachedNode
  }
}
