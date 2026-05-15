import { Fragment as FragmentSymbol, h, type Child, type Tag } from './h'

export const Fragment = FragmentSymbol

/**
 * Called by the TS transform for an element with zero or one child.
 * Children, when present, arrive on `props.children`.
 */
export function jsx(tag: Tag, props: Record<string, unknown> | null): Node | Node[] | (() => unknown) {
  return jsxImpl(tag, props)
}

/**
 * Called by the TS transform for an element with multiple static children.
 * `props.children` is already an array.
 */
export function jsxs(tag: Tag, props: Record<string, unknown> | null): Node | Node[] | (() => unknown) {
  return jsxImpl(tag, props)
}

function jsxImpl(tag: Tag, props: Record<string, unknown> | null): Node | Node[] | (() => unknown) {
  if (!props) return h(tag, null)
  const { children, ...rest } = props
  if (children === undefined) return h(tag, rest)
  if (Array.isArray(children)) return h(tag, rest, ...children)
  return h(tag, rest, children)
}

/**
 * Called by Vite's dev-mode JSX transform (jsxDEV includes source-location info
 * but we simply forward to the production implementation).
 */
export function jsxDEV(
  tag: Tag,
  props: Record<string, unknown> | null,
  _key: unknown,
  _isStaticChildren: boolean,
): Node | Node[] | (() => unknown) {
  return jsxImpl(tag, props)
}

// Minimal JSX namespace — just enough for Plan 3a tests to typecheck.
// A broader IntrinsicElements / event-attribute typing surface is a
// follow-up (see docs/follow-ups.md).
export namespace JSX {
  export interface IntrinsicElements {
    [tag: string]: Record<string, unknown>
  }
  export type Element = Child
  export interface ElementChildrenAttribute { children: {} }
}
