import type { PluginObj } from '@babel/core'
import * as t from '@babel/types'

function isExcludedAttributeName(name: t.JSXIdentifier | t.JSXNamespacedName): boolean {
  if (t.isJSXNamespacedName(name)) return name.namespace.name === 'on'
  return name.name === 'ref'
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

export default function pulsePropsToGetters(): PluginObj {
  return {
    name: 'pulse-props-to-getters',
    visitor: {
      JSXExpressionContainer(path) {
        const expr = path.node.expression
        if (t.isJSXEmptyExpression(expr)) return
        const parent = path.parent
        if (t.isJSXAttribute(parent) && isExcludedAttributeName(parent.name)) return
        if (isStaticOrFunction(expr)) return
        path.node.expression = t.arrowFunctionExpression([], expr)
      },
    },
  }
}
