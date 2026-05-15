import { effect } from '../effect'
import { createSubOwner, disposeOwner, getOwner, onCleanup, runWithOwner, type Owner } from '../owner'

/**
 * Warn (once per occurrence) when a reactive binding or event listener is
 * created without an ambient owner. The framework remains permissive — the
 * binding still works — but it will never be cleaned up, so we surface the
 * leak loudly. Wrap in `render()` or `createRoot()` to silence.
 */
function warnIfOrphaned(kind: string): void {
  if (getOwner() === null) {
    console.warn(
      `pulse: ${kind} created outside any owner — it will live forever. ` +
      `Wrap in render() or createRoot().`,
    )
  }
}

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
    // Capture the owner at h()-call time. The binding-effect lives until this
    // owner is disposed. Each run of the effect gets its own sub-owner so any
    // nested effects/computeds created by the user function are cleaned up
    // before the next run — no leak across re-runs.
    warnIfOrphaned('reactive child')
    const parentOwner = getOwner()
    const start = document.createComment('')
    const end = document.createComment('')
    parent.appendChild(start)
    parent.appendChild(end)
    let runOwner: Owner | null = null
    effect(() => {
      // Dispose the previous run's owner first — this tears down any
      // nested binding-effects from the prior run.
      if (runOwner !== null) disposeOwner(runOwner)
      runOwner = createSubOwner(parentOwner)
      runWithOwner(runOwner, () => {
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
  // ref — callback invoked once with the element; not reactive
  if (name === 'ref') {
    if (typeof value === 'function') (value as (el: Element) => void)(el)
    return
  }
  // on:event — direct addEventListener; the handler is not reactive
  if (name.startsWith('on:')) {
    const event = name.slice(3)
    if (typeof value !== 'function') return
    warnIfOrphaned('event listener')
    const handler = value as EventListener
    el.addEventListener(event, handler)
    onCleanup(() => el.removeEventListener(event, handler))
    return
  }
  // prop:name — DOM property assignment; function value is reactive
  if (name.startsWith('prop:')) {
    const prop = name.slice(5)
    if (typeof value === 'function') {
      warnIfOrphaned('prop binding')
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
      warnIfOrphaned('attr binding')
      effect(() => applyAttr(el, attr, (value as () => unknown)()))
    } else {
      applyAttr(el, attr, value)
    }
    return
  }
  // class:name — toggle a single class; function value is reactive
  if (name.startsWith('class:')) {
    const cls = name.slice(6)
    if (typeof value === 'function') {
      warnIfOrphaned('class binding')
      effect(() => el.classList.toggle(cls, !!(value as () => unknown)()))
    } else {
      el.classList.toggle(cls, !!value)
    }
    return
  }
  // style:name — set/remove a single style property; function value is reactive
  if (name.startsWith('style:')) {
    const prop = name.slice(6)
    const apply = (v: unknown) => {
      if (v === null || v === undefined || v === false) {
        ;(el as HTMLElement).style.removeProperty(prop)
      } else {
        ;(el as HTMLElement).style.setProperty(prop, String(v))
      }
    }
    if (typeof value === 'function') {
      warnIfOrphaned('style binding')
      effect(() => apply((value as () => unknown)()))
    } else {
      apply(value)
    }
    return
  }
  // default — same as attr:, with bare name
  if (typeof value === 'function') {
    warnIfOrphaned('attr binding')
    effect(() => applyAttr(el, name, (value as () => unknown)()))
  } else {
    applyAttr(el, name, value)
  }
}
