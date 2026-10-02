import { expect, test } from 'vitest'
import { action, computed, from, isPending, peek, signal } from '../src/index'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick()
}

/** A derivation of `id` that counts its runs, and resolves a macrotask later. */
function fetchedUser() {
  const [id, setId] = signal(1)
  const requested: number[] = []
  const user = computed(() => {
    const current = id()
    requested.push(current)
    return tick().then(() => `user ${current}`)
  })
  return { setId, user, requested }
}

/**
 * @canon spec-a-sync-stage-takes-its-result-at-commit
 */
test('a sync derivation an action read takes its result at commit without running', () => {
  const [id, setId] = signal(1)
  const runs: number[] = []
  const label = computed(() => {
    runs.push(id())
    return `user ${id()}`
  })
  const seen: string[] = []

  action(() => {
    setId(2)
    seen.push(label())
  })

  expect(seen).toEqual(['user 2'])
  expect(label()).toBe('user 2')
  expect(runs).toEqual([1, 2]) // once at creation, once inside the action

  // The committed derivation still follows `id`.
  setId(3)
  expect(label()).toBe('user 3')
  expect(runs).toEqual([1, 2, 3])
})

/**
 * @canon spec-an-async-function-stage-takes-its-settled-result-at-commit
 */
test('an action that waited for an async derivation of its write makes one request', async () => {
  const { setId, user, requested } = fetchedUser()
  await ticks(2)
  expect(peek(user)).toBe('user 1')

  const seen: string[] = []
  const handle = action(function* () {
    setId(2)
    seen.push(yield* from(user))
  })
  await handle.settled
  await ticks(2)

  expect(seen).toEqual(['user 2'])
  expect(peek(user)).toBe('user 2')
  expect(requested).toEqual([1, 2])

  setId(3)
  await ticks(2)
  expect(peek(user)).toBe('user 3')
  expect(requested).toEqual([1, 2, 3])
})

/**
 * @canon spec-a-result-in-flight-at-commit-is-taken-over
 */
test('a request still in flight when its action commits becomes the committed run', async () => {
  const { setId, user, requested } = fetchedUser()
  await ticks(2)

  action(() => {
    setId(2)
    user() // starts the request for user 2; the action commits before it lands
  })

  expect(isPending(user)).toBe(true)
  expect(peek(user)).toBe('user 1')
  await ticks(2)

  expect(isPending(user)).toBe(false)
  expect(peek(user)).toBe('user 2')
  expect(requested).toEqual([1, 2])
})

/** A generator stage of `id` that counts its runs and pauses once. The code
 *  before the pause and the code after it each count their own runs. */
function generatedUser() {
  const [id, setId] = signal(1)
  const [suffix, setSuffix] = signal('!')
  const before: number[] = []
  const after: number[] = []
  const user = computed(function* () {
    const current = id()
    before.push(current)
    const raw: string = yield* from(tick().then(() => `user ${current}`))
    after.push(current)
    return `${raw}${suffix()}`
  })
  return { setId, setSuffix, user, before, after }
}

/**
 * @canon spec-a-generator-stage-read-in-a-speculation-gives-its-result
 */
test('an action reading a generator stage gets the value it returns, read inside the action', async () => {
  const { setId, setSuffix, user } = generatedUser()
  await ticks(3)

  let seen: unknown
  const handle = action(function* () {
    setId(2)
    setSuffix('?') // read by the stage after its pause
    seen = yield* from(user)
  })
  await handle.settled

  expect(seen).toBe('user 2?')
})

/**
 * @canon spec-a-generator-stage-takes-its-finished-result-at-commit
 */
test('a generator stage an action waited for takes its result at commit without running', async () => {
  const { setId, user, before } = generatedUser()
  await ticks(3)

  const handle = action(function* () {
    setId(2)
    yield* from(user)
  })
  await handle.settled
  await ticks(3)

  expect(peek(user)).toBe('user 2!')
  expect(before).toEqual([1, 2])
})

/**
 * @canon spec-a-paused-generator-at-commit-is-taken-over
 */
test('a generator stage paused when its action commits is resumed by the committed stage', async () => {
  const { setId, setSuffix, user, before, after } = generatedUser()
  await ticks(3)

  action(() => {
    setId(2)
    user() // starts the generator for 2; the action commits while it is paused
  })
  expect(isPending(user)).toBe(true)
  await ticks(3)

  expect(peek(user)).toBe('user 2!')
  expect(before).toEqual([1, 2]) // the code before the pause ran once for 2
  expect(after).toEqual([1, 2])

  // What it read after the pause is followed by the committed stage.
  setSuffix('?')
  await ticks(3)
  expect(peek(user)).toBe('user 2?')
})

/**
 * @canon spec-a-later-stage-takes-its-result-at-commit
 */
test('a later stage of a pipeline takes its result at commit without running', async () => {
  const [id, setId] = signal(1)
  const requested: number[] = []
  const user = computed(
    () => id() * 10,
    (n: number) => {
      requested.push(n)
      return tick().then(() => `user ${n}`)
    },
  )
  await ticks(2)

  const handle = action(function* () {
    setId(2)
    yield* from(user)
  })
  await handle.settled
  await ticks(2)

  expect(peek(user)).toBe('user 20')
  expect(requested).toEqual([10, 20])
})

/**
 * @canon spec-a-nested-commit-promotes-what-it-derived-to-its-parent
 */
test('a nested action hands what it derived to its parent, and the outer commit takes it', async () => {
  const { setId, user, requested } = fetchedUser()
  await ticks(2)

  let seenByParent: unknown
  const handle = action(function* () {
    const inner = action(function* () {
      setId(2)
      yield* from(user)
    })
    yield* from(inner.settled)
    seenByParent = yield* from(user)
  })
  await handle.settled
  await ticks(2)

  expect(seenByParent).toBe('user 2')
  expect(peek(user)).toBe('user 2')
  expect(requested).toEqual([1, 2])
})

/**
 * @canon spec-a-committed-derivation-takes-a-clean-result-without-running
 */
test('sync, async and generator stages in one pipeline, committed from a nested action, each run once', async () => {
  const [id, setId] = signal(1)
  const runs = { sync: [] as number[], async: [] as number[], generator: [] as number[] }
  const user = computed(
    () => {
      runs.sync.push(id())
      return id()
    },
    (n: number) => {
      runs.async.push(n)
      return tick().then(() => n * 10)
    },
    function* (n: number) {
      runs.generator.push(n)
      const label: string = yield* from(tick().then(() => `user ${n}`))
      return label
    },
  )
  await ticks(4)

  const handle = action(function* () {
    const inner = action(function* () {
      setId(2)
      yield* from(user)
    })
    yield* from(inner.settled)
  })
  await handle.settled
  await ticks(4)

  expect(peek(user)).toBe('user 20')
  expect(runs).toEqual({ sync: [1, 2], async: [1, 2], generator: [10, 20] })
})
