import { expect, test, vi } from 'vitest'
import { action, catchError, createRoot, from } from '../src/index'

/**
 * @canon spec-a-throwing-handler-passes-a-failed-action-on-with-the-handlers-error
 */
test('a catchError handler that throws passes a failed action on, and the boundary beyond receives the handler error', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const handled: unknown[] = []
  let handle!: ReturnType<typeof action>
  createRoot(() => {
    catchError(
      () => {
        handle = action(function* () {
          yield* from(Promise.reject(new Error('boom')))
        })
      },
      (e) => {
        handled.push(e)
        throw new Error('from handler')
      },
    )
  })
  await handle.settled
  const logged = spy.mock.calls.flat().map((arg) => (arg as Error)?.message)
  expect(handled.map((e) => (e as Error).message)).toEqual(['boom']) // the handler was called
  expect(logged).toContain('from handler') // the root's boundary claimed it next, with the handler's error
  expect(logged).not.toContain('boom')
  expect((handle.error() as Error).message).toBe('boom') // the handle keeps the action's own error
  spy.mockRestore()
})
