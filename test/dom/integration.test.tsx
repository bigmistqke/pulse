import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  flush,
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

test('use-throw inside a binding holds the previous DOM (stale-but-stable)', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let resolveFirst!: (v: string) => void
  const first = new Promise<string>((r) => { resolveFirst = r })
  const [value, setValue] = signal<string | Promise<string>>(first)

  const dispose = render(
    () => <div>{() => use(value())}</div>,
    target,
  )

  // Initial render: signal holds a pending promise, binding suspends — empty.
  expect(target.textContent).toBe('')

  // Settle: write-back flips signal to the resolved value; binding re-runs.
  resolveFirst('hello')
  await first
  flush()
  expect(target.textContent).toBe('hello')

  // Set a new pending promise: the binding suspends again, but holds 'hello'.
  let resolveSecond!: (v: string) => void
  const second = new Promise<string>((r) => { resolveSecond = r })
  setValue(second)
  expect(target.textContent).toBe('hello') // stale-but-stable

  resolveSecond('world')
  await second
  flush()
  expect(target.textContent).toBe('world')

  dispose()
})

test('a throw inside a reactive binding is caught by an enclosing catchError', () => {
  const target = document.createElement('section')
  document.body.append(target)

  const caught: unknown[] = []
  const [trigger, setTrigger] = signal(false)

  const dispose = render(() => {
    return catchError(
      () => (
        <div>
          {() => {
            if (trigger()) throw new Error('boom')
            return 'safe'
          }}
        </div>
      ),
      (e) => caught.push(e),
    ) as Node
  }, target)

  expect(target.textContent).toBe('safe')
  setTrigger(true)
  expect(caught.length).toBe(1)
  expect((caught[0] as Error).message).toBe('boom')

  dispose()
})

test('dispose tears down nested catchError children', () => {
  const target = document.createElement('section')
  document.body.append(target)

  const [count, setCount] = signal(0)
  let runs = 0

  const dispose = render(() => {
    return catchError(
      () => (
        <div>
          {() => {
            runs++
            return String(count())
          }}
        </div>
      ),
      () => {},
    ) as Node
  }, target)

  expect(runs).toBe(1)
  setCount(1)
  expect(runs).toBe(2)
  dispose()
  setCount(2)
  expect(runs).toBe(2) // disposed; no further runs
  expect(target.children.length).toBe(0)
})
