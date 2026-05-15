import { afterEach, beforeEach, expect, test } from 'vitest'
import { Fragment, h } from '../../src/dom/h'
import {
  createRoot,
  flush,
  microtaskScheduler,
  setScheduler,
  signal,
  syncScheduler,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('a function tag is invoked once with props', () => {
  const Greeting = (props: { name: string }) =>
    h('p', null, 'Hello, ', props.name) as HTMLElement
  createRoot(() => {
    const node = h(Greeting, { name: 'world' }) as HTMLElement
    document.body.append(node)
    expect(node.tagName).toBe('P')
    expect(node.textContent).toBe('Hello, world')
  })
})

test('a function tag receives children via props.children', () => {
  const Box = (props: { children: unknown }) =>
    h('div', { 'class:box': true }, props.children) as HTMLElement
  createRoot(() => {
    const node = h(Box, null, 'inner') as HTMLElement
    document.body.append(node)
    expect(node.classList.contains('box')).toBe(true)
    expect(node.textContent).toBe('inner')
  })
})

test('components compose with reactive children', () => {
  const Label = (props: { value: () => unknown }) =>
    h('span', null, props.value) as HTMLElement
  createRoot(() => {
    const [n, setN] = signal(1)
    const node = h(Label, { value: n }) as HTMLElement
    document.body.append(node)
    expect(node.textContent).toBe('1')
    setN(2)
    expect(node.textContent).toBe('2')
  })
})

test('Fragment returns children as an array', () => {
  createRoot(() => {
    const result = h(Fragment, null, 'a', 'b', 'c')
    expect(Array.isArray(result)).toBe(true)
    expect((result as unknown[]).length).toBe(3)
  })
})

test('Fragment composed inside an element flattens', () => {
  createRoot(() => {
    const el = h('div', null, h(Fragment, null, 'a', 'b'), 'c') as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('abc')
  })
})
