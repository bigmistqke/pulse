import type { PluginObj } from '@babel/core'
import * as t from '@babel/types'

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
        if (isStaticOrFunction(expr)) return
        path.node.expression = t.arrowFunctionExpression([], expr)
      },
    },
  }
}
