import { expect, test } from 'vitest'
import { createScope, chainFor, writeSlot, readSlot, chainMatch, linkEdge, edgesToFire, closeScopeEdges, ROOT_KIND, ROOT_SCOPE, getCurrentScope, getCurrentTracker, runInScope, signalNode, computedNode, readValue, writeValue, commit, discard, action, type Scope, type Node, type Slot, type Edge } from '../src/scope'
import { read as r3Read } from 'r3'

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
  expect(s.writeSet.has(name)).toBe(false)
  expect(s.readSet.has(name)).toBe(false)
  expect(root.children.has(s)).toBe(false)
})

test('current scope defaults to ROOT_SCOPE, tracker to undefined', () => {
  expect(getCurrentScope()).toBe(ROOT_SCOPE)
  expect(getCurrentTracker()).toBeUndefined()
})

test('runInScope pushes and restores the scope (and tracker) even on throw', () => {
  const s = createScope(ROOT_SCOPE, 'speculative')
  const slot: Slot = { recipe: undefined, cached: undefined, deps: [] }
  runInScope(s, slot, () => {
    expect(getCurrentScope()).toBe(s)
    expect(getCurrentTracker()).toBe(slot)
  })
  expect(getCurrentScope()).toBe(ROOT_SCOPE)
  expect(getCurrentTracker()).toBeUndefined()
  expect(() => runInScope(s, slot, () => { throw new Error('x') })).toThrow('x')
  expect(getCurrentScope()).toBe(ROOT_SCOPE) // restored despite throw
})

test('signalNode wraps an r3 signal holding the committed value', () => {
  const n = signalNode(5)
  expect(n.subs.size).toBe(0)
  expect(n.backing).toBeDefined()
  expect(r3Read(n.backing!)).toBe(5)
})

test('computedNode carries the recipe as defaultRecipe and an r3 computed backing', () => {
  const n = computedNode(() => 7)
  expect(n.defaultRecipe).toBeDefined()
  expect(r3Read(n.backing!)).toBe(7)
})

test('read/write with no active speculation go through r3 (committed)', () => {
  const n = signalNode(0)
  expect(readValue(n)).toBe(0)      // ambient scope is ROOT_SCOPE
  writeValue(n, 5)
  expect(readValue(n)).toBe(5)      // committed value updated via r3
})

test('a speculative write is isolated from committed state and visible under its scope', () => {
  const n = signalNode('foo')
  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => writeValue(n, 'bar'))
  // committed untouched:
  expect(readValue(n)).toBe('foo')
  // visible under S:
  expect(runInScope(s, undefined, () => readValue(n))).toBe('bar')
})

test('a speculative write marks matching downstream speculative slots dirty', () => {
  const name = signalNode('foo')
  const s = createScope(ROOT_SCOPE, 'speculative')
  // a downstream slot in S that depends on `name`:
  const derivedSlot: Slot = { recipe: undefined, cached: 'stale', deps: [] }
  linkEdge(name, derivedSlot, s)
  runInScope(s, undefined, () => writeValue(name, 'bar'))
  expect(derivedSlot.cached).toBeUndefined() // dirtied (cached dropped)
})

test('reading a computed under a speculation runs its recipe into an S-slot and links deps', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  const s = createScope(ROOT_SCOPE, 'speculative')
  const v = runInScope(s, undefined, () => readValue(doubleName))
  expect(v).toBe('foofoo')
  // an S-slot was created for doubleName, and name got a pulse edge into it:
  expect(s.slots.has(doubleName)).toBe(true)
  expect([...name.subs].some((e) => e.targetScope === s)).toBe(true)
  expect([...name.subs].some((e) => e.target === s.slots.get(doubleName))).toBe(true)
})

test('doubleName trace steps 1-4: speculative recompute is isolated and reactive', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  const s = createScope(ROOT_SCOPE, 'speculative')

  runInScope(s, undefined, () => {
    expect(readValue(doubleName)).toBe('foofoo') // step: read under S, computes from committed
    writeValue(name, 'bar')                      // step: setName under S (speculative)
    expect(readValue(name)).toBe('bar')          // S sees its own write
    expect(readValue(doubleName)).toBe('barbar') // step: doubleName recomputes under S — THE break, fixed
  })

  // committed world never moved:
  expect(readValue(name)).toBe('foo')
  expect(readValue(doubleName)).toBe('foofoo')
})

test('recompute does not accumulate edges across cycles', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => {
    expect(readValue(doubleName)).toBe('foofoo')
    const after1 = name.subs.size
    writeValue(name, 'bar')
    expect(readValue(doubleName)).toBe('barbar')
    writeValue(name, 'baz')
    expect(readValue(doubleName)).toBe('bazbaz')
    // edges must not grow across recomputes:
    expect(name.subs.size).toBe(after1)
    // and the slot's own deps list must not grow either:
    expect(s.slots.get(doubleName)!.deps.length).toBe(after1)
  })
})

test('a committed computed reacts to a committed signal write (no speculation)', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  expect(readValue(doubleName)).toBe('foofoo')
  writeValue(name, 'bar')          // committed write (ambient is ROOT_SCOPE)
  expect(readValue(doubleName)).toBe('barbar') // committed computed recomputed
})

test('commit promotes a speculative signal write to committed (doubleName step 5a)', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  expect(readValue(doubleName)).toBe('foofoo')

  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => writeValue(name, 'bar'))
  // before commit: committed world unchanged
  expect(readValue(name)).toBe('foo')

  commit(s)
  // after commit: promoted to committed; computed recomputes
  expect(readValue(name)).toBe('bar')
  expect(readValue(doubleName)).toBe('barbar')
  expect(s.status).toBe('committed')
  expect(s.slots.size).toBe(0) // slots dropped
})

test('discard drops speculative writes, fires cleanups, leaves committed intact (step 5b)', () => {
  const name = signalNode('foo')
  const s = createScope(ROOT_SCOPE, 'speculative')
  const fired: string[] = []
  s.cleanups.push(() => fired.push('a'))
  s.cleanups.push(() => fired.push('b'))
  runInScope(s, undefined, () => writeValue(name, 'bar'))

  discard(s)
  expect(readValue(name)).toBe('foo')   // committed never moved
  expect(s.slots.size).toBe(0)          // speculative slots dropped
  expect(s.status).toBe('discarded')
  expect(fired).toEqual(['b', 'a'])     // cleanups fire LIFO
})

test('action commits its writes on normal return', () => {
  const name = signalNode('foo')
  action(() => writeValue(name, 'bar'))
  expect(readValue(name)).toBe('bar')
})

test('action discards its writes when the body throws (and rethrows)', () => {
  const name = signalNode('foo')
  expect(() =>
    action(() => {
      writeValue(name, 'bar')
      throw new Error('boom')
    }),
  ).toThrow('boom')
  expect(readValue(name)).toBe('foo') // rolled back
})
