import { expect, test } from 'vitest'
import { signal, setSignal } from 'r3'

test('r3 is importable and functional from pulse', () => {
  const s = signal(1)
  expect(s.value).toBe(1)
  setSignal(s, 2)
  expect(s.value).toBe(2)
})
