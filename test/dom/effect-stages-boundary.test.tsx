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
import { createSubOwner, disposeOwner, findBoundaryScope, getOwner, runWithOwner } from '../../src/owner'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

/**
 * @canon spec-an-effect-is-not-coordinated-by-a-loading-boundary
 */
test('a staged effect commits as soon as its stages resolve, though a sibling under the same Loading is suspended', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const seen: string[] = []
  let resolveStage!: (v: string) => void
  const pStage = new Promise<string>((r) => (resolveStage = r))
  let resolveSibling!: (v: string) => void
  const pSibling = new Promise<string>((r) => (resolveSibling = r))

  const dispose = render(
    () => (
      <Loading fallback={<p>loading</p>}>
        {() => {
          // A staged effect suspended on pStage: the boundary does not wait on it.
          effect([() => pStage], (v) => seen.push(v as string))
          // A sibling binding that suspends until pSibling settles: the boundary
          // does wait on it.
          return <span class="sib">{() => use(pSibling)}</span>
        }}
      </Loading>
    ),
    target,
  )

  // The stage resolves while the sibling still holds the gate: the effect
  // commits anyway, because no boundary coordinates it.
  resolveStage('stage!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  flush()
  expect(seen).toEqual(['stage!'])
  expect(target.textContent).toBe('loading')

  resolveSibling('sibling!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  flush()
  expect(target.textContent).toBe('sibling!')

  dispose()
})

