/**
 * Boundary integration tests for staged effect — verifies that commit defers
 * when inside a <Loading> boundary with a pending sibling, then flushes
 * atomically once all siblings settle.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { effect, flush, microtaskScheduler, setScheduler, syncScheduler } from '../../src/index'
import { Loading } from '../../src/dom/loading'
import { render } from '../../src/dom/render'
import { track, use } from '../../src/async'
import { createSubOwner, disposeOwner, findLoadingScope, getOwner, runWithOwner } from '../../src/owner'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('staged effect commit defers when inside <Loading> with a pending sibling', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const seen: string[] = []
  let resolveStage!: (v: string) => void
  const pStage = new Promise<string>((r) => (resolveStage = r))
  let resolveSibling!: (v: string) => void
  const pSibling = new Promise<string>((r) => (resolveSibling = r))

  const dispose = render(
    () => (
      <Loading>
        {() => {
          // Start the staged effect that fires commit on pStage settle.
          effect([() => pStage], (v) => seen.push(v as string))
          // Sibling DOM binding that throws until pSibling settles.
          return <span class="sib">{() => use(pSibling)}</span>
        }}
      </Loading>
    ),
    target,
  )

  // Resolve stage FIRST — commit should defer because sibling still throws.
  resolveStage('stage!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  flush()
  expect(seen).toEqual([]) // deferred — gate not open

  // Resolve sibling — gate opens; deferred commit fires.
  resolveSibling('sibling!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  flush()
  expect(seen).toEqual(['stage!'])

  dispose()
})

test('disposal cancels deferred commits queued in scope', async () => {
  // This test exercises the `scope.deferOrCommit` path: the effect's pipeline
  // resolves WITHOUT throwing (no controller), but the boundary is pending, so
  // commit is queued in deferredCommits[]. Disposing the effect before the gate
  // opens must make that queued thunk a no-op.
  //
  // To ensure the boundary is pending BEFORE the effect runs (so scope.pending()
  // is true when the commit is routed), we manually register a fake controller
  // that reports 'throwing' before creating the effect.
  const target = document.createElement('section')
  document.body.append(target)
  const commits: string[] = []
  let disposeInnerRoot: (() => void) | null = null
  let openGate!: () => void

  // pStage must be resolved in the WeakMap BEFORE the effect runs, so the
  // pipeline never throws and the effect never acquires a controller.
  const pStage = Promise.resolve('should-not-fire')
  track(pStage) // register with track's WeakMap
  await new Promise((r) => queueMicrotask(() => r(undefined))) // let .then() flip to 'fulfilled'

  const dispose = render(
    () => (
      <Loading>
        {() => {
          const currentOwner = getOwner()
          const scope = findLoadingScope(currentOwner)!

          // Put boundary in pending state BEFORE the effect runs.
          const fakeController = scope.register()
          fakeController.report({ status: 'throwing' })
          openGate = () => fakeController.report({ status: 'idle' })

          // Create a sub-owner so the effect can be disposed independently.
          const innerOwner = createSubOwner(currentOwner)
          disposeInnerRoot = () => disposeOwner(innerOwner)
          runWithOwner(innerOwner, () => {
            // pipeline is pre-resolved → no throw → no controller → deferOrCommit path
            effect([() => pStage], (v) => commits.push(v as string))
          })

          return <span>placeholder</span>
        }}
      </Loading>
    ),
    target,
  )

  // At this point: effect ran, pipeline resolved, scope.pending()===true (due to
  // fakeController), commit was queued via deferOrCommit into deferredCommits[].
  expect(commits).toEqual([]) // deferred, gate not open

  // Dispose the effect's owner — its deferred commit must become a no-op.
  disposeInnerRoot!()

  // Open the gate — flushAll fires deferredCommits[], including the disposed
  // effect's thunk, which must bail due to the disposed flag.
  openGate()
  flush()
  expect(commits).toEqual([]) // disposed effect's commit must not have fired

  dispose()
})
