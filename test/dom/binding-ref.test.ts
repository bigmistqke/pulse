import { afterEach, expect, test } from 'vitest'
import { h } from '../../src/dom/h'
import { createRoot } from '../../src/index'

afterEach(() => { document.body.innerHTML = '' })

/**
 * @canon rule-a-ref-is-called-once-with-its-element
 */
test('ref receives the mounted element', () => {
  let captured: HTMLElement | null = null
  createRoot(() => {
    const el = h('div', { ref: (e: HTMLElement) => { captured = e } }) as HTMLElement
    document.body.append(el)
    expect(captured).toBe(el)
  })
})

/**
 * @canon rule-a-ref-is-called-once-with-its-element
 */
test('a ref function is invoked once with its element, not re-run as a reactive binding', () => {
  // The spec says ref is not reactive. The handler is the function itself,
  // even if it happens to be a signal accessor.
  let calls = 0
  createRoot(() => {
    const fn = (_: HTMLElement) => { calls++ }
    h('div', { ref: fn })
    expect(calls).toBe(1)
  })
})
