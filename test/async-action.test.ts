import { expect, test } from 'vitest'
import { action, committed, computed, read, signal } from '../src/index'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * TARGET BEHAVIOUR — async actions (not implemented yet; these are red).
 *
 * An action body may be a generator. The driver resumes it inside the action's
 * scope, so the speculation stays open across a `yield*` and writes made AFTER
 * the await are still speculative. The action commits when the body completes and
 * discards (rolling back every speculative write) when it throws.
 */

test('an async action holds the speculation open across the await and commits on success', async () => {
  const [name, setName] = signal('alice')
  const save = (v: string) => tick().then(() => v)

  const done = action(function* () {
    setName('bob') // optimistic write
    const saved: string = yield* read(save('bob')) // the mutation; scope stays open
    setName(`${saved}!`) // a write AFTER the await must still be speculative
  })

  // In flight: committed state is untouched.
  expect(committed(name)).toBe('alice')

  await done
  // Completed: every write in the body commits together, atomically.
  expect(committed(name)).toBe('bob!')
  expect(name()).toBe('bob!')
})

test('an async action rolls back every speculative write when the mutation fails', async () => {
  const [name, setName] = signal('alice')
  const save = () => tick().then<string>(() => Promise.reject(new Error('save failed')))

  const done = action(function* () {
    setName('bob')
    yield* read(save())
    setName('never') // unreachable
  })

  await expect(done).rejects.toThrow('save failed')
  // Discarded: the speculative writes vanish; committed state never moved.
  expect(name()).toBe('alice')
  expect(committed(name)).toBe('alice')
})

test('derived state follows the speculation across the await', async () => {
  const [n, setN] = signal(1)
  const doubled = computed(() => n() * 2)
  const save = () => tick()

  const done = action(function* () {
    setN(5)
    yield* read(save())
    // Resumed inside the scope: the derivation still sees the speculative value.
    expect(doubled()).toBe(10)
    expect(committed(doubled)).toBe(2)
  })

  await done
  expect(doubled()).toBe(10)
})

// ---- async (non-generator) bodies: the common write-then-await shape ----

test('an async body: the sync prefix is speculative and commits when the mutation resolves', async () => {
  const [name, setName] = signal('alice')
  const done = action(async () => {
    setName('bob') // sync prefix — runs under the scope
    expect(committed(name)).toBe('alice') // isolated
    await tick() // the mutation
  })
  expect(committed(name)).toBe('alice') // in flight — not committed yet
  await done
  expect(committed(name)).toBe('bob') // resolved → committed
})

test('an async body rolls back when the mutation rejects', async () => {
  const [name, setName] = signal('alice')
  const done = action(async () => {
    setName('bob')
    await tick().then(() => Promise.reject(new Error('save failed')))
  })
  await expect(done).rejects.toThrow('save failed')
  expect(name()).toBe('alice') // rolled back
  expect(committed(name)).toBe('alice')
})

// SHARP EDGE — documented behaviour, not a bug to fix.
//
// In an ASYNC body only the synchronous prefix runs under the scope. After the
// first `await` the async function has returned to us and the ambient scope has
// unwound, so the continuation runs with the scope back at root: a write there
// lands in COMMITTED state immediately, and the action's later commit then
// promotes the earlier speculative value on top of it — losing the write.
//
// Use a GENERATOR body when you need to write after awaiting (see the tests
// above): pulse drives those resumptions itself and re-enters the scope.
test('SHARP EDGE: a write after an await in an async body escapes the speculation', async () => {
  const [name, setName] = signal('alice')
  const done = action(async () => {
    setName('bob') // speculative
    await tick()
    setName('after') // NOT speculative — goes straight to committed state
  })
  await done
  // The post-await write hit committed state, then commit promoted 'bob' over it.
  expect(committed(name)).toBe('bob')
})

test('two concurrent async actions are isolated from each other', async () => {
  const [a, setA] = signal('a0')
  const [b, setB] = signal('b0')
  const slow = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const first = action(function* () {
    setA('a1')
    yield* read(slow(20))
  })
  const second = action(function* () {
    setB('b1')
    yield* read(slow(5))
  })

  await Promise.all([first, second])
  expect(committed(a)).toBe('a1')
  expect(committed(b)).toBe('b1')
})
