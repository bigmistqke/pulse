import { afterEach, beforeEach, expect, test } from 'vitest'
import { h } from '../../src/dom/h'
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

/**
 * @canon rule-a-class-prefix-toggles-one-class-by-truthiness
 */
test('class:name toggles a class based on truthiness', () => {
  createRoot(() => {
    const el = h('div', { 'class:active': true, 'class:disabled': false }) as HTMLElement
    document.body.append(el)
    expect(el.classList.contains('active')).toBe(true)
    expect(el.classList.contains('disabled')).toBe(false)
  })
})

/**
 * @canon rule-a-class-prefix-toggles-one-class-by-truthiness
 */
test('class:name is reactive with a function value', () => {
  createRoot(() => {
    const [on, setOn] = signal(false)
    const el = h('div', { 'class:active': on }) as HTMLElement
    document.body.append(el)
    expect(el.classList.contains('active')).toBe(false)
    setOn(true)
    expect(el.classList.contains('active')).toBe(true)
    setOn(false)
    expect(el.classList.contains('active')).toBe(false)
  })
})

/**
 * @canon rule-a-style-prefix-sets-one-style-property
 */
test('style:name sets a single CSS property', () => {
  createRoot(() => {
    const el = h('div', { 'style:color': 'red' }) as HTMLElement
    document.body.append(el)
    expect(el.style.color).toBe('red')
  })
})

/**
 * @canon rule-a-style-prefix-sets-one-style-property
 */
test('style:name is reactive with a function value', () => {
  createRoot(() => {
    const [c, setC] = signal('red')
    const el = h('div', { 'style:color': c }) as HTMLElement
    document.body.append(el)
    expect(el.style.color).toBe('red')
    setC('blue')
    expect(el.style.color).toBe('blue')
  })
})

/**
 * @canon rule-a-style-prefix-sets-one-style-property
 */
test('style:name removes the property on nullish/false value', () => {
  createRoot(() => {
    const [c, setC] = signal<string | null>('red')
    const el = h('div', { 'style:color': c }) as HTMLElement
    document.body.append(el)
    expect(el.style.color).toBe('red')
    setC(null)
    expect(el.style.color).toBe('')
  })
})
