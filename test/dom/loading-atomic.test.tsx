import { afterEach, beforeEach, expect, test } from 'vitest'
import { flush, microtaskScheduler, render, setScheduler, signal, syncScheduler } from '../../src/index'
import { Loading } from '../../src/dom/loading'
import { findLoadingScope, getOwner, runWithOwner } from '../../src/owner'
import { use } from '../../src/async'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('scope gathers and flushes atomically: two throwing → both succeed → one flush', () => {
  const target = document.createElement('section')
  document.body.append(target)

  let scopeRef: ReturnType<typeof findLoadingScope> = null
  const commits: string[] = []

  const dispose = render(
    () => (
      <Loading>
        {() => {
          // Capture the boundary's scope from inside its owner subtree.
          scopeRef = findLoadingScope(getOwner())
          return <span>child</span>
        }}
      </Loading>
    ),
    target,
  )

  expect(scopeRef).not.toBeNull()
  const scope = scopeRef!

  const a = scope.register()
  const b = scope.register()
  a.report({ status: 'throwing' })
  b.report({ status: 'throwing' })

  expect(scope.pending()).toBe(true)
  expect(commits).toEqual([])

  // A becomes ready first — no flush yet (B still pending).
  a.report({ status: 'ready', commit: () => commits.push('A') })
  expect(scope.pending()).toBe(true)
  expect(commits).toEqual([])

  // B becomes ready — gate opens, both flush in one pass.
  b.report({ status: 'ready', commit: () => commits.push('B') })
  expect(commits).toEqual(['A', 'B'])
  expect(scope.pending()).toBe(false)

  dispose()
})

test('idle reports do not flush but contribute to pending while throwing', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let scopeRef: ReturnType<typeof findLoadingScope> = null
  const commits: string[] = []
  const dispose = render(
    () => (
      <Loading>
        {() => {
          scopeRef = findLoadingScope(getOwner())
          return <span>child</span>
        }}
      </Loading>
    ),
    target,
  )
  const scope = scopeRef!

  const a = scope.register() // a binding effect (no commit)
  const b = scope.register() // a reactive hole (commit)
  a.report({ status: 'throwing' })
  b.report({ status: 'throwing' })
  expect(scope.pending()).toBe(true)

  // a succeeds with 'idle' (its body already ran)
  a.report({ status: 'idle' })
  expect(scope.pending()).toBe(true) // b still throwing

  // b becomes ready — gate opens, only b's commit fires
  b.report({ status: 'ready', commit: () => commits.push('B') })
  expect(commits).toEqual(['B'])
  expect(scope.pending()).toBe(false)
  dispose()
})

test('unregister removes the binding from both sets', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let scopeRef: ReturnType<typeof findLoadingScope> = null
  const dispose = render(
    () => (
      <Loading>
        {() => {
          scopeRef = findLoadingScope(getOwner())
          return <span>child</span>
        }}
      </Loading>
    ),
    target,
  )
  const scope = scopeRef!

  const a = scope.register()
  const b = scope.register()
  a.report({ status: 'throwing' })
  b.report({ status: 'throwing' })
  expect(scope.pending()).toBe(true)
  a.unregister()
  expect(scope.pending()).toBe(true) // b still
  b.unregister()
  expect(scope.pending()).toBe(false)
  dispose()
})

test('two reactive children inside <Loading> commit atomically when their promises settle at different ticks', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let resolveA1: (v: string) => void = () => {}
  let resolveB1: (v: string) => void = () => {}
  const pA1 = new Promise<string>((r) => (resolveA1 = r))
  const pB1 = new Promise<string>((r) => (resolveB1 = r))

  const [srcA, setSrcA] = signal<string | Promise<string>>(pA1)
  const [srcB, setSrcB] = signal<string | Promise<string>>(pB1)

  const dispose = render(
    () => (
      <Loading initial={<p>loading</p>}>
        {() => (
          <div>
            <span class="a">{() => use(srcA())}</span>
            <span class="b">{() => use(srcB())}</span>
          </div>
        )}
      </Loading>
    ),
    target,
  )

  // Initial: both pending → show initial placeholder.
  expect(target.textContent).toBe('loading')

  // First load: resolve both.
  resolveA1('A1')
  resolveB1('B1')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  flush()
  expect(target.querySelector('.a')!.textContent).toBe('A1')
  expect(target.querySelector('.b')!.textContent).toBe('B1')

  // Second load (no fallback → hold-prior-tree). Introduce new promises.
  let resolveA2: (v: string) => void = () => {}
  let resolveB2: (v: string) => void = () => {}
  const pA2 = new Promise<string>((r) => (resolveA2 = r))
  const pB2 = new Promise<string>((r) => (resolveB2 = r))
  setSrcA(pA2)
  setSrcB(pB2)
  await new Promise((r) => queueMicrotask(() => r(undefined)))

  // Resolve A first; B still pending. With atomic-commit, span.a must retain
  // its old value ('A1') because the gate is still closed (B throwing).
  resolveA2('A2')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  expect(target.querySelector('.a')!.textContent).toBe('A1') // commit deferred
  expect(target.querySelector('.b')!.textContent).toBe('B1')

  // Resolve B; gate opens — both commit atomically.
  resolveB2('B2')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  expect(target.querySelector('.a')!.textContent).toBe('A2')
  expect(target.querySelector('.b')!.textContent).toBe('B2')

  dispose()
})
