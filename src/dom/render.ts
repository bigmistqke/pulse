import { insertChild } from './bindings'
import { createRoot, onCleanup } from '../owner'

/**
 * Mount the result of `component()` into `target` and return a `dispose`
 * function. Disposing tears down all reactive nodes created during
 * `component()` (binding-effects, computeds, sub-owners from `catchError`)
 * and removes any DOM nodes inserted into `target` by this render.
 *
 * The return value of `component()` may be anything `insertChild` accepts:
 *   - a `Node` or `Node[]` (mounted directly)
 *   - a primitive string/number (rendered as text)
 *   - a function (treated reactively — same rule as for JSX children:
 *     "function = reactive")
 *
 * Existing children of `target` are left untouched; only what this `render`
 * inserts is removed on dispose.
 */
export function render(
  component: () => unknown,
  target: Element,
): () => void {
  return createRoot((dispose) => {
    // Snapshot the children present BEFORE we insert. On dispose we remove
    // everything else — covers marker comments, text nodes, and any DOM
    // produced by reactive function-child bindings.
    const preExisting = new Set<ChildNode>(Array.from(target.childNodes))
    try {
      insertChild(target, component())
      onCleanup(() => {
        for (const n of Array.from(target.childNodes)) {
          if (!preExisting.has(n)) target.removeChild(n)
        }
      })
      return dispose
    } catch (e) {
      dispose()
      throw e
    }
  })
}
