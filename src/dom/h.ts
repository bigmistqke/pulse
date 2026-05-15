import { bindProp, insertChild } from './bindings'

export type Component<P = any> = (props: P) => Node | Node[] | (() => unknown)
export type Tag = string | ((props: any) => Node | Node[] | (() => unknown)) | symbol

export const Fragment: unique symbol = Symbol('Fragment')

/**
 * Create a DOM node tree. `tag` is a string (HTML element name) for now; the
 * function-tag (component) and Fragment-tag paths are added in Task 11.
 *
 * `props` keys are dispatched by prefix (Tasks 6–10); in this task only bare
 * names work and they all go through `setAttribute`.
 */
export function h(tag: Tag, props: Record<string, unknown> | null, ...children: unknown[]): Node | Node[] | (() => unknown) {
  if (tag === Fragment) {
    return children as Node[]
  }
  if (typeof tag === 'function') {
    const merged: Record<string, unknown> = props ? { ...props } : {}
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return tag(merged)
  }
  if (typeof tag !== 'string') {
    throw new Error(`h: unsupported tag: ${String(tag)}`)
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
