import { bindProp, insertChild, tagChildOwner } from './bindings'
import { mergeProps } from './merge-props'
import { getOwner, type Owner } from '../owner'
import { NotReadyYet } from '../async'

/**
 * Anything `insertChild` will render: a Node, a primitive, null/undefined/
 * boolean (rendered as nothing), a function (reactive — wrapped in a
 * binding-effect), or an array of any of these (recursively flattened).
 *
 * This is the "lingua franca" of pulse's child slots. JSX.Element is
 * an alias for `Child`.
 */
export type Child =
  | Node
  | string
  | number
  | boolean
  | null
  | undefined
  | (() => unknown)
  | Child[]

export type Component<P = any> = (props: P) => Node | Node[] | (() => unknown)
export type Tag = string | ((props: any) => Node | Node[] | (() => unknown)) | symbol

export const Fragment: unique symbol = Symbol('Fragment')

/** Recurses into nested arrays (a single Fragment child can itself be an
 *  array, e.g. from `.map()`) tagging every function it finds. */
function tagOwners(children: unknown[], owner: Owner | null): void {
  for (const child of children) {
    if (typeof child === 'function') tagChildOwner(child as () => unknown, owner)
    else if (Array.isArray(child)) tagOwners(child, owner)
  }
}

/**
 * Create a DOM node tree. `tag` is a string (HTML element name), a
 * component function, or `Fragment`.
 *
 * `props` keys are dispatched by prefix; a getter-backed prop (from the
 * props-to-getters compiler, or from a caller like `mergeProps`) is read
 * live wherever it's consumed - `bindProp` for DOM tags, or directly by a
 * component's own code - never flattened into a one-time snapshot here.
 */
export function h(tag: Tag, props: Record<string, unknown> | null, ...children: unknown[]): Node | Node[] | (() => unknown) {
  if (tag === Fragment) {
    // The raw values pass straight through - a function child is only
    // wrapped by insertChild's own binding-effect later, at whichever
    // unrelated call site ends up consuming this array (unlike the DOM-tag
    // branch below, which wraps its children immediately, itself). Tag each
    // function child with the owner ambient RIGHT NOW, at Fragment-
    // construction time, so that later wrapping - wherever it happens -
    // uses this owner instead of whatever's ambient at that unrelated call
    // site. Without this, a component sitting directly under a Fragment
    // with no static element between it and an enclosing boundary can't
    // reach the boundary's scope (`useLoading()`, `isErrored()`, ...) - see
    // tagChildOwner's own doc comment in bindings.ts.
    const owner = getOwner()
    tagOwners(children, owner)
    return children as Node[]
  }
  if (typeof tag === 'function') {
    if (children.length === 0) {
      return callComponent(tag, props ?? {})
    }
    // A manual (non-JSX-compiled) h() call passing children as trailing
    // args - merge them onto props as a plain value. mergeProps (not
    // spread) is still used here so any getter already on `props` survives
    // the merge instead of being flattened.
    const childrenValue = children.length === 1 ? children[0] : children
    const merged = props ? mergeProps(props, { children: childrenValue }) : { children: childrenValue }
    return callComponent(tag, merged)
  }
  if (typeof tag !== 'string') {
    throw new Error(`h: unsupported tag: ${String(tag)}`)
  }
  const el = document.createElement(tag)
  if (props) {
    for (const key of Object.keys(props)) {
      bindProp(el, key, props)
    }
  }
  for (const child of children) {
    insertChild(el, child)
  }
  return el
}

/** Component functions whose suspended body has been reported. */
const warnedComponents = new WeakSet<Function>()

/** Suspensions already reported, so a component they pass through is not named. */
const reportedSuspensions = new WeakSet<NotReadyYet>()

/**
 * Call a component. A body that suspends throws, and the hole the component
 * was built in runs it again from the top once the source settles, recreating
 * everything the body built. That cost is otherwise invisible, so the first
 * suspension of each component function is reported. Only the innermost body
 * is named: the same throw passing through an enclosing component's body was
 * not caused by that body.
 */
function callComponent<R>(tag: (props: any) => R, props: object): R {
  try {
    return tag(props)
  } catch (error) {
    if (error instanceof NotReadyYet && !reportedSuspensions.has(error)) {
      reportedSuspensions.add(error)
      if (!warnedComponents.has(tag)) {
        warnedComponents.add(tag)
        console.warn(
          `pulse: <${tag.name || 'anonymous'}> suspended in its body, so it runs again from the top ` +
            `when the source settles. Move the use() call into a hole the component returns.`,
        )
      }
    }
    throw error
  }
}
