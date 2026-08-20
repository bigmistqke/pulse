import type { NodePath, PluginObject } from '@babel/core'
import { addNamed } from '@babel/helper-module-imports'
import * as t from '@babel/types'

// @babel/plugin-transform-react-jsx injects its import at Program exit -
// after this plugin's CallExpression visitor has already run in the same
// pass - so a scope/binding lookup can't see it yet. The automatic runtime
// always names its locals _jsx/_jsxs/_jsxDEV and _Fragment (with a numeric
// suffix only on a genuine collision), so match those shapes directly
// instead of resolving imports.
const JSX_RUNTIME_CALLEE = /^_jsx(s|DEV)?\d*$/
const FRAGMENT_TAG = /^_Fragment\d*$/

function isExcludedKeyName(key: t.ObjectProperty['key']): boolean {
  const name = t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : null
  if (name === null) return false
  // ref and on: need the raw callback, invoked directly (once, with the
  // element or the event) - never through a getter's re-evaluation.
  // attr: is NOT excluded: bindProp always effect-wraps it, same as every
  // other binding kind (bare/prop:/class:/style:), so a dynamic attr:
  // value needs the same getter-conversion to stay live.
  return name === 'ref' || name.startsWith('on:')
}

function keyName(key: t.ObjectProperty['key']): string | null {
  return t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : null
}

function isStaticOrFunction(expr: t.Expression): boolean {
  return (
    t.isStringLiteral(expr) ||
    t.isNumericLiteral(expr) ||
    t.isBooleanLiteral(expr) ||
    t.isNullLiteral(expr) ||
    t.isArrowFunctionExpression(expr) ||
    t.isFunctionExpression(expr)
  )
}

function thunk(expr: t.Expression): t.ArrowFunctionExpression {
  return t.arrowFunctionExpression([], expr)
}

/** Is this expression itself another compiled JSX element/fragment
 *  (`_jsx(...)`/`_jsxs(...)`/`_jsxDEV(...)`)? A nested JSX element written
 *  as a bare child (`<div><span>a</span></div>`, no braces) is already-
 *  constructed, eagerly-evaluated content - exactly like a literal - and
 *  must never be thunk-wrapped just because it happens to be a
 *  CallExpression. Any genuine reactivity inside it is handled
 *  independently, by this same visitor matching that nested call's own
 *  props. Without this check, EVERY nested element in EVERY DOM/Fragment
 *  child position would get wrapped, changing DOM structure (an extra
 *  reactive binding, with its own marker comments) for what was always
 *  static content. */
function isJsxRuntimeCall(expr: t.Expression): boolean {
  return t.isCallExpression(expr) && t.isIdentifier(expr.callee) && JSX_RUNTIME_CALLEE.test(expr.callee.name)
}

/** Is the tag argument of a jsx()/jsxs() call a DOM tag or Fragment (as
 *  opposed to a component)? Determines how `children` is represented -
 *  see the module doc comment. */
function isDomOrFragmentTag(tagArg: t.Node): boolean {
  if (t.isStringLiteral(tagArg)) return true
  return t.isIdentifier(tagArg) && FRAGMENT_TAG.test(tagArg.name)
}

/**
 * `children` on a DOM tag (or Fragment) is consumed positionally by
 * `insertChild` - it receives a value directly, not by reading a property -
 * so it must stay a thunk (`insertChild` already treats a function value as
 * reactive, wrapping it in its own effect), never a getter, which nothing
 * would ever read. A multi-child array needs each dynamic element wrapped
 * INDIVIDUALLY, matching insertChild's own per-item iteration: wrapping the
 * whole array in one thunk would make every sibling re-render together
 * instead of independently.
 */
function toDomChildValue(value: t.Expression): t.Expression {
  if (t.isArrayExpression(value)) {
    return t.arrayExpression(
      value.elements.map((el) => {
        if (el === null || t.isSpreadElement(el)) return el
        return isStaticOrFunction(el) || isJsxRuntimeCall(el) ? el : thunk(el)
      }),
    )
  }
  return isStaticOrFunction(value) || isJsxRuntimeCall(value) ? value : thunk(value)
}

