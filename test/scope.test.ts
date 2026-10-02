import { expect, test } from 'vitest'
import { createScope, chainFor, writeSlot, readSlot, chainMatch, linkEdge, edgesToFire, closeScopeEdges, ROOT_KIND, ROOT_SCOPE, DIRTY, getCurrentScope, getCurrentTracker, runInScope, signalNode, computedNode, readValue, writeValue, commit, discard, action, onSettled, type Scope, type Node, type Slot, type Edge } from '../src/scope'
import { read as r3Read, setSignal as r3SetSignal, type Signal as R3Signal } from 'r3'

/**
 * @canon spec-a-new-scope-starts-open-and-empty
 */
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

/**
 * @canon spec-a-new-scope-starts-open-and-empty
 */
test('a child scope links to its parent and registers in the parent children', () => {
  const root = createScope(undefined, 'owner')
  const child = createScope(root, 'speculative')
  expect(child.parent).toBe(root)
  expect(root.children.has(child)).toBe(true)
})

/**
 * @canon spec-a-scope-chain-runs-from-the-scope-to-the-root
 */
test('chainFor walks parents most-specific to terminal', () => {
  const root = createScope(undefined, 'owner')
  const outer = createScope(root, 'speculative')
  const inner = createScope(outer, 'speculative')
  expect(chainFor(inner)).toEqual([inner, outer, root])
  expect(chainFor(root)).toEqual([root])
})

const sigNode = (): Node => ({ subs: new Set() })

/**
 * @canon spec-a-write-records-its-node-for-promotion
 */
test('writeSlot stores a slot on the scope and records the write', () => {
  const root = createScope(undefined, 'owner')
  const name = sigNode()
  const slot: Slot = { recipe: () => 'foo', cached: 'foo', deps: [], node: name }
  writeSlot(name, root, slot)
  expect(root.slots.get(name)).toBe(slot)
  expect(root.writeSet.has(name)).toBe(true)
})

/**
 * @canon spec-a-read-takes-the-nearest-slot-in-the-chain
 */
test('readSlot falls through the chain to the nearest slot', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  writeSlot(name, root, { recipe: () => 'foo', cached: 'foo', deps: [], node: name })
  expect(readSlot(name, s)?.cached).toBe('foo')
  expect(readSlot(sigNode(), s)).toBeUndefined()
})

/**
 * @canon spec-a-read-takes-the-nearest-slot-in-the-chain
 */
test('a more-specific slot shadows an ancestor slot', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  writeSlot(name, root, { recipe: () => 'foo', cached: 'foo', deps: [], node: name })
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [], node: name })
  expect(readSlot(name, s)?.cached).toBe('bar')
  expect(readSlot(name, root)?.cached).toBe('foo')
})

/**
 * @canon spec-a-scope-reads-through-its-chain
 */
test('a read takes the nearest write up its chain, and committed state when the chain has none', () => {
  const n = signalNode('committed')
  const upper = computedNode(() => readValue(n).toUpperCase())
  const outer = createScope(ROOT_SCOPE, 'speculative')
  const inner = createScope(outer, 'speculative')
  const innermost = createScope(inner, 'speculative')
  const unrelated = createScope(ROOT_SCOPE, 'speculative')
  const readIn = (s: Scope) => runInScope(s, undefined, () => readValue(n))

  runInScope(outer, undefined, () => writeValue(n, 'outer'))
  expect(readIn(innermost)).toBe('outer') // two scopes up the chain
  runInScope(inner, undefined, () => writeValue(n, 'inner'))
  expect(readIn(innermost)).toBe('inner') // the nearer write wins over the farther one
  expect(runInScope(innermost, undefined, () => readValue(upper))).toBe('INNER') // a recipe reads through the chain too
  expect(readIn(outer)).toBe('outer') // a write below a scope is not in its chain
  expect(readIn(unrelated)).toBe('committed') // no slot in the chain: falls through
  writeValue(n, 'committed again')
  expect(readIn(unrelated)).toBe('committed again') // falls through to committed state as it is now
  expect(readIn(innermost)).toBe('inner')
})

/**
 * @canon spec-chain-match-decides-whether-a-write-reaches-a-link
 */
test('chainMatch fires when writeScope is in the target chain and unshadowed', () => {
  const root = createScope(undefined, 'owner')
  const name = sigNode()
  const consumerSlot: Slot = { recipe: undefined, cached: undefined, deps: [], node: sigNode() }
  const edge: Edge = { source: name, target: consumerSlot, targetScope: root }
  expect(chainMatch(edge, root)).toBe(true)
})

