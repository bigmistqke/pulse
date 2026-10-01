/**
 * What a boundary does with its own children: what goes wrong while it builds
 * them stays in its region, and a function among them runs inside it.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  Errored,
  flush,
  Loading,
  microtaskScheduler,
  render,
  setScheduler,
  syncScheduler,
  use,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

function mount(view: () => unknown): HTMLElement {
  const target = document.createElement('section')
  document.body.append(target)
  render(view as () => Node, target)
  return target
}

/**
 * @canon spec-a-throw-while-a-boundary-builds-its-children-stays-in-its-region
 */
test('a component that throws in its body while <Errored> builds it shows the fallback instead of escaping', () => {
  function Throws(): Node {
    throw new Error('in the body')
  }
  let thrown: unknown = null
  let target!: HTMLElement
  try {
    target = mount(() => (
      <Errored fallback={(error) => <p>caught: {(error as Error).message}</p>}>
        <Throws />
      </Errored>
    ))
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeNull()
  expect(target.textContent).toBe('caught: in the body')
})

/**
 * @canon spec-a-throw-while-a-boundary-builds-its-children-stays-in-its-region
 */
test('a failure while <Loading> builds its children reaches the <Errored> above it, and a retry builds them again', () => {
  let attempts = 0
  const target = mount(() => (
    <Errored
      fallback={(error, reset) => (
        <button on:click={reset}>caught: {(error as Error).message}</button>
      )}
    >
      <Loading>
        {() => {
          attempts++
          if (attempts === 1) throw new Error('first build')
          return <p>built</p>
        }}
      </Loading>
    </Errored>
  ))
  flush()
  expect(target.textContent).toBe('caught: first build')

  target.querySelector('button')!.click()
  flush()
  expect(attempts).toBe(2)
  expect(target.textContent).toBe('built')
})

/**
 * @canon spec-a-throw-while-a-boundary-builds-its-children-stays-in-its-region
 */
test('a suspension while <Loading> builds its children shows its fallback, and the children are built once it settles', async () => {
  let resolve!: (value: string) => void
  const data = new Promise<string>((r) => (resolve = r))
  let builds = 0
  const target = mount(() => (
    <Loading fallback={<p>loading</p>}>
      {() => {
        builds++
        const value = use(data)
        return <p>{value}</p>
      }}
    </Loading>
  ))
  flush()
  expect(target.textContent).toBe('loading')

  resolve('ready')
  await tick()
  flush()
  expect(target.textContent).toBe('ready')
  expect(builds).toBe(2)
})

/**
 * @canon spec-a-function-a-boundary-receives-runs-inside-it
 */
test('a function handed to an inner <Loading> through a variable suspends that <Loading>, not the one around it', async () => {
  let resolve!: (value: string) => void
  const data = new Promise<string>((r) => (resolve = r))
  const content = () => use(data)
  const target = mount(() => (
    <Loading fallback={<p>outer</p>}>
      <div>
        <Loading fallback={<p>inner</p>}>{content}</Loading>
      </div>
    </Loading>
  ))
  flush()
  expect(target.textContent).toBe('inner')

  resolve('ready')
  await tick()
  flush()
  expect(target.textContent).toBe('ready')
})
