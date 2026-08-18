import { expect, test } from 'vitest'
import { signal } from '../src/derived-signal'
import { latest, read, use } from '../src/async'
import { isPending } from '../src/pending'
import { onCleanup } from '../src/owner'

test('W2: a write replaces the value and the body does not re-run', () => {
  let runs = 0
  const [count, setCount] = signal(() => {
    runs++
    return 1
  })
  expect(count()).toBe(1)
  expect(runs).toBe(1)

  setCount(7)
  expect(count()).toBe(7)
  expect(runs).toBe(1) // the derivation did not run again
})

test('W2: an update function receives the last resolved value', () => {
  const [list, setList] = signal(() => ['a'])
  expect(list()).toEqual(['a'])
  setList((prev) => [...(prev ?? []), 'b'])
  expect(list()).toEqual(['a', 'b'])
})

test('W3: an update function receives the value an eagerly-run derivation produced', () => {
  let seen: unknown = 'not called'
  const [list, setList] = signal(() => ['a'])
  setList((prev) => {
    seen = prev
    return ['seeded']
  })
  expect(seen).toEqual(['a']) // it ran at creation, so it has a value
  expect(list()).toEqual(['seeded'])
})

test('W3: an update function receives undefined while nothing has resolved yet', () => {
  let seen: unknown = 'not called'
  const [list, setList] = signal(function* () {
    return yield* read(new Promise<string[]>(() => {}))
  })
  setList((prev) => {
    seen = prev
    return ['seeded']
  })
  expect(seen).toBeUndefined() // it ran at creation but suspended, so nothing resolved
})

test('W21: two writes in one tick chain, and the last one wins', () => {
  const [list, setList] = signal(() => ['a'])
  expect(list()).toEqual(['a'])
  setList((prev) => [...(prev ?? []), 'b'])
  setList((prev) => [...(prev ?? []), 'c'])
  expect(list()).toEqual(['a', 'b', 'c'])
})

test('the value form still works and is unchanged', () => {
  const [count, setCount] = signal(0)
  setCount(3)
  expect(count()).toBe(3)
  setCount((n) => n + 1)
  expect(count()).toBe(4)
})

test('a write into a multi-stage pipeline lands on the output', () => {
  const [n, setN] = signal(
    () => 2,
    (v: number) => v * 10,
  )
  expect(n()).toBe(20)
  setN(99)
  expect(n()).toBe(99)
})

test('a bare write into an asynchronously coloured stage keeps the read a promise', async () => {
  const [list, setList] = signal(function* () {
    return ['a']
  })

  // a generator stage publishes a promise, so the raw read is one
  expect(list()).toBeInstanceOf(Promise)
  expect(use(list)).toEqual(['a'])

  setList(['b'])

  // the write must not flip the shape a consumer sees
  expect(list()).toBeInstanceOf(Promise)
  expect(use(list)).toEqual(['b'])
})

test('a write into a synchronously coloured stage does not introduce a promise', () => {
  const [n, setN] = signal(() => 1)
  expect(n()).toBe(1)
  setN(2)
  expect(n()).toBe(2) // still bare, not a promise
})

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('W1: a write abandons the fetch in flight and it never publishes', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(new Promise<string[]>((r) => (resolveList = r)))
  })

  // start the first load and let it settle
  expect(isPending(todos)()).toBe(true)
  resolveList(['a'])
  await tick()
  expect(use(todos)).toEqual(['a'])

  // a refresh starts a second fetch
  setVersion(2)
  await tick()
  expect(isPending(todos)()).toBe(true)

  // the write abandons it
  setTodos(['a', 'saved'])
  expect(isPending(todos)()).toBe(false)
  expect(use(todos)).toEqual(['a', 'saved'])

  resolveList(['a', 'b'])
  await tick()
  expect(use(todos)).toEqual(['a', 'saved']) // the abandoned fetch published nothing
})

test('W13: abandoning a paused stage runs its cleanups', async () => {
  const aborted: string[] = []
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    const v = version()
    onCleanup(() => aborted.push(`run ${v}`))
    return yield* read(new Promise<string[]>(() => {}))
  })

  expect(isPending(todos)()).toBe(true)
  setTodos(['written'])
  expect(aborted).toEqual(['run 1'])
})

test('a cleanup fired by a write sees the value that was written', () => {
  const seen: unknown[] = []
  const [todos, setTodos] = signal(function* () {
    onCleanup(() => seen.push(latest(todos)))
    return yield* read(new Promise<string[]>(() => {}))
  })

  setTodos(['written'])
  expect(seen).toEqual([['written']])
})

test('W19: invalidating then writing in one tick makes no request at all', async () => {
  let requests = 0
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    requests++
    return yield* read(Promise.resolve(['from server']))
  })

  await tick()
  expect(use(todos)).toEqual(['from server'])
  expect(requests).toBe(1)

  setVersion(2)
  setTodos(['pushed'])
  await tick()

  expect(requests).toBe(1) // the queued run was withdrawn
  expect(use(todos)).toEqual(['pushed'])
})

