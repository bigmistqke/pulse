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
 * @canon rule-a-function-child-is-a-reactive-hole
 */
test('function child renders the current value as text', () => {
  createRoot(() => {
    const [count] = signal(0)
    const el = h('div', null, count) as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('0')
  })
})

/**
 * @canon rule-a-function-child-is-a-reactive-hole
 */
test('function child re-renders when its signal changes', () => {
  createRoot(() => {
    const [count, setCount] = signal(0)
    const el = h('div', null, count) as HTMLElement
    document.body.append(el)
    setCount(7)
    expect(el.textContent).toBe('7')
  })
})

/**
 * @canon rule-a-function-child-is-a-reactive-hole
 */
test('function child replaces previous DOM each run', () => {
  createRoot(() => {
    const [which, setWhich] = signal<'a' | 'b'>('a')
    const el = h('div', null, () => which() === 'a' ? 'aaa' : 'bbb') as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('aaa')
    setWhich('b')
    expect(el.textContent).toBe('bbb')
  })
})

/**
 * @canon rule-a-function-child-returns-anything-a-static-child-may-be
 */
test('function child can return a DOM node', () => {
  createRoot(() => {
    const [which, setWhich] = signal<'x' | 'y'>('x')
    const el = h('div', null, () => {
      const span = document.createElement('span')
      span.textContent = which()
      return span
    }) as HTMLElement
    document.body.append(el)
    expect(el.querySelector('span')?.textContent).toBe('x')
    setWhich('y')
    expect(el.querySelector('span')?.textContent).toBe('y')
  })
})

/**
 * @canon rule-a-function-childs-static-siblings-keep-their-place
 */
test('function child preserves marker order for static siblings', () => {
  createRoot(() => {
    const [mid, setMid] = signal('M')
    const el = h('div', null, 'L', mid, 'R') as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('LMR')
    setMid('m')
    expect(el.textContent).toBe('LmR')
  })
})

/**
 * @canon case-each-run-of-a-reactive-child-owns-what-it-creates
 */
test('nested reactive child does not leak the inner effect on outer re-run', () => {
  createRoot(() => {
    const [outer, setOuter] = signal(0)
    const [inner, setInner] = signal(0)
    let innerRuns = 0
    const el = h('div', null, () => {
      outer() // outer dep
      return h('span', null, () => {
        innerRuns++
        return String(inner())
      })
    }) as HTMLElement
    document.body.append(el)
    flush()
    expect(innerRuns).toBe(1)
    // Trigger outer re-run multiple times. If the inner effect leaks,
    // each old nested effect remains subscribed to `inner`.
    setOuter(1)
    setOuter(2)
    setOuter(3)
    // Now bump inner. With proper disposal, exactly one (the latest) inner
    // effect re-runs. With leak, all four (or however many accumulated) fire.
    const before = innerRuns
    setInner(100)
    expect(innerRuns - before).toBe(1)
  })
})

/**
 * @canon rule-a-function-child-returns-anything-a-static-child-may-be
 */
test('a function child whose result is a function renders that function as a reactive child', () => {
  const [label, setLabel] = signal('first')
  const [source] = signal(0)
  let host!: HTMLElement
  createRoot(() => {
    host = h(
      'p',
      null,
      () => {
        source() // the outer child has read something before its result is built
        return () => label()
      },
    ) as HTMLElement
  })
  expect(host.textContent).toBe('first')
  setLabel('second')
  expect(host.textContent).toBe('second')
})
