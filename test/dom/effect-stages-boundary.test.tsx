/**
 * Boundary integration tests for staged effect — verifies that commit defers
 * when inside a <Loading> boundary with a pending sibling, then flushes
 * atomically once all siblings settle.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { effect, flush, microtaskScheduler, setScheduler, syncScheduler } from '../../src/index'
import { Loading } from '../../src/dom/loading'
import { render } from '../../src/dom/render'
import { use } from '../../src/async'

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
