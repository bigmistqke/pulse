import { createRoot, onCleanup } from '../owner'

/**
 * Mount the result of `component()` into `target` and return a `dispose`
 * function. Disposing tears down all reactive nodes created during
 * `component()` (binding-effects, computeds, sub-owners from `catchError`)
 * and removes the mounted DOM nodes.
 */
export function render(
  component: () => Node | Node[],
  target: Element,
): () => void {
  return createRoot((dispose) => {
    const result = component()
    const nodes = Array.isArray(result) ? result : [result]
    for (const n of nodes) target.appendChild(n)
    onCleanup(() => {
      for (const n of nodes) {
        if (n.parentNode === target) target.removeChild(n)
      }
    })
    return dispose
  })
}
