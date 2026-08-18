import { expect, test } from 'vitest'
import { signal } from '../src/derived-signal'
import { latest, read, use } from '../src/async'
import { isPending } from '../src/pending'
import { onCleanup } from '../src/owner'
import { failure } from '../src/failure'
import { action } from '../src/scope'
import { effect } from '../src/effect'

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

test('W5: a write clears a parked failure on a single stage', async () => {
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(Promise.reject(new Error('offline')) as Promise<string[]>)
  })

  await tick()
  expect(failure(todos)).toBeInstanceOf(Error)

  setTodos(['pushed'])
  expect(failure(todos)).toBeNull()
  expect(use(todos)).toEqual(['pushed'])
})

test('W5: a write clears a failure parked on an earlier stage', async () => {
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      return yield* read(Promise.reject(new Error('offline')) as Promise<string[]>)
    },
    (server: string[]) => server,
  )

  await tick()
  expect(failure(todos)).toBeInstanceOf(Error)

  setTodos(['pushed'])
  expect(failure(todos)).toBeNull() // the query walks upstream
  expect(use(todos)).toEqual(['pushed'])
})

test('W5: a write clears the failure through more than one never-resolved stage', async () => {
  // A regression test. An earlier version of the failure-clearing fix adopted
  // a rejected upstream as a stage's own new failure whenever that stage had
  // never resolved anything of its own. With two such stages between the
  // rejection and the tail, each independently rediscovered and re-parked
  // the same rejection the moment the pipeline was next read, which poisoned
  // every stage downstream of it — including the tail, which does have a
  // written value — through the ordinary unshielded-throw path. A write must
  // stay cleared regardless of how many never-resolved stages sit in between.
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      return yield* read(Promise.reject(new Error('offline')) as Promise<string[]>)
    },
    (server: string[]) => server, // never independently resolves
    (server: string[]) => server, // the tail
  )

  await tick()
  expect(failure(todos)).toBeInstanceOf(Error)

  setTodos(['pushed'])
  expect(failure(todos)).toBeNull()
  expect(use(todos)).toEqual(['pushed'])
})

test('W6: a written promise reports as pending and then resolves', async () => {
  const [todos, setTodos] = signal(function* () {
    return yield* read(Promise.resolve(['a']))
  })
  await tick()
  expect(use(todos)).toEqual(['a'])

  let resolveAdd: (v: string[]) => void = () => {}
  setTodos(new Promise<string[]>((r) => (resolveAdd = r)))

  expect(isPending(todos)()).toBe(true)
  expect(latest(todos)).toEqual(['a']) // the tolerant read degrades to the prior value

  resolveAdd(['a', 'saved'])
  await tick()
  expect(isPending(todos)()).toBe(false)
  expect(use(todos)).toEqual(['a', 'saved'])
})

test('W6: an update function sees the value from before a written promise settles', async () => {
  const [todos, setTodos] = signal(function* () {
    return yield* read(Promise.resolve(['a']))
  })
  await tick()

  setTodos(new Promise<string[]>(() => {}))
  let seen: unknown = 'not called'
  setTodos((prev) => {
    seen = prev
    return ['replaced']
  })
  expect(seen).toEqual(['a']) // the last value that actually resolved
})

test('W7: a dependency change supersedes a written promise that has not settled', async () => {
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    const v = version()
    return yield* read(Promise.resolve([`server ${v}`]))
  })
  await tick()
  expect(use(todos)).toEqual(['server 1'])

  let resolveWrite: (v: string[]) => void = () => {}
  setTodos(new Promise<string[]>((r) => (resolveWrite = r)))
  expect(isPending(todos)()).toBe(true)

  setVersion(2)
  await tick()
  expect(use(todos)).toEqual(['server 2'])

  resolveWrite(['from the write'])
  await tick()
  expect(use(todos)).toEqual(['server 2']) // the superseded write published nothing
})

test('W6: a rejected written promise parks as a failure', async () => {
  const [todos, setTodos] = signal(function* () {
    return yield* read(Promise.resolve(['a']))
  })
  await tick()

  setTodos(Promise.reject(new Error('save failed')))
  await tick()
  expect(failure(todos)).toBeInstanceOf(Error)
  expect(latest(todos)).toEqual(['a'])
})

test('W14: a write inside an action is invisible until it commits', async () => {
  const [todos, setTodos] = signal(function* () {
    return yield* read(Promise.resolve(['a']))
  })
  await tick()

  const seenInside: unknown[] = []
  await action(function* () {
    setTodos(['a', 'walk'])
    seenInside.push(use(todos))
    yield* read(Promise.resolve(null))
  })

  expect(seenInside).toEqual([['a', 'walk']])
  expect(use(todos)).toEqual(['a', 'walk'])
})

