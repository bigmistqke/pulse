import { afterEach, beforeEach, expect, test } from 'vitest'
import { flush, microtaskScheduler, render, setScheduler, signal, syncScheduler } from '../../src/index'
import { Loading } from '../../src/dom/loading'
import { findLoadingScope, getOwner, runWithOwner } from '../../src/owner'

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
