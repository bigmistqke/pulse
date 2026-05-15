import { expect, test } from 'vitest'

test('browser-mode is wired: document.createElement works', () => {
  const el = document.createElement('div')
  el.textContent = 'hello'
  document.body.append(el)
  expect(document.body.innerHTML).toContain('hello')
  el.remove()
})
