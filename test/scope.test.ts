import { expect, test } from 'vitest'
import { createScope, chainFor, writeSlot, readSlot, ROOT_KIND, type Scope, type Node, type Slot } from '../src/scope'

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

test('chainFor walks parents most-specific to terminal', () => {
  const root = createScope(undefined, 'owner')
  const outer = createScope(root, 'speculative')
  const inner = createScope(outer, 'speculative')
  expect(chainFor(inner)).toEqual([inner, outer, root])
  expect(chainFor(root)).toEqual([root])
})

const sigNode = (): Node => ({ subs: new Set() })

test('writeSlot stores a slot on the scope and records the write', () => {
  const root = createScope(undefined, 'owner')
  const name = sigNode()
  const slot: Slot<string> = { recipe: () => 'foo', cached: 'foo', deps: [] }
  writeSlot(name, root, slot)
  expect(root.slots.get(name)).toBe(slot)
  expect(root.writeSet.has(name)).toBe(true)
})

test('readSlot falls through the chain to the nearest slot', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  writeSlot(name, root, { recipe: () => 'foo', cached: 'foo', deps: [] })
  expect(readSlot(name, s)?.cached).toBe('foo')
  expect(readSlot(sigNode(), s)).toBeUndefined()
})

test('a more-specific slot shadows an ancestor slot', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  writeSlot(name, root, { recipe: () => 'foo', cached: 'foo', deps: [] })
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [] })
  expect(readSlot(name, s)?.cached).toBe('bar')
  expect(readSlot(name, root)?.cached).toBe('foo')
})
