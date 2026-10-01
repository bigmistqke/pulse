import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  computed,
  effect,
  Errored,
  flush,
  Loading,
  microtaskScheduler,
  render,
  setScheduler,
  signal,
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

/**
 * @canon spec-a-child-binding-leaves-the-pending-set-when-it-fails
 */
test('Loading wrapping Errored: a rejecting computed renders the error fallback, not a stuck spinner', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  render(
    () => (
      <Loading fallback={<p>loading</p>}>
        {() => (
          <Errored fallback={(error) => <p>{(error as Error).message}</p>}>
            {() => <span>{() => use(c)}</span>}
          </Errored>
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

/**
 * @canon spec-a-child-binding-leaves-the-pending-set-when-it-fails
 */
test('Errored wrapping Loading: a rejecting computed renders the error fallback and useLoading() returns to false', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  let pending!: ReturnType<typeof useLoading>

  render(
    () => (
      <Errored fallback={(error) => <p>{(error as Error).message}</p>}>
        {() => (
          <Loading fallback={<p>loading</p>}>
            {() => {
              pending = useLoading()
              return <span>{() => use(c)}</span>
            }}
          </Loading>
        )}
      </Errored>
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

/**
 * @canon spec-a-child-binding-leaves-the-pending-set-when-it-fails
 * @canon spec-a-catch-error-handler-is-called-for-each-throw-under-it
 */
test('Loading with catchError (no Errored): the rejection is caught and the loading fallback clears', async () => {
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
  // signal flipping false, the error signal parking, the settle-kick), and
  // catchError has no dedup collection, so it may see more than one call —
  // what matters here is that it sees the error at all.
  expect(caught.length).toBeGreaterThan(0)
  expect((caught[0] as Error).message).toBe('boom')
  // No <Errored> boundary means there is no fallback content to take the
  // loading fallback's place — but the fallback itself must clear.
  expect(target.textContent).toBe('')
})

/**
 * @canon spec-a-child-binding-leaves-the-pending-set-when-it-fails
 */
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

/**
 * @canon spec-a-reactive-prop-leaves-the-pending-set-when-it-fails
 */
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

/**
 * @canon spec-an-effect-is-not-coordinated-by-a-loading-boundary
 */
test('a suspended and then failing staged effect never makes its Loading pending, and its failure reaches catchError', async () => {
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
  // The effect is suspended, but the boundary does not wait on it.
  expect(pending()).toBe(false)
  expect(target.textContent).toBe('ok')

  await tick()
  flush()

  expect(caught.length).toBeGreaterThan(0)
  expect(pending()).toBe(false)
  expect(target.textContent).toBe('ok')
})

/**
 * @canon spec-a-failed-binding-leaves-the-pending-set
 */
test('a binding that suspends on a refresh and then fails clears the fallback and opens the gate for a held sibling', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [n, setN] = signal(0)
  const [source, setSource] = signal<string | Promise<string>>('first')
  const caught: unknown[] = []
  let pending!: ReturnType<typeof useLoading>

  render(
    () =>
      catchError(
        () => (
          <Loading fallback={<p>loading</p>}>
            {() => {
              pending = useLoading()
              return (
                <>
                  <span class="source">{() => use(source())}</span>
                  <span class="n">{() => use(n)}</span>
                </>
              )
            }}
          </Loading>
        ),
        (e) => caught.push(e),
      ) as Node,
    target,
  )
  flush()
  await tick()
  flush()
  expect(target.querySelector('.source')!.textContent).toBe('first')
  // The sibling's element is kept to read it while the fallback swaps it out.
  const sibling = target.querySelector('.n')!
  expect(sibling.textContent).toBe('0')

  // The binding suspends on a refresh, so the boundary shows its fallback,
  // and a sibling that called use has its next commit held at the gate.
  let reject!: (e: Error) => void
  setSource(new Promise<string>((_, r) => (reject = r)))
  flush()
  setN(1)
  flush()
  await tick()
  flush()
  expect(pending()).toBe(true)
  expect(target.textContent).toBe('loading')
  expect(sibling.textContent).toBe('0')

  // The suspended binding now fails for real. It is no longer pending, so
  // the boundary has nothing left in flight: the fallback clears and the
  // held sibling commit lands.
  reject(new Error('boom'))
  await tick()
  flush()

  expect((caught[0] as Error).message).toBe('boom')
  expect(pending()).toBe(false)
  expect(target.textContent).not.toContain('loading')
  expect(target.querySelector('.n')).toBe(sibling)
  expect(sibling.textContent).toBe('1')
})
