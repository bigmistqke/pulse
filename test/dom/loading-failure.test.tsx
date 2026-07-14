import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  computed,
  effect,
  Failed,
  flush,
  Loading,
  microtaskScheduler,
  render,
  setScheduler,
  syncScheduler,
  use,
  useLoading,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * A binding registers with the nearest `<Loading>` when it suspends (throws
 * `NotReadyYet`). If it later fails for real, it must leave that registration —
 * a failed binding is not a pending binding. Left unregistered, one failed
 * binding pins the boundary's gate shut forever, since the gate only opens
 * when nothing is registered as pending.
 */

test('Loading wrapping Failed: a rejecting computed renders the failure fallback, not a stuck spinner', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  render(
    () => (
      <Loading fallback={<p>loading</p>}>
        {() => (
          <Failed fallback={(error) => <p>{(error as Error).message}</p>}>
            {() => <span>{() => use(c)}</span>}
          </Failed>
        )}
      </Loading>
    ),
    target,
  )

  // A boundary nested inside another boundary needs a flush() before its
  // first render is observable under syncScheduler.
  flush()
  expect(target.textContent).toBe('loading')

  await tick()
  flush()

  expect(target.textContent).toBe('boom')
})

test('Failed wrapping Loading: a rejecting computed renders the failure fallback and useLoading() returns to false', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  let pending!: ReturnType<typeof useLoading>

  render(
    () => (
      <Failed fallback={(error) => <p>{(error as Error).message}</p>}>
        {() => (
          <Loading fallback={<p>loading</p>}>
            {() => {
              pending = useLoading()
              return <span>{() => use(c)}</span>
            }}
          </Loading>
        )}
      </Failed>
    ),
    target,
  )

  flush()
  expect(target.textContent).toBe('loading')
  expect(pending()).toBe(true)

  await tick()
  flush()

  expect(target.textContent).toBe('boom')
  expect(pending()).toBe(false)
})

test('Loading with catchError (no Failed): the rejection is caught and the loading fallback clears', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  const caught: unknown[] = []

  render(
    () =>
      catchError(
        () => (
          <Loading fallback={<p>loading</p>}>
            {() => <span>{() => use(c)}</span>}
          </Loading>
        ),
        (e) => caught.push(e),
      ) as Node,
    target,
  )

  flush()
  expect(target.textContent).toBe('loading')

  await tick()
  flush()

  // One rejection re-runs the consuming binding several times (the pending
  // signal flipping false, the failure signal parking, the settle-kick), and
  // catchError has no dedup collection, so it may see more than one call —
  // what matters here is that it sees the error at all.
  expect(caught.length).toBeGreaterThan(0)
  expect((caught[0] as Error).message).toBe('boom')
  // No <Failed> boundary means there is no fallback content to take the
  // loading fallback's place — but the fallback itself must clear.
  expect(target.textContent).toBe('')
})

test('a healthy sibling under the same Loading is not held hostage by a failed sibling', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const failing = computed(() => Promise.reject(new Error('boom')))
  let resolveOk!: (v: string) => void
  const okPromise = new Promise<string>((resolve) => { resolveOk = resolve })
  const caught: unknown[] = []

  render(
    () =>
      catchError(
        () => (
          <Loading fallback={<p>loading</p>}>
            {() => (
              <>
                <span>{() => use(failing)}</span>
                <span>{() => use(okPromise)}</span>
              </>
            )}
          </Loading>
        ),
        (e) => caught.push(e),
      ) as Node,
    target,
  )

  flush()
  expect(target.textContent).toBe('loading')

  resolveOk('healthy')
  await tick()
  flush()

  expect(caught.length).toBeGreaterThan(0)
  // The resolving sibling's commit must not be stranded behind a gate that
  // never opens because the failed sibling never left the pending set.
  expect(target.textContent).toBe('healthy')
})

test('a reactive prop that fails under Loading does not pin the boundary', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  const caught: unknown[] = []

  render(
    () =>
      catchError(
        () => (
          <Loading fallback={<p>loading</p>}>
            {() => <span prop:textContent={() => use(c)} />}
          </Loading>
        ),
        (e) => caught.push(e),
      ) as Node,
    target,
  )

  flush()
  expect(target.textContent).toBe('loading')

  await tick()
  flush()

  expect(caught.length).toBeGreaterThan(0)
  expect(target.textContent).toBe('')
})

test('a staged effect whose pipeline rejects under Loading does not pin the boundary', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const source = computed(() => Promise.reject(new Error('boom')))
  const caught: unknown[] = []
  let pending!: ReturnType<typeof useLoading>

  render(
    () =>
      catchError(
        () => (
          <Loading fallback={<p>loading</p>}>
            {() => {
              pending = useLoading()
              effect([() => use(source)], () => {})
              return <span>ok</span>
            }}
          </Loading>
        ),
        (e) => caught.push(e),
      ) as Node,
    target,
  )

  flush()
  expect(pending()).toBe(true)
  expect(target.textContent).toBe('loading')

  await tick()
  flush()

  expect(caught.length).toBeGreaterThan(0)
  expect(pending()).toBe(false)
  expect(target.textContent).toBe('ok')
})