test('W19: invalidating then writing with an update function also makes no request', async () => {
  let requests = 0
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    requests++
    return yield* read(Promise.resolve(['from server']))
  })

  await tick()
  expect(requests).toBe(1)

  setVersion(2)
  setTodos((prev) => [...(prev ?? []), 'pushed'])
  await tick()

  expect(requests).toBe(1) // the queued run was withdrawn before readPrev could reach it
  expect(latest(todos)).toEqual(['from server', 'pushed'])
})

test('W20: writing then invalidating in one tick lets the request win', async () => {
  let requests = 0
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    requests++
    return yield* read(Promise.resolve([`server ${requests}`]))
  })

  await tick()
  expect(use(todos)).toEqual(['server 1'])

  setTodos(['written'])
  setVersion(2)
  await tick()

  expect(requests).toBe(2) // nothing was queued when the write landed
  expect(use(todos)).toEqual(['server 2'])
})

test('W9: a write abandons a fetch that is in a middle stage', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
    (server: string[]) => server.filter((t) => t !== 'done'),
  )

  expect(isPending(todos)()).toBe(true)
  setTodos(['written'])
  expect(isPending(todos)()).toBe(false)

  resolveList(['from', 'server'])
  await tick()
  expect(use(todos)).toEqual(['written']) // the middle stage published nothing
})

test('W10: a stage whose request was abandoned refetches when the tail next needs it', async () => {
  let requests = 0
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [showAll, setShowAll] = signal(false)

  const [todos, setTodos] = signal(
    () => version(),
    function* (v: number) {
      requests++
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
    (server: string[]) => (showAll() ? server : server.filter((t) => t !== 'done')),
  )

  expect(isPending(todos)()).toBe(true)
  resolveList(['keep', 'done'])
  await tick()
  expect(use(todos)).toEqual(['keep'])
  expect(requests).toBe(1)

  setVersion(2) // starts a second request
  await tick()
  expect(requests).toBe(2)

  setTodos(['written']) // abandons it — left needing recomputation, not clean
  expect(use(todos)).toEqual(['written'])

  // A dependency of the TAIL itself changes. Per scenario W4 this already
  // supersedes the write on its own, regardless of anything upstream — the
  // question this scenario is actually asking is whether the abandoned
  // upstream stage, left needing recomputation rather than clean, gets pulled
  // into a fresh recompute when the tail runs, or stays stuck serving data for
  // a version the pipeline has already moved past.
  setShowAll(true)
  await tick()

  // not stuck: the abandoned stage restarted
  expect(requests).toBe(3)
  expect(isPending(todos)()).toBe(true)

  resolveList(['fresh', 'done'])
  await tick()
  // the pipeline converges on real version-2 data once the reload settles
  expect(use(todos)).toEqual(['fresh', 'done'])
})

test('W11: a later change to the abandoned stage own dependency restarts it', async () => {
  let requests = 0
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)

  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      requests++
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
    (server: string[]) => server,
  )

  resolveList(['first'])
  await tick()
  expect(requests).toBe(1)

  setVersion(2)
  await tick()
  setTodos(['written'])
  expect(isPending(todos)()).toBe(false)

  setVersion(3)
  await tick()
  expect(requests).toBe(3)
  expect(isPending(todos)()).toBe(true)
  expect(latest(todos)).toEqual(['written']) // held while reloading

  resolveList(['third'])
  await tick()
  expect(use(todos)).toEqual(['third'])
})

test('W8: a write behaves the same when the fetch is in the tail', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
  )

  expect(isPending(todos)()).toBe(true)
  setTodos(['written'])
  expect(isPending(todos)()).toBe(false)

  resolveList(['from server'])
  await tick()
  expect(latest(todos)).toEqual(['written'])
})

test('W12: a write abandons every stage that has work, and resuming reissues both', async () => {
  let sessionRequests = 0
  let listRequests = 0
  let resolveSession: (v: { id: number }) => void = () => {}
  let resolveList: (v: string[]) => void = () => {}

  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      sessionRequests++
      return yield* read(new Promise<{ id: number }>((r) => (resolveSession = r)))
    },
    function* () {
      listRequests++
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
  )

  // the first stage is fetching and the second mirrors its suspension
  expect(sessionRequests).toBe(1)
  expect(isPending(todos)()).toBe(true)

  setTodos(['written'])
  expect(isPending(todos)()).toBe(false)

  resolveSession({ id: 1 })
  await tick()
  expect(listRequests).toBe(0) // the abandoned first stage published nothing
  expect(latest(todos)).toEqual(['written'])

  // a later change resumes the whole chain, which costs both requests
  setVersion(2)
  await tick()
  expect(sessionRequests).toBe(2)
  resolveSession({ id: 2 })
  await tick()
  expect(listRequests).toBe(1)
})
