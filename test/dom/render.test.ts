import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { h } from '../../src/dom/h'
import {
  flush,
  microtaskScheduler,
  onCleanup,
  render,
  setScheduler,
  signal,
  syncScheduler,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('render mounts a component and returns dispose', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(() => h('p', null, 'hi'), target)
  expect(target.innerHTML).toBe('<p>hi</p>')
  expect(typeof dispose).toBe('function')
  dispose()
})

test('render dispose removes the mounted nodes', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(() => h('p', null, 'hi'), target)
  expect(target.children.length).toBe(1)
  dispose()
  expect(target.children.length).toBe(0)
})

test('render dispose tears down binding-effects', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [count, setCount] = signal(0)
  const renders = vi.fn(() => count())
  const dispose = render(() => h('p', null, renders), target)
  expect(renders).toHaveBeenCalledTimes(1)
  setCount(1)
  expect(renders).toHaveBeenCalledTimes(2)
  dispose()
  setCount(2)
  expect(renders).toHaveBeenCalledTimes(2) // no further runs after dispose
})

test('render supports a component returning an array', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => [h('p', null, 'a') as Node, h('p', null, 'b') as Node],
    target,
  )
  expect(target.children.length).toBe(2)
  expect(target.textContent).toBe('ab')
  dispose()
  expect(target.children.length).toBe(0)
})

test('render accepts a top-level reactive (function) return', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [count, setCount] = signal(0)
  const dispose = render(() => count, target)
  expect(target.textContent).toBe('0')
  setCount(7)
  flush()
  expect(target.textContent).toBe('7')
  dispose()
  // Marker comments and the text node should all be gone.
  expect(target.childNodes.length).toBe(0)
})

test('render accepts a top-level primitive return', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(() => 'plain text', target)
  expect(target.textContent).toBe('plain text')
  dispose()
  expect(target.childNodes.length).toBe(0)
})

test('render() disposes root owner if component throws synchronously', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleanedUp = false
  expect(() => render(
    () => {
      onCleanup(() => { cleanedUp = true })
      throw new Error('boom from component')
    },
    target,
  )).toThrow('boom from component')
  // Owner should have been disposed despite the throw escaping
  expect(cleanedUp).toBe(true)
})
