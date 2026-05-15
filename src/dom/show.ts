import { untrack } from 'r3'
import { isPromise } from '../is-promise'
import {
  createSubOwner,
  disposeOwner,
  getOwner,
  runWithOwner,
  type Owner,
} from '../owner'

/** Type-level narrowing for `Show`'s function-child: the value passed in
 *  is the input minus its falsy components (including pending Promises,
 *  which Show treats as falsy). */
export type Truthy<T> = Exclude<T, false | null | undefined | 0 | '' | Promise<unknown>>

export interface ShowProps<T> {
  when: T | (() => T)
  fallback?: Node | Node[] | (() => unknown)
  children: Node | Node[] | (() => unknown) | ((value: Truthy<T>) => Node | Node[] | (() => unknown))
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
 */
export function Show<T>(props: ShowProps<T>): () => unknown {
  const parentOwner = getOwner()
  let lastBranch: 'truthy' | 'falsy' | null = null
  let cachedNode: Node | Node[] | (() => unknown) | undefined
  let branchOwner: Owner | null = null

  return () => {
    const raw = typeof props.when === 'function'
      ? (props.when as () => T)()
      : props.when
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
        return typeof props.children === 'function'
          ? (props.children as (v: Truthy<T>) => Node | Node[] | (() => unknown))(raw as Truthy<T>)
          : props.children
      }
      return props.fallback
    }))
    lastBranch = branch
    return cachedNode
  }
}
