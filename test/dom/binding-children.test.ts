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

test('function child renders the current value as text', () => {
  createRoot(() => {
    const count = signal(0)
    const el = h('div', null, count) as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('0')
  })
})

test('function child re-renders when its signal changes', () => {
  createRoot(() => {
    const count = signal(0)
    const el = h('div', null, count) as HTMLElement
    document.body.append(el)
    setSignal(count, 7)
    expect(el.textContent).toBe('7')
  })
})

test('function child replaces previous DOM each run', () => {
  createRoot(() => {
    const which = signal<'a' | 'b'>('a')
    const el = h('div', null, () => which() === 'a' ? 'aaa' : 'bbb') as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('aaa')
    setSignal(which, 'b')
    expect(el.textContent).toBe('bbb')
  })
})

test('function child can return a DOM node', () => {
  createRoot(() => {
    const which = signal<'x' | 'y'>('x')
    const el = h('div', null, () => {
      const span = document.createElement('span')
      span.textContent = which()
      return span
    }) as HTMLElement
    document.body.append(el)
    expect(el.querySelector('span')?.textContent).toBe('x')
    setSignal(which, 'y')
    expect(el.querySelector('span')?.textContent).toBe('y')
  })
})

test('function child preserves marker order for static siblings', () => {
  createRoot(() => {
    const mid = signal('M')
    const el = h('div', null, 'L', mid, 'R') as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('LMR')
    setSignal(mid, 'm')
    expect(el.textContent).toBe('LmR')
  })
})