test('W15: a discarded action leaves the reload alive', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(new Promise<string[]>((r) => (resolveList = r)))
  })

  resolveList(['a'])
  await tick()
  resolveList = () => {}
  setVersion(2)
  await tick()
  expect(isPending(todos)()).toBe(true)

  await expect(
    action(function* () {
      setTodos(['a', 'walk'])
      yield* read(Promise.reject(new Error('save failed')))
    }),
  ).rejects.toThrow('save failed')

  // the write rolled back and the reload was never abandoned
  expect(isPending(todos)()).toBe(true)
  resolveList(['a', 'b'])
  await tick()
  expect(use(todos)).toEqual(['a', 'b'])
})

test('W16: cancelling waits until the value reaches the committed world', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(new Promise<string[]>((r) => (resolveList = r)))
  })
  resolveList(['a'])
  await tick()
  resolveList = () => {}
  setVersion(2)
  await tick()

  await expect(
    action(function* () {
      action(() => setTodos(['inner']))
      yield* read(Promise.reject(new Error('outer failed')))
    }),
  ).rejects.toThrow('outer failed')

  // the inner commit only promoted to the outer scope, which then rolled back
  expect(isPending(todos)()).toBe(true)
})

test('W17: a reload that lands while an action is open is replaced at commit', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(new Promise<string[]>((r) => (resolveList = r)))
  })
  resolveList(['a'])
  await tick()

  let resolveSave: (v: null) => void = () => {}
  resolveList = () => {}
  setVersion(2)
  await tick()

  const running = action(function* () {
    setTodos(['a', 'walk'])
    yield* read(new Promise<null>((r) => (resolveSave = r)))
  })

  resolveList(['a', 'b']) // the reload lands while the action is open
  await tick()
  expect(use(todos)).toEqual(['a', 'b']) // visible outside the action

  resolveSave(null)
  await running
  expect(use(todos)).toEqual(['a', 'walk']) // replaced at commit
})

test('a queued recompute survives a write inside a discarded action', async () => {
  // A regression test for the withdrawal loop's scope gate. Withdrawing a
  // queued recompute is only safe once a write is known to be committed —
  // withdrawing it eagerly, before the action that wrote had a chance to roll
  // back, would permanently lose a recompute an unrelated dependency change
  // had already queued, if that action then discarded.
  let requests = 0
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    const v = version()
    requests++
    return yield* read(Promise.resolve([`v${v}`]))
  })
  await tick()
  expect(requests).toBe(1)

  setVersion(2) // queues a recompute

  await expect(
    action(function* () {
      setTodos(['written'])
      yield* read(Promise.reject(new Error('fail')))
    }),
  ).rejects.toThrow('fail')

  // the action rolled back, so the write never took effect — the queued
  // recompute for version 2 must still run rather than having been withdrawn
  await tick()
  expect(requests).toBe(2)
  expect(use(todos)).toEqual(['v2'])
})

test('writing a promise inside an action does not trigger a fresh recompute', async () => {
  // Covers the isPromise(value) branch of publishValue under the same
  // conditions Defect 1 was about — the bare-value branch is exercised by
  // W14-W17 and the queued-recompute regression test, but all of those write
  // a bare value; this is the sibling branch, reached only when the caller
  // passes a promise directly to the setter, which none of those exercise.
  //
  // Defect 1's fresh-recompute symptom would show up as `requests` climbing
  // past 1, since the stray recompute it triggered built a whole new promise
  // from scratch. The pending flag itself is not asserted here: it belongs to
  // applyWriteEffects, which this task's own design defers until commit, so
  // it stays false the whole time the action is open — asserting it true
  // here would be testing something the design does not promise.
  let requests = 0
  const [todos, setTodos] = signal(function* () {
    requests++
    return yield* read(Promise.resolve(['a']))
  })
  await tick()
  expect(requests).toBe(1)

  await action(function* () {
    setTodos(Promise.resolve(['a', 'walk']))
    yield* read(Promise.resolve(null))
  })
  await tick()

  expect(requests).toBe(1)
  expect(use(todos)).toEqual(['a', 'walk'])
})

test('W22: a write from inside the derivation own body does not raise', async () => {
  // A write here cancels every stage's run, including this one's own — the
  // re-entrancy guard exists so that does not mean calling a generator's
  // return method on the generator that is currently calling it, which
  // raises. This is not observable as a throw or a wrong value on its own:
  // without the guard, discarding a still-running generator still raises
  // internally, but the raise is caught and immediately overwritten by the
  // write's own clearFailure call, which runs moments later in the same
  // pass — so it never surfaces here. What breaks silently instead is the
  // generator's normal completion bookkeeping: the driver's own "the
  // generator finished, run its cleanups" step is skipped, because
  // discarding it early already cleared the field that step checks. A
  // cleanup registered before the self-write is what catches that.
  const cleanups: string[] = []
  const [todos, setTodos] = signal(function* () {
    onCleanup(() => cleanups.push('ran'))
    const list = yield* read(Promise.resolve<string[]>([]))
    if (list.length === 0) {
      setTodos(['seeded'])
      return ['seeded']
    }
    return list
  })

  await tick()
  expect(use(todos)).toEqual(['seeded'])
  expect(cleanups).toEqual(['ran'])
})

