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

test('class:name toggles a class based on truthiness', () => {
  createRoot(() => {
    const el = h('div', { 'class:active': true, 'class:disabled': false }) as HTMLElement
    document.body.append(el)
    expect(el.classList.contains('active')).toBe(true)
    expect(el.classList.contains('disabled')).toBe(false)
  })
})

test('class:name is reactive with a function value', () => {
  createRoot(() => {
    const on = signal(false)
    const el = h('div', { 'class:active': on }) as HTMLElement
    document.body.append(el)
    expect(el.classList.contains('active')).toBe(false)
    setSignal(on, true)
    expect(el.classList.contains('active')).toBe(true)
    setSignal(on, false)
    expect(el.classList.contains('active')).toBe(false)
  })
})

test('style:name sets a single CSS property', () => {
  createRoot(() => {
    const el = h('div', { 'style:color': 'red' }) as HTMLElement
    document.body.append(el)
    expect(el.style.color).toBe('red')
  })
})

test('style:name is reactive with a function value', () => {
  createRoot(() => {
    const c = signal('red')
    const el = h('div', { 'style:color': c }) as HTMLElement
    document.body.append(el)
    expect(el.style.color).toBe('red')
    setSignal(c, 'blue')
    expect(el.style.color).toBe('blue')
  })
})

test('style:name removes the property on nullish/false value', () => {
  createRoot(() => {
    const c = signal<string | null>('red')
    const el = h('div', { 'style:color': c }) as HTMLElement
    document.body.append(el)
    expect(el.style.color).toBe('red')
    setSignal(c, null)
    expect(el.style.color).toBe('')
  })
})
