import { Fragment as FragmentSymbol, h, type Child, type Tag } from './h'
export { mergeProps } from './merge-props'

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

function readChildren(props: Record<string, unknown>): { rest: Record<string, unknown>; children: unknown } {
  // Never uses `const {children, ...rest} = props` - object rest-destructure
  // (like spread) reads every property through its getter once and copies
  // the resulting VALUE as a plain property, permanently flattening any
  // getter the props-to-getters compiler put there (see babel-plugin.ts and
  // merge-props.ts). Copying DESCRIPTORS instead preserves getter-ness for
  // every property except `children`, which this deliberately extracts.
  const descriptors = Object.getOwnPropertyDescriptors(props)
  const childrenDescriptor = descriptors.children
  delete descriptors.children
  const rest: Record<string, unknown> = {}
  Object.defineProperties(rest, descriptors)
  if (childrenDescriptor === undefined) return { rest, children: undefined }
  const children = 'value' in childrenDescriptor ? childrenDescriptor.value : childrenDescriptor.get?.call(props)
  return { rest, children }
}

function jsxImpl(tag: Tag, props: Record<string, unknown> | null): Node | Node[] | (() => unknown) {
  if (!props) return h(tag, null)
  if (typeof tag !== 'string' && tag !== FragmentSymbol) {
    // Component: forward props unmodified, including its own `children`
    // property (getter or not) - the component decides how and when to
    // read it (e.g. Loading reads it once inside its boundary owner).
    return h(tag, props)
  }
  // DOM tag or Fragment: `children` is consumed positionally by
  // insertChild, not by property access, so it's handed to h() as separate
  // argument(s) rather than left on the props object. The compiler never
  // converts a DOM/Fragment `children` key into a getter for exactly this
  // reason (a getter with nothing left to read it would be inert) - it
  // stays a plain value or an already-reactive thunk either way.
  const { rest, children } = readChildren(props)
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
