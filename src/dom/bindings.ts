import { effect } from '../effect'
import { onCleanup } from '../owner'

/**
 * Insert `value` as a child (or children) of `parent`.
 *
 * - string / number → text node
 * - null / undefined / boolean → nothing
 * - DOM Node → inserted as-is
 * - array → each item inserted recursively
 * - function → wrapped in a binding-effect: the function runs reactively;
 *   its result is inserted between two marker comments and replaced on
 *   re-run. `use(...)` inside the function suspends only this binding;
 *   throws route to the nearest `catchError`.
 */
export function insertChild(parent: Node, value: unknown): void {
  if (typeof value === 'function') {
    const start = document.createComment('')
    const end = document.createComment('')
    parent.appendChild(start)
    parent.appendChild(end)
    effect(() => {
      // Call the user function FIRST. If it throws (notably NotReadyYet
      // via `use(...)`), we leave the existing DOM untouched — stale-but-
      // stable. Only on a successful call do we clear and re-insert.
      const next = (value as () => unknown)()
      // Build the new content into a fragment before touching the DOM, so
      // a partial insertChild error can't leave a half-cleared region.
      const frag = document.createDocumentFragment()
      insertChild(frag, next)
      // Clear previously-inserted nodes between the markers, then insert.
      let cur = start.nextSibling
      while (cur !== null && cur !== end) {
        const after: ChildNode | null = cur.nextSibling
        cur.remove()
        cur = after
      }
      end.parentNode!.insertBefore(frag, end)
    })
    return
  }
  if (value === null || value === undefined || typeof value === 'boolean') return
  if (typeof value === 'string' || typeof value === 'number') {
    parent.appendChild(document.createTextNode(String(value)))
    return
  }
  if (value instanceof Node) {
    parent.appendChild(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) insertChild(parent, item)
    return
  }
  throw new Error(`insertChild: unsupported child value: ${typeof value}`)
}

function applyAttr(el: Element, name: string, value: unknown): void {
  if (value === null || value === undefined || value === false) {
    el.removeAttribute(name)
  } else {
    el.setAttribute(name, value === true ? '' : String(value))
  }
}

/**
 * Apply one prop entry to `el`. Handles `on:`, `prop:`, and `attr:` prefixes;
 * function values with `prop:` and `attr:` are reactive (wrapped in effect).
 * Default path also uses `setAttribute` with reactivity for function values.
 */
export function bindProp(el: Element, name: string, value: unknown): void {
  // on:event — direct addEventListener; the handler is not reactive
  if (name.startsWith('on:')) {
    const event = name.slice(3)
    if (typeof value !== 'function') return
    const handler = value as EventListener
    el.addEventListener(event, handler)
    onCleanup(() => el.removeEventListener(event, handler))
    return
  }
  // prop:name — DOM property assignment; function value is reactive
  if (name.startsWith('prop:')) {
    const prop = name.slice(5)
    if (typeof value === 'function') {
      effect(() => { (el as any)[prop] = (value as () => unknown)() })
    } else {
      ;(el as any)[prop] = value
    }
    return
  }
  // attr:name — explicit setAttribute; function value is reactive
  if (name.startsWith('attr:')) {
    const attr = name.slice(5)
    if (typeof value === 'function') {
      effect(() => applyAttr(el, attr, (value as () => unknown)()))
    } else {
      applyAttr(el, attr, value)
    }
    return
  }
  // default — same as attr:, with bare name
  if (typeof value === 'function') {
    effect(() => applyAttr(el, name, (value as () => unknown)()))
  } else {
    applyAttr(el, name, value)
  }
}