/**
 * @canon spec-chain-match-decides-whether-a-write-reaches-a-link
 */
test('chainMatch does NOT fire when writeScope is outside the target chain', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  const consumerSlot: Slot = { recipe: undefined, cached: undefined, deps: [], node: sigNode() }
  const edge: Edge = { source: name, target: consumerSlot, targetScope: root }
  expect(chainMatch(edge, s)).toBe(false)
})

/**
 * @canon spec-chain-match-decides-whether-a-write-reaches-a-link
 */
test('chainMatch does NOT fire when a more-specific scope shadows the write', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [], node: name })
  const consumerSlot: Slot = { recipe: undefined, cached: undefined, deps: [], node: sigNode() }
  const edge: Edge = { source: name, target: consumerSlot, targetScope: s }
  expect(chainMatch(edge, root)).toBe(false)
  expect(chainMatch(edge, s)).toBe(true)
})

/**
 * @canon spec-a-link-is-indexed-on-its-source-and-held-by-its-scope
 */
test('linkEdge indexes on the source and records on the target scope', () => {
  const root = createScope(undefined, 'owner')
  const name = sigNode()
  const target: Slot = { recipe: undefined, cached: undefined, deps: [], node: sigNode() }
  const edge = linkEdge(name, target, root)
  expect(name.subs.has(edge)).toBe(true)
  expect(root.edges.has(edge)).toBe(true)
  expect(target.deps).toContain(edge)
})

/**
 * @canon spec-a-write-fires-only-the-links-that-match
 */
test('edgesToFire fixes the doubleName break: write under S fires the S-scoped edge', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  writeSlot(name, root, { recipe: () => 'foo', cached: 'foo', deps: [], node: name })
  const doubleNameSlotInS: Slot = { recipe: undefined, cached: 'foofoo', deps: [], node: sigNode() }
  linkEdge(name, doubleNameSlotInS, s)
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [], node: name })
  const fired = edgesToFire(name, s)
  expect(fired.map((e) => e.target)).toContain(doubleNameSlotInS)
})

/**
 * @canon spec-a-write-fires-only-the-links-that-match
 */
test('edgesToFire does not fire consumers outside the write chain', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  const rootConsumer: Slot = { recipe: undefined, cached: undefined, deps: [], node: sigNode() }
  linkEdge(name, rootConsumer, root)
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [], node: name })
  const fired = edgesToFire(name, s)
  expect(fired.map((e) => e.target)).not.toContain(rootConsumer)
})

/**
 * @canon spec-a-speculative-write-reaches-only-consumers-in-its-chain
 */
test('a speculative write dirties only consumers whose chain holds the writer and no nearer slot', () => {
  const src = signalNode(1)
  const derived = computedNode(() => readValue(src) * 10)
  const writer = createScope(ROOT_SCOPE, 'speculative')
  const child = createScope(writer, 'speculative') // writer is in its chain
  const shadowing = createScope(writer, 'speculative') // writer is in its chain, but it has its own slot for src
  const sibling = createScope(ROOT_SCOPE, 'speculative') // writer is not in its chain
  runInScope(shadowing, undefined, () => writeValue(src, 5))
  // each scope reads derived into a slot of its own (writer last, so the others do not fall through to it)
  for (const s of [child, shadowing, sibling, writer]) runInScope(s, undefined, () => readValue(derived))

  runInScope(writer, undefined, () => writeValue(src, 2))

  expect(writer.slots.get(derived)!.cached).toBe(DIRTY)
  expect(child.slots.get(derived)!.cached).toBe(DIRTY)
  expect(shadowing.slots.get(derived)!.cached).toBe(50) // shadowed: not reached
  expect(sibling.slots.get(derived)!.cached).toBe(10) // outside the chain: not reached
  expect(r3Read(derived.backing!)).toBe(10) // committed state: not reached
  expect(runInScope(child, undefined, () => readValue(derived))).toBe(20)
})

/**
 * @canon spec-closing-a-scope-unlinks-it-from-its-sources
 */
test('closeScopeEdges unlinks the scope edges from their sources and drops slots', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  const targetInS: Slot = { recipe: undefined, cached: 'x', deps: [], node: sigNode() }
  const edge = linkEdge(name, targetInS, s)
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [], node: name })
  s.readSet.add(name)
  closeScopeEdges(s)
  expect(name.subs.has(edge)).toBe(false)
  expect(s.edges.size).toBe(0)
  expect(s.slots.has(name)).toBe(false)
  expect(s.writeSet.has(name)).toBe(false)
  expect(s.readSet.has(name)).toBe(false)
  expect(root.children.has(s)).toBe(false)
})

