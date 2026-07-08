import { expect, test } from 'vitest'
import { createScope, ROOT_KIND, type Scope } from '../src/scope'

test('createScope produces an open scope with empty bags', () => {
  const s = createScope(undefined, 'speculative')
  expect(s.parent).toBeUndefined()
  expect(s.kind).toBe('speculative')
  expect(s.status).toBe('open')
  expect(s.slots.size).toBe(0)
  expect(s.edges.size).toBe(0)
  expect(s.writeSet.size).toBe(0)
  expect(s.readSet.size).toBe(0)
  expect(s.children.size).toBe(0)
})

test('a child scope links to its parent and registers in the parent children', () => {
  const root = createScope(undefined, 'owner')
  const child = createScope(root, 'speculative')
  expect(child.parent).toBe(root)
  expect(root.children.has(child)).toBe(true)
})
