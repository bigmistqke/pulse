import { transformSync } from '@babel/core'
import { expect, test } from 'vitest'
import pulsePropsToGetters from '../src/babel-plugin'

// The plugin operates on the _jsx()/_jsxs() calls @babel/plugin-transform-
// react-jsx produces, not on raw JSX syntax - it always needs to run
// together with that plugin, never standalone.
function transform(source: string): string {
  const result = transformSync(source, {
    filename: 'test.tsx',
    presets: [['@babel/preset-typescript', {}]],
    plugins: [
      '@babel/plugin-syntax-jsx',
      pulsePropsToGetters,
      [
        '@babel/plugin-transform-react-jsx',
        { runtime: 'automatic', importSource: 'pulse', throwIfNamespace: false },
      ],
    ],
    babelrc: false,
    configFile: false,
  })
  if (!result?.code) throw new Error('transform produced no code')
  return result.code
}

test('converts a dynamic component prop to a getter', () => {
  const code = transform('<Foo a={count()} b={todo.text} c={draft} d={x + y} e={`${count()}`} />;')
  expect(code).toContain('get a() {\n    return count();\n  }')
  expect(code).toContain('get b() {\n    return todo.text;\n  }')
  expect(code).toContain('get c() {\n    return draft;\n  }')
  expect(code).toContain('get d() {\n    return x + y;\n  }')
  expect(code).toContain('get e() {\n    return `${count()}`;\n  }')
})

test('converts a dynamic DOM attribute-like prop to a getter, same as a component', () => {
  const code = transform('<div a={count()} b={todo.text} />;')
  expect(code).toContain('get a() {\n    return count();\n  }')
  expect(code).toContain('get b() {\n    return todo.text;\n  }')
})

test('leaves a literal prop value untouched (no getter)', () => {
  const code = transform('<Foo a={5} b={"x"} c={true} d={null} />;')
  expect(code).not.toContain('get a()')
  expect(code).not.toContain('get b()')
  expect(code).not.toContain('get c()')
  expect(code).not.toContain('get d()')
  expect(code).toContain('a: 5')
  expect(code).toContain('b: "x"')
  expect(code).toContain('c: true')
  expect(code).toContain('d: null')
})

test('leaves an existing function/arrow expression prop value untouched (no getter)', () => {
  const code = transform('<Foo onSelect={() => bar()} />;')
  expect(code).not.toContain('get onSelect()')
  expect(code).toContain('onSelect: () => bar()')
})

test('never converts ref or an on:-namespaced attribute to a getter, even for a bare identifier value', () => {
  const code = transform('<input ref={setup} on:click={handleClick} on:input={handleInput} />;')
  expect(code).not.toContain('get ref()')
  expect(code).not.toContain('get "on:click"()')
  expect(code).not.toContain('get "on:input"()')
  expect(code).toContain('ref: setup')
  expect(code).toContain('"on:click": handleClick')
  expect(code).toContain('"on:input": handleInput')
})

test('converts a dynamic attr: value to a getter, same as every other binding kind (only ref/on: are excluded)', () => {
  const code = transform('<div attr:data-x={v} />;')
  expect(code).toContain('get "attr:data-x"() {\n    return v;\n  }')
})

test('a namespaced attribute is a plain string-keyed prop, matching bindProp\'s prefix dispatch', () => {
  const code = transform('<div on:click={handler} />;')
  expect(code).toContain('"on:click": handler')
})

test('spread: rewrites to mergeProps(...) instead of native object spread, preserving getter-ness of the spread source', () => {
  const code = transform('<Foo a={x} {...rest} b={y} {...more} c={z} />;')
  expect(code).toContain('import { jsx as _jsx, mergeProps as _mergeProps } from "pulse/jsx-runtime"')
  expect(code).toContain('_mergeProps({')
  expect(code).toContain('get a() {')
  expect(code).toContain('return x;')
  expect(code).toContain('}, rest, {')
  expect(code).toContain('get b() {')
  expect(code).toContain('}, more, {')
  expect(code).toContain('get c() {')
  // Never falls back to native spread syntax for the getter-bearing props.
  expect(code).not.toContain('...rest')
  expect(code).not.toContain('...more')
})

test('spread: a lone spread with no other props becomes mergeProps(source)', () => {
  const code = transform('<Foo {...rest} />;')
  expect(code).toContain('_mergeProps(rest)')
})

test('spread: reuses a single mergeProps import across multiple spread call sites in one file', () => {
  const code = transform('function A() { return <Foo {...a}/> } function B() { return <Bar {...b}/> }')
  const importMatches = code.match(/mergeProps as _mergeProps/g) ?? []
  expect(importMatches.length).toBe(1)
})

test('DOM tag children: a single dynamic child is thunk-wrapped, not converted to a getter', () => {
  const code = transform('<div>{count()}</div>;')
  expect(code).toContain('children: () => count()')
  expect(code).not.toContain('get children()')
})

test('DOM tag children: a literal or function-expression child is left untouched', () => {
  const code = transform('<div>{5}</div>;')
  expect(code).toContain('children: 5')
  const code2 = transform('<div>{() => bar()}</div>;')
  expect(code2).toContain('children: () => bar()')
  expect(code2).not.toContain('() => () => bar()')
})

test('DOM tag children: multiple dynamic children are wrapped INDIVIDUALLY, not as one array-thunk', () => {
  const code = transform('<div>{a}{b}</div>;')
  expect(code).toContain('children: [() => a, () => b]')
})

test('DOM tag children: a nested static JSX element is never thunk-wrapped, even though it compiles to a CallExpression', () => {
  const code = transform('<div><span>hi</span></div>;')
  expect(code).not.toContain('() =>')
  expect(code).toContain('_jsx("span"')
})

test('DOM tag children: a nested JSX element mixed with a dynamic sibling only wraps the dynamic one', () => {
  const code = transform('<div><span>{count()}</span><span>b</span></div>;')
  const jsxCalls = code.match(/_jsx\("span"/g) ?? []
  expect(jsxCalls.length).toBe(2)
  expect(code).not.toMatch(/children: \[\(\) => _jsx/)
  expect(code).toContain('children: () => count()')
})

test('component children: the whole value becomes ONE getter, not per-element wrapping', () => {
  const code = transform('<Foo>{a}{b}</Foo>;')
  expect(code).toContain('get children() {\n    return [a, b];\n  }')
})

test('bare (unbraced) JSX-element child of a component compiles identically to the braced form', () => {
  const braced = transform('<Loading>{<TodoList/>}</Loading>;')
  const bare = transform('<Loading><TodoList/></Loading>;')
  expect(bare).toBe(braced)
  expect(bare).toContain('get children() {\n    return _jsx(TodoList, {});\n  }')
})

test('Fragment children behave like DOM tag children (thunk-wrapped), not like a component', () => {
  const code = transform('<Loading><>{a}{b}</></Loading>;')
  expect(code).toContain('get children() {\n    return _jsxs(_Fragment, {\n      children: [() => a, () => b]\n    });\n  }')
})

test('a member-expression tag (Foo.Bar) is treated as a component: children becomes a getter', () => {
  const code = transform('<Foo.Bar><Baz/></Foo.Bar>;')
  expect(code).toContain('get children() {\n    return _jsx(Baz, {});\n  }')
})

test('wraps identically whether the tag is a DOM element or a component, for non-children props', () => {
  const code = transform('<Foo c={count()} />; <div c={count()} />;')
  const matches = code.match(/get c\(\) \{\n {4}return count\(\);\n {2}\}/g) ?? []
  expect(matches.length).toBe(2)
})
