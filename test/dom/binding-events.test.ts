import { afterEach, expect, test, vi } from 'vitest'
import { h } from '../../src/dom/h'
import { createRoot } from '../../src/index'

afterEach(() => { document.body.innerHTML = '' })

test('on:click attaches a listener', () => {
  const handler = vi.fn()
  createRoot(() => {
    const el = h('button', { 'on:click': handler }) as HTMLButtonElement
    document.body.append(el)
    el.click()
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

test('on:event passes the lowercased event name', () => {
  const handler = vi.fn()
  createRoot(() => {
    const el = h('input', { 'on:input': handler }) as HTMLInputElement
    document.body.append(el)
    el.dispatchEvent(new Event('input'))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

test('on:click listener is removed on owner dispose', () => {
  const handler = vi.fn()
  let el!: HTMLButtonElement
  const dispose = createRoot((d) => {
    el = h('button', { 'on:click': handler }) as HTMLButtonElement
    document.body.append(el)
    return d
  })
  el.click()
  expect(handler).toHaveBeenCalledTimes(1)
  dispose()
  el.click()
  expect(handler).toHaveBeenCalledTimes(1) // unchanged after dispose
})
