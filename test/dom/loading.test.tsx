import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  flush,
  Loading,
  microtaskScheduler,
  onCleanup,
  render,
  setScheduler,
  Show,
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

test('synchronous loaded thunk renders immediately; pending stays false', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => <Loading initial={<p>init</p>}>{() => <span>hi</span>}</Loading>,
    target,
  )
  expect(target.textContent).toBe('hi')
  dispose()
})

test('pending use() initially renders `initial`', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => (
      <Loading initial={<p>loading…</p>}>
        {() => <span>{() => use(p)}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('loading…')
  dispose()
})

test('pending use() with no initial → renders fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => (
      <Loading fallback={<p>fb</p>}>
        {() => <span>{() => use(p)}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('fb')
  dispose()
})

test('pending use() with neither → renders nothing', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => <Loading>{() => <span>{() => use(p)}</span>}</Loading>,
    target,
  )
  expect(target.textContent).toBe('')
  dispose()
})

test('settled → loaded subtree rendered', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })
  const dispose = render(
    () => (
      <Loading initial={<p>loading…</p>}>
        {() => <span>{() => use(p)}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('loading…')
  resolveP('hello')
  await p
  flush()
  expect(target.textContent).toBe('hello')
  dispose()
})

test('subsequent pending with fallback → renders fallback', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })
  const [src, setSrc] = signal<string | Promise<string>>(p)
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>} fallback={<p>fb</p>}>
        {() => <span>{() => use(src())}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('init')
  resolveP('A')
  await p
  flush()
  expect(target.textContent).toBe('A')

  let resolveQ!: (v: string) => void
  const q = new Promise<string>((r) => { resolveQ = r })
  setSrc(q)
  expect(target.textContent).toBe('fb') // subsequent pending, fallback shown
  resolveQ('B')
  await q
  flush()
  expect(target.textContent).toBe('B')
  dispose()
})

test('subsequent pending without fallback → holds prior loaded subtree', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })
  const [src, setSrc] = signal<string | Promise<string>>(p)
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => <span>{() => use(src())}</span>}
      </Loading>
    ),
    target,
  )
  resolveP('A')
  await p
  flush()
  expect(target.textContent).toBe('A')

  const q = new Promise<string>(() => {}) // never settles
  setSrc(q)
  expect(target.textContent).toBe('A') // hold prior
  dispose()
})

test('two pending bindings: both must settle before loaded slot mounts', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveA!: (v: string) => void
  let resolveB!: (v: string) => void
  const a = new Promise<string>((r) => { resolveA = r })
  const b = new Promise<string>((r) => { resolveB = r })
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => (
          <>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
          </>
        )}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('init')
  resolveA('A')
  await a
  flush()
  expect(target.textContent).toBe('init') // b still pending
  resolveB('B')
  await b
  flush()
  expect(target.textContent).toBe('AB')
  dispose()
})

test('useLoading() inside subtree reflects pending state', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })

  function Header() {
    const pending = useLoading()
    return <Show when={pending} fallback={<i>idle</i>}>{() => <i>busy</i>}</Show>
  }

  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => (
          <>
            <Header/>
            <span>{() => use(p)}</span>
          </>
        )}
      </Loading>
    ),
    target,
  )
  resolveP('done')
  await p
  flush()
  expect(target.textContent).toContain('idle')
  expect(target.textContent).toContain('done')
  dispose()
})

test('non-NotReadyYet error in a binding inside Loading propagates to catchError', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const caught: unknown[] = []
  const [trigger, setTrigger] = signal(false)
  const dispose = render(
    () =>
      catchError(
        () => (
          <Loading initial={<p>init</p>}>
            {() => (
              <span>
                {() => {
                  if (trigger()) throw new Error('boom')
                  return 'ok'
                }}
              </span>
            )}
          </Loading>
        ),
        (e) => caught.push(e),
      ) as Node,
    target,
  )
  expect(target.textContent).toBe('ok')
  setTrigger(true)
  expect(caught.length).toBe(1)
  expect((caught[0] as Error).message).toBe('boom')
  dispose()
})

test('nested Loading: inner pending registers only with inner', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveOuter!: (v: string) => void
  let resolveInner!: (v: string) => void
  const outerP = new Promise<string>((r) => { resolveOuter = r })
  const innerP = new Promise<string>((r) => { resolveInner = r })

  const dispose = render(
    () => (
      <Loading initial={<p>outer-init</p>}>
        {() => (
          <>
            <span>{() => use(outerP)}</span>
            <Loading initial={<p>inner-init</p>}>
              {() => <span>{() => use(innerP)}</span>}
            </Loading>
          </>
        )}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('outer-init')
  resolveOuter('OUTER')
  await outerP
  flush()
  expect(target.textContent).toContain('OUTER')
  expect(target.textContent).toContain('inner-init')
  resolveInner('INNER')
  await innerP
  flush()
  expect(target.textContent).toContain('OUTER')
  expect(target.textContent).toContain('INNER')
  dispose()
})

test('disposing surrounding owner cascades to Loading', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => {
          onCleanup(() => { cleaned = true })
          return <span>x</span>
        }}
      </Loading>
    ),
    target,
  )
  expect(cleaned).toBe(false)
  dispose()
  expect(cleaned).toBe(true)
})
