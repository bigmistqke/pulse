import { afterEach, beforeEach, expect, test } from 'vitest'
import { h } from '../../src/dom/h'
import {
  createRoot,
  flush,
  microtaskScheduler,
  setScheduler,
  setSignal,
  signal,
  syncScheduler,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('prop:value sets the DOM property, not the attribute', () => {
  createRoot(() => {
    const el = h('input', { 'prop:value': 'hi' }) as HTMLInputElement
    document.body.append(el)
    expect(el.value).toBe('hi')
    expect(el.getAttribute('value')).toBe(null) // not set as attribute
  })
})

test('prop:disabled toggles the boolean property correctly', () => {
  createRoot(() => {
    const el = h('button', { 'prop:disabled': true }) as HTMLButtonElement
    document.body.append(el)
    expect(el.disabled).toBe(true)
  })
})

test('prop: with function value is reactive', () => {
  createRoot(() => {
    const v = signal('a')
    const el = h('input', { 'prop:value': v }) as HTMLInputElement
    document.body.append(el)
    expect(el.value).toBe('a')
    setSignal(v, 'b')
    expect(el.value).toBe('b')
  })
})