/**
 * @canon spec-entering-a-scope-restores-the-previous-one-even-on-a-throw
 */
test('current scope defaults to ROOT_SCOPE, tracker to undefined', () => {
  expect(getCurrentScope()).toBe(ROOT_SCOPE)
  expect(getCurrentTracker()).toBeUndefined()
})

/**
 * @canon spec-entering-a-scope-restores-the-previous-one-even-on-a-throw
 */
test('runInScope pushes and restores the scope (and tracker) even on throw', () => {
  const s = createScope(ROOT_SCOPE, 'speculative')
  const slot: Slot = { recipe: undefined, cached: undefined, deps: [], node: sigNode() }
  runInScope(s, slot, () => {
    expect(getCurrentScope()).toBe(s)
    expect(getCurrentTracker()).toBe(slot)
  })
  expect(getCurrentScope()).toBe(ROOT_SCOPE)
  expect(getCurrentTracker()).toBeUndefined()
  expect(() => runInScope(s, slot, () => { throw new Error('x') })).toThrow('x')
  expect(getCurrentScope()).toBe(ROOT_SCOPE) // restored despite throw
})

/**
 * @canon spec-a-signal-node-is-backed-by-an-r3-signal
 */
test('signalNode wraps an r3 signal holding the committed value', () => {
  const n = signalNode(5)
  expect(n.subs.size).toBe(0)
  expect(n.backing).toBeDefined()
  expect(r3Read(n.backing!)).toBe(5)
})

/**
 * @canon spec-a-computed-node-carries-its-recipe-on-an-r3-computed
 */
test('computedNode carries the recipe as defaultRecipe and an r3 computed backing', () => {
  const n = computedNode(() => 7)
  expect(n.defaultRecipe).toBeDefined()
  expect(r3Read(n.backing!)).toBe(7)
})

/**
 * @canon spec-a-committed-read-and-write-go-through-r3
 */
test('read/write with no active speculation go through r3 (committed)', () => {
  const n = signalNode(0)
  expect(readValue(n)).toBe(0)      // ambient scope is ROOT_SCOPE
  writeValue(n, 5)
  expect(readValue(n)).toBe(5)      // committed value updated via r3
})

/**
 * @canon spec-r3-holds-only-committed-values
 */
test('r3 keeps the committed value while a speculation holds another, and a root read or write goes to r3', () => {
  const n = signalNode(1)
  const doubled = computedNode(() => readValue(n) * 2)
  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => writeValue(n, 2))
  expect(runInScope(s, undefined, () => readValue(doubled))).toBe(4)
  // the speculation has its values, but r3 holds only the committed ones
  expect(r3Read(n.backing!)).toBe(1)
  expect(r3Read(doubled.backing!)).toBe(2)
  // a write with the root ambient lands in r3 at once
  writeValue(n, 3)
  expect(r3Read(n.backing!)).toBe(3)
  // a read with the root ambient answers what r3 holds, with no copy kept on the pulse side
  r3SetSignal(n.backing as R3Signal<number>, 5)
  expect(readValue(n)).toBe(5)
  expect(readValue(doubled)).toBe(10)
  discard(s)
})

/**
 * @canon spec-a-speculative-write-stays-out-of-committed-state
 */
test('a speculative write is isolated from committed state and visible under its scope', () => {
  const n = signalNode('foo')
  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => writeValue(n, 'bar'))
  // committed untouched:
  expect(readValue(n)).toBe('foo')
  // visible under S:
  expect(runInScope(s, undefined, () => readValue(n))).toBe('bar')
})

/**
 * @canon spec-a-speculative-write-dirties-what-derives-from-it
 */
test('a speculative write marks matching downstream speculative slots dirty', () => {
  const name = signalNode('foo')
  const s = createScope(ROOT_SCOPE, 'speculative')
  // a downstream slot in S that depends on `name`:
  const derivedSlot: Slot = { recipe: undefined, cached: 'stale', deps: [], node: sigNode() }
  linkEdge(name, derivedSlot, s)
  runInScope(s, undefined, () => writeValue(name, 'bar'))
  expect(derivedSlot.cached).toBe(DIRTY) // dirtied (cached dropped)
})

/**
 * @canon spec-a-slot-caches-undefined-like-any-value
 */
