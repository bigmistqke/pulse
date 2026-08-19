import { transformSync } from '@babel/core'
import { expect, test } from 'vitest'
import pulsePropsToGetters from '../src/babel-plugin'

function transform(source: string): string {
  const result = transformSync(source, {
    filename: 'test.tsx',
    presets: [['@babel/preset-typescript', {}]],
    plugins: ['@babel/plugin-syntax-jsx', pulsePropsToGetters],
    babelrc: false,
    configFile: false,
  })
  if (!result?.code) throw new Error('transform produced no code')
  return result.code
}

test('wraps dynamic attribute expressions in a thunk', () => {
  const code = transform('<div a={count()} b={todo.text} c={draft} d={x + y} e={`${count()}`} />;')
  expect(code).toContain('a={() => count()}')
  expect(code).toContain('b={() => todo.text}')
  expect(code).toContain('c={() => draft}')
  expect(code).toContain('d={() => x + y}')
  expect(code).toContain('e={() => `${count()}`}')
})

test('leaves literal attribute values untouched', () => {
  const code = transform('<div a={5} b={"x"} c={true} d={null} />;')
  expect(code).toContain('a={5}')
  expect(code).toContain('b={"x"}')
  expect(code).toContain('c={true}')
  expect(code).toContain('d={null}')
})

test('leaves an existing function/arrow expression attribute value untouched', () => {
  const code = transform('<div onFoo={() => bar()} />;')
  expect(code).toContain('onFoo={() => bar()}')
  expect(code).not.toContain('() => () => bar()')
})

test('never wraps ref or an on:-namespaced attribute, even for a bare identifier value', () => {
  const code = transform('<input ref={setup} on:click={handleClick} on:input={handleInput} />;')
  expect(code).toContain('ref={setup}')
  expect(code).toContain('on:click={handleClick}')
  expect(code).toContain('on:input={handleInput}')
})

test('never touches a spread attribute', () => {
  const code = transform('<div {...rest} />;')
  expect(code).toContain('{...rest}')
})
