import { expect, test } from 'vitest'
import { createScope, chainFor, writeSlot, readSlot, chainMatch, linkEdge, edgesToFire, closeScopeEdges, ROOT_KIND, type Scope, type Node, type Slot, type Edge } from '../src/scope'

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

test('chainMatch fires when writeScope is in the target chain and unshadowed', () => {
  const root = createScope(undefined, 'owner')
  const name = sigNode()
  const consumerSlot: Slot = { recipe: undefined, cached: undefined, deps: [] }
  const edge: Edge = { source: name, target: consumerSlot, targetScope: root }
  expect(chainMatch(edge, root)).toBe(true)
})

test('chainMatch does NOT fire when writeScope is outside the target chain', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  const consumerSlot: Slot = { recipe: undefined, cached: undefined, deps: [] }
  const edge: Edge = { source: name, target: consumerSlot, targetScope: root }
  expect(chainMatch(edge, s)).toBe(false)
})

test('chainMatch does NOT fire when a more-specific scope shadows the write', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [] })
  const consumerSlot: Slot = { recipe: undefined, cached: undefined, deps: [] }
  const edge: Edge = { source: name, target: consumerSlot, targetScope: s }
  expect(chainMatch(edge, root)).toBe(false)
  expect(chainMatch(edge, s)).toBe(true)
})

test('linkEdge indexes on the source and records on the target scope', () => {
  const root = createScope(undefined, 'owner')
  const name = sigNode()
  const target: Slot = { recipe: undefined, cached: undefined, deps: [] }
  const edge = linkEdge(name, target, root)
  expect(name.subs.has(edge)).toBe(true)
  expect(root.edges.has(edge)).toBe(true)
  expect(target.deps).toContain(edge)
})

test('edgesToFire fixes the doubleName break: write under S fires the S-scoped edge', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  writeSlot(name, root, { recipe: () => 'foo', cached: 'foo', deps: [] })
  const doubleNameSlotInS: Slot = { recipe: undefined, cached: 'foofoo', deps: [] }
  linkEdge(name, doubleNameSlotInS, s)
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [] })
  const fired = edgesToFire(name, s)
  expect(fired.map((e) => e.target)).toContain(doubleNameSlotInS)
})

test('edgesToFire does not fire consumers outside the write chain', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  const rootConsumer: Slot = { recipe: undefined, cached: undefined, deps: [] }
  linkEdge(name, rootConsumer, root)
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [] })
  const fired = edgesToFire(name, s)
  expect(fired.map((e) => e.target)).not.toContain(rootConsumer)
})

test('closeScopeEdges unlinks the scope edges from their sources and drops slots', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  const targetInS: Slot = { recipe: undefined, cached: 'x', deps: [] }
  const edge = linkEdge(name, targetInS, s)
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [] })
  s.readSet.add(name)
  closeScopeEdges(s)
  expect(name.subs.has(edge)).toBe(false)
  expect(s.edges.size).toBe(0)
  expect(s.slots.has(name)).toBe(false)
  expect(root.children.has(s)).toBe(false)
})
