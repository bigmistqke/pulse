import { afterEach, expect, test } from 'vitest'
import { h } from '../../src/dom/h'

afterEach(() => { document.body.innerHTML = '' })

/**
 * @canon rule-h-creates-the-element-directly
 */
test('h creates an element with no children or props', () => {
  const el = h('div', null) as HTMLElement
  expect(el.tagName).toBe('DIV')
  expect(el.childNodes.length).toBe(0)
  expect(el.attributes.length).toBe(0)
})

/**
 * @canon rule-an-attribute-follows-its-value-and-is-removed-on-nothing
 */
test('h sets primitive props as attributes', () => {
  const el = h('div', { id: 'x', 'data-n': '5' }) as HTMLElement
  expect(el.getAttribute('id')).toBe('x')
  expect(el.getAttribute('data-n')).toBe('5')
})

/**
 * @canon rule-an-attribute-follows-its-value-and-is-removed-on-nothing
 */
test('h skips null/undefined/false attribute values', () => {
  const el = h('div', { a: null, b: undefined, c: false }) as HTMLElement
  expect(el.attributes.length).toBe(0)
})

/**
 * @canon rule-a-static-child-is-inserted-by-its-kind
 */
test('h inserts primitive children as text', () => {
  const el = h('div', null, 'hello', 42, ' world') as HTMLElement
  expect(el.textContent).toBe('hello42 world')
})

/**
 * @canon rule-a-static-child-is-inserted-by-its-kind
 */
test('h skips null/undefined/boolean children', () => {
  const el = h('div', null, null, undefined, true, false, 'x') as HTMLElement
  expect(el.textContent).toBe('x')
})

/**
 * @canon rule-a-static-child-is-inserted-by-its-kind
 */
test('h inserts DOM node children as-is', () => {
  const span = document.createElement('span')
  span.textContent = 'inner'
  const el = h('div', null, span) as HTMLElement
  expect(el.firstChild).toBe(span)
})

/**
 * @canon rule-a-static-child-is-inserted-by-its-kind
 */
test('h flattens array children', () => {
  const el = h('div', null, ['a', 'b', 'c']) as HTMLElement
  expect(el.textContent).toBe('abc')
})

/**
 * @canon rule-a-static-child-is-inserted-by-its-kind
 */
test('h flattens nested arrays', () => {
  const el = h('div', null, ['a', ['b', ['c', 'd']]]) as HTMLElement
  expect(el.textContent).toBe('abcd')
})

/**
 * @canon rule-a-static-child-is-inserted-by-its-kind
 */
test('h preserves order of mixed children', () => {
  const span = document.createElement('span')
  span.textContent = 'X'
  const el = h('div', null, 'a', span, 'b', [null, 'c']) as HTMLElement
  expect(el.textContent).toBe('aXbc')
})
