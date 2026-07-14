import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  computed,
  Failed,
  flush,
  Loading,
  microtaskScheduler,
  render,
  setScheduler,
  signal,
  syncScheduler,
  use,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * A failure is graph state, so the boundary that reads it is a SELECTION over that
 * state, not a stream of events. One rejection re-runs the consuming binding three
 * times (the pending signal flipping false, the failure signal parking, and the
 * effect's settle-kick), and each re-run re-reads the failed node and re-throws.
 * All three reports come from the same controller, so the collection holds ONE
 * entry and the fallback renders once.
 */
test('one rejection renders the fallback once, however many times the binding re-runs', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  let fallbackRenders = 0
  render(
    () => (
      <Failed
        fallback={(error) => {
          fallbackRenders++
          return <p>{(error as Error).message}</p>
        }}
      >
        {() => <span>{() => use(c)}</span>}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()

  expect(target.textContent).toBe('boom')
  expect(fallbackRenders).toBe(1)
})

/** The boundary is not a latch. It shows the fallback exactly while something under
 *  it is failed — so when the failure clears on its own, it returns to the subtree
 *  with no reset() call at all. */
test('the boundary unlatches itself when the failure clears', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [id, setId] = signal(1)
  const c = computed(() =>
    id() === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
  )

  render(
    () => (
      <Failed fallback={(error) => <p>{(error as Error).message}</p>}>
        {() => <span>{() => use(c)}</span>}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.textContent).toBe('boom')

  setId(2)
  await tick()
  flush()

  expect(target.textContent).toBe('ok')
})

/** The collection is a set of failed bindings. It empties only when ALL of them
 *  recover. */
test('two failed siblings render one fallback, which clears only when both recover', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [id, setId] = signal(1)
  const a = computed(() =>
    id() === 1 ? Promise.reject(new Error('a-failed')) : Promise.resolve('a-ok'),
  )
  const b = computed(() =>
    id() <= 2 ? Promise.reject(new Error('b-failed')) : Promise.resolve('b-ok'),
  )

  render(
    () => (
      <Failed fallback={() => <p>fallback</p>}>
        {() => (
          <div>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.textContent).toBe('fallback')

  // `a` recovers; `b` is still failed, so the collection is still non-empty.
  setId(2)
  await tick()
  flush()
  expect(target.textContent).toBe('fallback')

  // Now both are healthy.
  setId(3)
  await tick()
  flush()
  expect(target.textContent).toBe('a-okb-ok')
})

/** `<Failed>` and `catchError` are peers in one walk up the owner chain. The
 *  nearest one wins, so a `catchError` INSIDE a `<Failed>` intercepts first and the
 *  boundary never activates. */
test('a catchError nested inside <Failed> wins, and the boundary never activates', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  const caught: unknown[] = []

  render(
    () => (
      <Failed fallback={() => <p>fallback</p>}>
        {() =>
          catchError(
            () => <span>{() => use(c)}</span>,
            (e) => caught.push(e),
          ) as Node
        }
      </Failed>
    ),
    target,
  )

  await tick()
  flush()

  expect(caught.length).toBeGreaterThan(0)
  expect((caught[0] as Error).message).toBe('boom')
  expect(target.textContent).not.toBe('fallback')
})

/** Suspension is not a failure. A pending read routes to `<Loading>` and must never
 *  reach `<Failed>`. */
test('a pending read reaches <Loading>, never <Failed>', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let release!: (v: string) => void
  const c = computed(() => new Promise<string>((r) => (release = r)))

  render(
    () => (
      <Failed fallback={() => <p>failed</p>}>
        {() => (
          <Loading fallback={<p>loading</p>}>
            {() => <span>{() => use(c)}</span>}
          </Loading>
        )}
      </Failed>
    ),
    target,
  )

  flush()
  expect(target.textContent).toBe('loading')

  release('done')
  await tick()
  flush()

  expect(target.textContent).toBe('done')
})