test('W4: a dependency change after a write takes the derivation back over', async () => {
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    const v = version()
    return yield* read(Promise.resolve([`server ${v}`]))
  })
  await tick()

  setTodos(['written'])
  expect(use(todos)).toEqual(['written'])

  setVersion(2)
  expect(latest(todos)).toEqual(['written']) // held while it reloads
  await tick()
  expect(use(todos)).toEqual(['server 2'])
})

test('a read from inside an effect while an earlier stage is waiting to reload', async () => {
  // Rewritten from the brief's original, which asserted the write survives
  // showAll's change — that assertion was never coherent. showAll is a
  // dependency of the TAIL's own body, so per W4 the write is already
  // superseded the moment it changes, regardless of anything upstream. What
  // this scenario is actually responsible for proving is the same thing W10
  // proves through a direct read: an abandoned upstream stage, left needing
  // recomputation rather than clean, genuinely refetches when something
  // pulls it up to date — here, an effect's own re-run rather than a direct
  // read — instead of staying stuck serving data for a version the pipeline
  // has already moved past.
  let resolveList: (v: string[]) => void = () => {}
  let requests = 0
  const [version, setVersion] = signal(1)
  const [showAll, setShowAll] = signal(false)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      requests++
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
    (server: string[]) => (showAll() ? server : server.slice(0, 1)),
  )
  resolveList(['a', 'b'])
  await tick()
  expect(requests).toBe(1)

  const seen: unknown[] = []
  effect(() => {
    seen.push(latest(todos))
  })
  await tick()

  setVersion(2) // starts a second request
  await tick()
  expect(requests).toBe(2)

  setTodos(['written']) // abandons it — left needing recomputation, not clean
  await tick()
  expect(requests).toBe(2) // still abandoned, nothing pulled it yet

  setShowAll(true) // a dependency of the tail itself — supersedes the write per W4
  await tick()

  // not stuck: the abandoned stage was pulled up to date and restarted
  expect(requests).toBe(3)
  expect(isPending(todos)()).toBe(true)

  resolveList(['fresh', 'refetched'])
  await tick()
  // the pipeline converges on real data once the reload settles
  expect(seen.at(-1)).toEqual(['fresh', 'refetched'])
})

test('a discarded action does not leave the change gate describing a rolled-back value', async () => {
  // The write inside the action (7) has to equal what a LATER, genuine
  // derivation run resolves to, or this proves nothing: the change gate
  // compares by Object.is, and if the discarded write's stale value never
  // coincides with a real result, the gate always sees a difference and
  // republishes regardless of whether the deferral is working. Version 2
  // is engineered to resolve to the same 7 the rolled-back write used.
  const [version, setVersion] = signal(1)
  const [count, setCount] = signal(function* () {
    const v = version()
    return yield* read(Promise.resolve(v === 1 ? 5 : 7))
  })
  await tick()
  expect(use(count)).toBe(5)

  await expect(
    action(function* () {
      setCount(7)
      yield* read(Promise.reject(new Error('nope')))
    }),
  ).rejects.toThrow('nope')

  expect(use(count)).toBe(5) // rolled back correctly

  setVersion(2) // the derivation genuinely resolves to 7 this time
  await tick()
  // must actually publish 7 — a gate still describing the rolled-back write
  // as the current value would wrongly treat this as no change and leave
  // the signal stuck showing 5
  expect(use(count)).toBe(7)
})

test('an update function that throws leaves a queued run intact', async () => {
  // Found during the final whole-branch review, not by any scenario: at the
  // root, a queued run is withdrawn before the update function is called (it
  // has to be — computing the value can itself stabilize the graph, which is
  // the same hazard publishing has). If the update function throws instead
  // of producing a value, no write happens, but the withdrawal already ran
  // on the assumption that one was about to. Without correcting for that,
  // the dependency change that queued the run is lost with nothing left to
  // notice it — a permanently stuck pipeline, reached through an unrelated
  // exception rather than through any write.
  let requests = 0
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    const v = version()
    requests++
    return yield* read(Promise.resolve([`v${v}`]))
  })
  await tick()
  expect(requests).toBe(1)

  setVersion(2) // queues a recompute
  expect(() =>
    setTodos(() => {
      throw new Error('updater failed')
    }),
  ).toThrow('updater failed')

  // the queued recompute for version 2 must still run
  await tick()
  expect(requests).toBe(2)
  expect(use(todos)).toEqual(['v2'])
})
