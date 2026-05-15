import { bindProp, insertChild } from './bindings'

export type Component<P = Record<string, unknown>> = (props: P) => Node | Node[]
export type Tag = string | Component | symbol

export const Fragment: unique symbol = Symbol('Fragment')

/**
 * Create a DOM node tree. `tag` is a string (HTML element name) for now; the
 * function-tag (component) and Fragment-tag paths are added in Task 11.
 *
 * `props` keys are dispatched by prefix (Tasks 6–10); in this task only bare
 * names work and they all go through `setAttribute`.
 */
export function h(tag: Tag, props: Record<string, unknown> | null, ...children: unknown[]): Node | Node[] {
  if (typeof tag !== 'string') {
    throw new Error('h: non-string tags (components, Fragment) are not supported yet')
  }
  const el = document.createElement(tag)
  if (props) {
    for (const key of Object.keys(props)) {
      bindProp(el, key, props[key])
    }
  }
  for (const child of children) {
    insertChild(el, child)
  }
  return el
}