/** `key: value` -> `get key() { return value }`, unless value is excluded by
 *  key name or is already static/a function - those pass through unchanged.
 *  For a DOM/Fragment tag's `children` key specifically, thunk-wraps instead
 *  (see toDomChildValue) - a getter would be inert there. */
function toEligibleProperty(
  prop: t.ObjectProperty,
  isDomOrFragment: boolean,
): t.ObjectProperty | t.ObjectMethod {
  if (t.isPrivateName(prop.key)) return prop
  if (isExcludedKeyName(prop.key)) return prop
  const value = prop.value
  if (!t.isExpression(value)) return prop
  if (isDomOrFragment && keyName(prop.key) === 'children') {
    return t.objectProperty(prop.key, toDomChildValue(value), prop.computed)
  }
  if (isStaticOrFunction(value)) return prop
  return t.objectMethod('get', prop.key, [], t.blockStatement([t.returnStatement(value)]), prop.computed)
}

/** No SpreadElement present: convert eligible properties in place, on the
 *  same ObjectExpression react-jsx already built. */
function rewriteWithoutSpread(objectExpr: t.ObjectExpression, isDomOrFragment: boolean): void {
  for (let i = 0; i < objectExpr.properties.length; i++) {
    const prop = objectExpr.properties[i]
    if (!t.isObjectProperty(prop)) continue
    objectExpr.properties[i] = toEligibleProperty(prop, isDomOrFragment)
  }
}

/** SpreadElement(s) present: native object spread (what Babel 8 always uses
 *  for JSX spread attributes) reads through a getter once and copies the
 *  resulting value as a plain property - permanently flattening it. A spread
 *  source may itself be a getter-bearing props object (`<Comp {...props}/>`
 *  forwarding a parent's live props), so this can't use native spread at
 *  all. Instead: group the consecutive non-spread properties between each
 *  spread into their own object-literal segment (still converted the same
 *  way), and replace the whole ObjectExpression with a call to
 *  mergeProps(segment, spreadArg, segment, spreadArg, ...) - mergeProps
 *  copies property DESCRIPTORS, which preserves getter-ness through the
 *  merge. */
function rewriteWithSpread(
  path: NodePath<t.CallExpression>,
  objectExpr: t.ObjectExpression,
  isDomOrFragment: boolean,
  getMergePropsRef: () => t.Identifier,
): void {
  const segments: t.Expression[] = []
  let currentGroup: (t.ObjectProperty | t.ObjectMethod)[] = []
  const flushGroup = () => {
    if (currentGroup.length > 0) {
      segments.push(t.objectExpression(currentGroup))
      currentGroup = []
    }
  }
  for (const prop of objectExpr.properties) {
    if (t.isSpreadElement(prop)) {
      flushGroup()
      segments.push(prop.argument)
    } else if (t.isObjectProperty(prop)) {
      currentGroup.push(toEligibleProperty(prop, isDomOrFragment))
    } else {
      currentGroup.push(prop)
    }
  }
  flushGroup()
  path.node.arguments[1] = t.callExpression(getMergePropsRef(), segments)
}

export default function pulsePropsToGetters(): PluginObject {
  let mergePropsRef: t.Identifier | null = null
  return {
    name: 'pulse-props-to-getters',
    visitor: {
      Program() {
        // Reset per file - a fresh plugin instance is shared across every
        // file transformed in one process/watch session.
        mergePropsRef = null
      },
      CallExpression(path) {
        const callee = path.node.callee
        if (!t.isIdentifier(callee) || !JSX_RUNTIME_CALLEE.test(callee.name)) return
        const tagArg = path.node.arguments[0]
        const propsArg = path.node.arguments[1]
        if (!t.isObjectExpression(propsArg)) return
        const isDomOrFragment = isDomOrFragmentTag(tagArg)
        const hasSpread = propsArg.properties.some((prop) => t.isSpreadElement(prop))
        if (hasSpread) {
          rewriteWithSpread(path, propsArg, isDomOrFragment, () => {
            if (mergePropsRef === null) {
              mergePropsRef = addNamed(path, 'mergeProps', 'pulse/jsx-runtime', { importedType: 'es6' })
              return mergePropsRef
            }
            return t.cloneNode(mergePropsRef, true)
          })
        } else {
          rewriteWithoutSpread(propsArg, isDomOrFragment)
        }
      },
    },
  }
}
