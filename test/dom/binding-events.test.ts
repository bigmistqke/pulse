import { afterEach, expect, test, vi } from 'vitest'
import { h } from '../../src/dom/h'
import { createRoot, onCleanup } from '../../src/index'

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

test('on:click captures the owner at bind time, so onCleanup called from inside the handler attaches to it', () => {
  let cleaned = false
  let el!: HTMLButtonElement
  const dispose = createRoot((d) => {
    el = h('button', {
      'on:click': () => {
        onCleanup(() => {
          cleaned = true
        })
      },
    }) as HTMLButtonElement
    document.body.append(el)
    return d
  })

  el.click() // registers the cleanup against the root captured when the handler was bound
  expect(cleaned).toBe(false)

  dispose()
  expect(cleaned).toBe(true)
})
