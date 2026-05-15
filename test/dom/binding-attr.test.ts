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

test('attr:name explicitly sets the attribute', () => {
  createRoot(() => {
    const el = h('div', { 'attr:aria-label': 'box' }) as HTMLElement
    document.body.append(el)
    expect(el.getAttribute('aria-label')).toBe('box')
  })
})

test('default (bare) prop with function value is reactive', () => {
  createRoot(() => {
    const id = signal('a')
    const el = h('div', { id }) as HTMLElement
    document.body.append(el)
    expect(el.getAttribute('id')).toBe('a')
    setSignal(id, 'b')
    expect(el.getAttribute('id')).toBe('b')
  })
})

test('reactive attr is removed when value goes null/false', () => {
  createRoot(() => {
    const v = signal<string | null>('x')
    const el = h('div', { title: v }) as HTMLElement
    document.body.append(el)
    expect(el.getAttribute('title')).toBe('x')
    setSignal(v, null)
    expect(el.hasAttribute('title')).toBe(false)
    setSignal(v, 'y')
    expect(el.getAttribute('title')).toBe('y')
  })
})

test('attr: with function value is reactive', () => {
  createRoot(() => {
    const v = signal('one')
    const el = h('div', { 'attr:data-x': v }) as HTMLElement
    document.body.append(el)
    expect(el.getAttribute('data-x')).toBe('one')
    setSignal(v, 'two')
    expect(el.getAttribute('data-x')).toBe('two')
  })
})
