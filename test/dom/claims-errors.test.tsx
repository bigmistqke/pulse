import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  computed,
  Errored,
  flush,
  microtaskScheduler,
  render,
  setScheduler,
  syncScheduler,
  use,
  useErrored,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * @canon rule-boundary-state-is-looked-up-past-a-catch-error
 */
test('useErrored() inside a catchError reads the enclosing <Errored>, past the catchError', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const failing = computed(() => Promise.reject(new Error('boom')))
  let state!: ReturnType<typeof useErrored>
  const dispose = render(
    () => (
      <Errored>
        {() => (
          <div>
            <span>{() => use(failing)}</span>
            {
              catchError(
                () => {
                  state = useErrored()
                  return <i>{() => String(state.active())}</i>
                },
                () => {},
              ) as Node
            }
          </div>
        )}
      </Errored>
    ),
    target,
  )
  await tick()
  flush()
  expect(state.active()).toBe(true)
  expect((state.error() as Error).message).toBe('boom')
  expect(target.querySelector('i')!.textContent).toBe('true')
  dispose()
})