test('a slot whose recipe returns undefined is cached, not recomputed on each read', () => {
  let runs = 0
  const node = computedNode(() => {
    runs++
    return undefined
  })
  runs = 0 // ignore any eager evaluation at node creation
  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => {
    readValue(node)
    readValue(node)
    readValue(node)
  })
  expect(runs).toBe(1) // undefined is a real value; the slot memoizes it
})

/**
 * @canon spec-a-slot-caches-undefined-like-any-value
 */
test('a slot holding undefined still recomputes after a write dirties it', () => {
  const src = signalNode(1)
  let runs = 0
  const node = computedNode(() => {
    runs++
    readValue(src)
    return undefined
  })
  runs = 0
  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => {
    readValue(node) // runs -> 1
    readValue(node) // memoized, still 1
    writeValue(src, 2) // dirties node's slot
    readValue(node) // dirty -> recompute, runs -> 2
  })
  expect(runs).toBe(2)
})

/**
 * @canon spec-a-speculative-read-recomputes-into-a-slot-of-its-scope
 */
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

/**
 * @canon spec-speculative-derivation-is-pulled-on-read
 */
test('under a speculation a write runs no recipe; the next read recomputes into the slot', () => {
  const src = signalNode(1)
  let runs = 0
  const derived = computedNode(() => {
    runs++
    return readValue(src) * 10
  })
  const s = createScope(ROOT_SCOPE, 'speculative')
  expect(runInScope(s, undefined, () => readValue(derived))).toBe(10)
  runs = 0

  runInScope(s, undefined, () => writeValue(src, 2))
  expect(runs).toBe(0) // the write ran nothing, neither the slot's recipe nor r3's
  expect(s.slots.get(derived)!.cached).toBe(DIRTY) // it only marked the slot

  expect(runInScope(s, undefined, () => readValue(derived))).toBe(20)
  expect(runs).toBe(1) // the read recomputed it once
  expect(s.slots.get(derived)!.cached).toBe(20) // into the slot of s
  expect(r3Read(derived.backing!)).toBe(10) // committed derivation untouched
})

/**
 * @canon spec-a-speculation-reads-its-own-writes
 */
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

/**
 * @canon spec-a-recompute-replaces-its-links
 */
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

/**
 * @canon spec-outside-a-speculation-a-write-commits-at-once
 */
test('a committed computed reacts to a committed signal write (no speculation)', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  expect(readValue(doubleName)).toBe('foofoo')
  writeValue(name, 'bar')          // committed write (ambient is ROOT_SCOPE)
  expect(readValue(doubleName)).toBe('barbar') // committed computed recomputed
})

/**
 * @canon spec-a-commit-promotes-every-write-at-once
 */
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

/**
 * @canon spec-a-discard-leaves-no-trace
 * @canon spec-settle-callbacks-run-newest-first-and-in-isolation
 */
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

/**
 * @canon spec-a-commit-promotes-every-write-at-once
 */
test('action commits its writes on normal return', () => {
  const name = signalNode('foo')
  action(() => writeValue(name, 'bar'))
  expect(readValue(name)).toBe('bar')
})

/**
 * @canon spec-a-discard-leaves-no-trace
 */
test('action discards its writes when the body throws', async () => {
  const name = signalNode('foo')
  const handle = action(() => {
    writeValue(name, 'bar')
    throw new Error('boom')
  })
  expect(readValue(name)).toBe('foo') // rolled back, synchronously
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  expect((handle.error() as Error).message).toBe('boom')
})

/**
 * @canon spec-nesting-makes-actions-share-fate
 */
test('G2: inner action promotes to outer, outer promotes to ROOT', () => {
  const x = signalNode('x0')
  const y = signalNode('y0')
  action(() => {
    writeValue(x, 'x1')                 // outer speculative write
    action(() => writeValue(y, 'y1'))   // inner commits → promotes y to OUTER
    // still inside outer: both x and y are the outer scope's speculative state
    expect(readValue(x)).toBe('x1')
    expect(readValue(y)).toBe('y1')
    // committed world not yet touched:
    // (readValue outside the action would show x0/y0)
  })
  // outer committed → both reach ROOT
  expect(readValue(x)).toBe('x1')
  expect(readValue(y)).toBe('y1')
})

/**
 * @canon spec-nesting-makes-actions-share-fate
 */
