import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Fragment, h } from '../../src/dom/h'
import { createRoot, signal } from '../../src/index'

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  document.body.innerHTML = ''
})

/**
 * @canon case-a-reactive-child-without-an-owner-warns
 */
test('a function child that a Fragment tagged with an owner does not warn when inserted outside every owner', () => {
  const [count] = signal(1)
  let children: unknown
  createRoot(() => {
    children = h(Fragment, null, () => count())
  })
  h('div', null, children)
  expect(warn).not.toHaveBeenCalled()
  // Control: the same function child without a Fragment's tag does warn.
  h('div', null, () => count())
  expect(warn).toHaveBeenCalledTimes(1)
})

/**
 * @canon case-a-prop-binding-or-listener-without-an-owner-warns
 */
test('a ref outside every owner does not warn', () => {
  let element: Element | null = null
  h('div', {
    ref: (el: Element) => {
      element = el
    },
  })
  expect(element).not.toBeNull()
  expect(warn).not.toHaveBeenCalled()
})
