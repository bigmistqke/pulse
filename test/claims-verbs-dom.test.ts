import { transformSync } from '@babel/core'
import { expect, test } from 'vitest'
import pulsePropsToGetters from '../src/babel-plugin'

function transform(source: string): string {
  const result = transformSync(source, {
    filename: 'test.tsx',
    presets: [['@babel/preset-typescript', {}]],
    plugins: [
      '@babel/plugin-syntax-jsx',
      pulsePropsToGetters,
      ['@babel/plugin-transform-react-jsx', { runtime: 'automatic', importSource: 'pulse', throwIfNamespace: false }],
    ],
    babelrc: false,
    configFile: false,
  })
  return result?.code ?? ''
}

/**
 * @canon rule-a-namespaced-prop-compiles-to-a-string-key
 */
test('a dynamic class: prop compiles to a getter under its plain string key', () => {
  const code = transform('<div class:active={isActive()} />;')
  expect(code).toMatch(/get\s+"class:active"\s*\(\)\s*\{\s*return isActive\(\);?\s*\}/)
})