test('G3: inner commits, outer discards → nothing reaches committed', async () => {
  const y = signalNode('y0')
  const handle = action(() => {
    action(() => writeValue(y, 'y1')) // inner commits to outer
    throw new Error('outer fails')     // outer discards → y1 dropped with it
  })
  expect(readValue(y)).toBe('y0')
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
})

/**
 * @canon spec-nesting-makes-actions-share-fate
 */
test('G4: inner discards, outer continues and commits', () => {
  const x = signalNode('x0')
  const y = signalNode('y0')
  action(() => {
    try {
      action(() => {
        writeValue(y, 'y1')
        throw new Error('inner fails')  // inner discards → y1 dropped
      })
    } catch {
      // swallow inner error; outer continues
    }
    writeValue(x, 'x1')
  })
  expect(readValue(x)).toBe('x1') // outer committed
  expect(readValue(y)).toBe('y0') // inner's write never survived
})

/**
 * @canon spec-a-dirty-derived-result-is-dropped-at-commit
 */
test('committing a scope where a computed was only read does not promote/corrupt the computed', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => {
    readValue(doubleName)       // speculative READ of the computed → read-populated slot
    writeValue(name, 'bar')     // speculative WRITE of the signal → writeSet
  })
  // doubleName must NOT be in the writeSet (read-populated → readSet only):
  expect(s.writeSet.has(doubleName as unknown as Node)).toBe(false)
  commit(s)
  // signal promoted, computed intact and reactive (not overwritten by r3SetSignal):
  expect(readValue(name)).toBe('bar')
  expect(readValue(doubleName)).toBe('barbar')
})

/**
 * @canon spec-a-commit-promotes-what-the-speculation-derived
 */
test('a commit promotes what the speculation wrote and drops what it only read', () => {
  const written = signalNode(0)
  const onlyRead = signalNode(0)
  const derived = computedNode(() => readValue(onlyRead) * 10)
  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => {
    writeValue(written, 1)
    readValue(onlyRead)
    readValue(derived) // a slot of s caches 0
  })
  writeValue(onlyRead, 5) // committed state moves on while s is open

  commit(s)

  expect(readValue(written)).toBe(1) // promoted
  expect(readValue(onlyRead)).toBe(5) // not set back to what s read
  expect(readValue(derived)).toBe(50) // derived by r3, not the 0 that s cached
  expect(s.slots.size).toBe(0)
  expect(s.edges.size).toBe(0)
  expect(onlyRead.subs.size).toBe(0)
})

/**
 * @canon spec-a-speculation-announces-how-it-closed
 */
test('onSettled fires with committed when the scope commits', () => {
  const s = createScope(ROOT_SCOPE, 'speculative')
  const seen: string[] = []
  runInScope(s, undefined, () => onSettled((outcome) => seen.push(outcome)))
  commit(s)
  expect(seen).toEqual(['committed'])
})

/**
 * @canon spec-a-speculation-announces-how-it-closed
 */
test('onSettled fires with discarded when the scope is discarded', () => {
  const s = createScope(ROOT_SCOPE, 'speculative')
  const seen: string[] = []
  runInScope(s, undefined, () => onSettled((outcome) => seen.push(outcome)))
  discard(s)
  expect(seen).toEqual(['discarded'])
})

/**
 * @canon spec-settle-callbacks-run-newest-first-and-in-isolation
 */
test('onSettled fires each callback once, in last-in-first-out order', () => {
  const s = createScope(ROOT_SCOPE, 'speculative')
  const order: number[] = []
  runInScope(s, undefined, () => {
    onSettled(() => order.push(1))
    onSettled(() => order.push(2))
  })
  commit(s)
  expect(order).toEqual([2, 1])
})

/**
 * @canon spec-speculation-only-calls-refuse-to-run-outside-one
 */
test('onSettled throws when called with no active speculative scope', () => {
  expect(() => onSettled(() => {})).toThrow()
})

/**
 * @canon spec-settle-callbacks-run-newest-first-and-in-isolation
 */
test('a throwing settle callback does not strand the scope or block siblings', () => {
  const s = createScope(ROOT_SCOPE, 'speculative')
  const fired: string[] = []
  runInScope(s, undefined, () => {
    onSettled(() => fired.push('a'))
    onSettled(() => {
      throw new Error('boom')
    })
    onSettled(() => fired.push('c'))
  })
  expect(() => commit(s)).not.toThrow()
  expect(fired).toEqual(['c', 'a']) // LIFO; the throwing middle callback is isolated
  expect(s.status).toBe('committed') // commit completed despite the throw
})
