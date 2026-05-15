/**
 * Insert `value` as a child (or children) of `parent`. Handles the static
 * shapes only in this task: string, number, null/undefined/boolean (skipped),
 * DOM Node. Arrays and reactive (function) values come in later tasks.
 */
export function insertChild(parent: Node, value: unknown): void {
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

/**
 * Apply one prop entry to `el`. In this task: only the default (bare-name)
 * path — `setAttribute(name, String(value))`, with null/undefined/false
 * meaning "no attribute set." Prefixes (`on:`, `prop:`, `attr:`,
 * `class:`, `style:`) and reactive function values are added in later tasks.
 */
export function bindProp(el: Element, name: string, value: unknown): void {
  if (value === null || value === undefined || value === false) return
  el.setAttribute(name, String(value))
}
