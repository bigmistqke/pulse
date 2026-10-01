/**
 * A refresh asks the same question again while its answer stands, so a
 * loading boundary hears nothing of it.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  computed,
  flush,
  latest,
  Loading,
  microtaskScheduler,
  refresh,
  render,
  setScheduler,
  syncScheduler,
  useLoading,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * @canon spec-a-refresh-reports-to-no-loading-boundary
 */
test('a refresh brings back no placeholder and leaves isLoading as it was, then its answer shows', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const settlers: Array<(value: string) => void> = []
  const source = computed(() => new Promise<string>((resolve) => settlers.push(resolve)))
  const loadingSeen: boolean[] = []

  render(
    () => (
      <Loading initial={<p>initial</p>} fallback={<p>fallback</p>}>
        {() => {
          const loading = useLoading()
          return (
            <p>
              {() => {
                loadingSeen.push(loading())
                return latest(source) ?? ''
              }}
            </p>
          )
        }}
      </Loading>
    ),
    target,
  )
  flush()
  expect(target.textContent).toBe('initial') // a first load does show the placeholder

  settlers[0]('first')
  await tick()
  flush()
  expect(target.textContent).toBe('first')
  const before = loadingSeen.length

  refresh(source)
  await tick()
  flush()
  // The refresh is in flight: the region still shows its answer, and the
  // boundary reports nothing loading.
  expect(target.textContent).toBe('first')
  expect(loadingSeen.slice(before).every((loading) => loading === false)).toBe(true)

  settlers[1]('second')
  await tick()
  flush()
  expect(target.textContent).toBe('second')
  expect(loadingSeen.slice(before).every((loading) => loading === false)).toBe(true)
})
