import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { h } from '../../src/dom/h'
import {
  createRoot,
  flush,
  microtaskScheduler,
  setScheduler,
  signal,
  syncScheduler,
} from '../../src/index'

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setScheduler(syncScheduler(flush))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  warnSpy.mockRestore()
  document.body.innerHTML = ''
})

test('a static attr:/bare/prop:/class:/style: value still warns - every kind but ref/on: is always effect-wrapped', () => {
  // Every kind except ref and on: always wraps its read in an effect,
  // regardless of whether the value turns out to be static - so creating
  // one outside any owner warns the same as a genuinely dynamic one would.
  h('div', { 'attr:id': 'static' })
  expect(warnSpy).toHaveBeenCalledTimes(1)
  expect(warnSpy.mock.calls[0][0]).toMatch(/attr binding.*outside any owner/)
  warnSpy.mockClear()
  h('div', { id: 'static' })
  expect(warnSpy).toHaveBeenCalledTimes(1)
  expect(warnSpy.mock.calls[0][0]).toMatch(/attr binding.*outside any owner/)
})

test('reactive function child outside any owner warns', () => {
  const [count] = signal(0)
  h('div', null, count)
  expect(warnSpy).toHaveBeenCalledTimes(1)
  expect(warnSpy.mock.calls[0][0]).toMatch(/reactive child.*outside any owner/)
})

test('on: event listener outside any owner warns', () => {
  h('button', { 'on:click': () => {} })
  expect(warnSpy).toHaveBeenCalledTimes(1)
  expect(warnSpy.mock.calls[0][0]).toMatch(/event listener.*outside any owner/)
})

test('reactive prop binding outside any owner warns', () => {
  const [v] = signal('a')
  h('input', { 'prop:value': v })
  expect(warnSpy).toHaveBeenCalledTimes(1)
  expect(warnSpy.mock.calls[0][0]).toMatch(/prop binding.*outside any owner/)
})

test('reactive attr/class/style bindings outside any owner warn', () => {
  const [s] = signal('x')
  h('div', { title: s, 'attr:data-x': s, 'class:on': s, 'style:color': s })
  expect(warnSpy.mock.calls.length).toBe(4)
})

test('inside createRoot, no warnings', () => {
  createRoot(() => {
    const [v] = signal('a')
    h('div', { title: v, 'on:click': () => {} }, v)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
