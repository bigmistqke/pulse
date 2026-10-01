import { afterEach, beforeEach, expect, test } from 'vitest'
import { Show } from '../../src/dom/show'
import { Match, Switch } from '../../src/dom/switch'
import {
  flush,
  microtaskScheduler,
  onCleanup,
  render,
  setScheduler,
  signal,
  syncScheduler,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

/**
 * @canon spec-show-renders-its-children-when-truthy-and-its-fallback-otherwise
 */
test('truthy when mounts function child with narrowed value', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [user] = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => <Show when={user()}>{(u) => <span>{u.name}</span>}</Show>,
    target,
  )
  expect(target.textContent).toBe('Ada')
  dispose()
})

/**
 * @canon spec-show-renders-its-children-when-truthy-and-its-fallback-otherwise
 */
test('falsy when mounts fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [user] = signal<{ name: string } | null>(null)
  const dispose = render(
    () => (
      <Show when={user()} fallback={<p>none</p>}>
        {(u) => <span>{u.name}</span>}
      </Show>
    ),
    target,
  )
  expect(target.textContent).toBe('none')
  dispose()
})

/**
 * @canon spec-a-pending-condition-reads-as-falsy
 */
test('pending Promise<T> when → fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<{ name: string }>(() => {})
  const [user] = signal<{ name: string } | Promise<{ name: string }>>(p)
  const dispose = render(
    () => (
      <Show when={user()} fallback={<p>loading</p>}>
        {(u) => <span>{u.name}</span>}
      </Show>
    ),
    target,
  )
  expect(target.textContent).toBe('loading')
  dispose()
})

/**
 * @canon spec-show-rebuilds-only-when-truthiness-flips
 */
test('truthy → truthy with different value preserves subtree (children not re-called)', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let calls = 0
  const [user, setUser] = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => (
      <Show when={user()}>
        {(u) => { calls++; return <span>{u.name}</span> }}
      </Show>
    ),
    target,
  )
  expect(calls).toBe(1)
  setUser({ name: 'Babbage' })
  expect(calls).toBe(1) // not re-called
  dispose()
})

/**
 * @canon spec-show-rebuilds-only-when-truthiness-flips
 */
test('truthy → falsy disposes branch sub-owner', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const [user, setUser] = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => (
      <Show when={user()} fallback={<p>none</p>}>
        {(u) => {
          onCleanup(() => { cleaned = true })
          return <span>{u.name}</span>
        }}
      </Show>
    ),
    target,
  )
  expect(cleaned).toBe(false)
  setUser(null)
  expect(cleaned).toBe(true)
  dispose()
})

/**
 * @canon spec-show-rebuilds-only-when-truthiness-flips
 */
test('falsy → truthy mounts fresh children invocation', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let calls = 0
  const [user, setUser] = signal<{ name: string } | null>(null)
  const dispose = render(
    () => (
      <Show when={user()} fallback={<p>none</p>}>
        {(u) => { calls++; return <span>{u.name}</span> }}
      </Show>
    ),
    target,
  )
  expect(calls).toBe(0)
  expect(target.textContent).toBe('none')
  setUser({ name: 'Ada' })
  expect(calls).toBe(1)
  expect(target.textContent).toBe('Ada')
  dispose()
})

/**
 * @canon spec-show-rebuilds-only-when-truthiness-flips
 */
test('disposing surrounding owner disposes active branch', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const [cond] = signal(true)
  const dispose = render(
    () => (
      <Show when={cond()}>
        {() => {
          onCleanup(() => { cleaned = true })
          return <span>hi</span>
        }}
      </Show>
    ),
    target,
  )
  expect(cleaned).toBe(false)
  dispose()
  expect(cleaned).toBe(true)
})

/**
 * @canon spec-a-branch-is-rebuilt-only-when-the-choice-changes
 */
test('Show and Switch keep the DOM of the branch they built while the same branch wins, and build new DOM when another wins', () => {
  const target = document.createElement('section')
  document.body.append(target)
  // One signal decides both components. Values 1 and 2 pick the same side of
  // each; 0 picks the other side of each.
  const [count, setCount] = signal(1)
  const dispose = render(
    () => (
      <div>
        <Show when={count()} fallback={<i data-testid="show">zero</i>}>
          {() => <b data-testid="show">nonzero</b>}
        </Show>
        <Switch fallback={<i data-testid="switch">none</i>}>
          <Match when={count() === 0}>{() => <u data-testid="switch">zero</u>}</Match>
          <Match when={count() > 0}>{() => <b data-testid="switch">positive</b>}</Match>
        </Switch>
      </div>
    ),
    target,
  )
  const showNode = () => target.querySelector('[data-testid="show"]')
  const switchNode = () => target.querySelector('[data-testid="switch"]')

  const showFirst = showNode()
  const switchFirst = switchNode()
  expect(showFirst?.textContent).toBe('nonzero')
  expect(switchFirst?.textContent).toBe('positive')

  // The deciding value changes, but each component picks the same branch:
  // the very same nodes stay in the page.
  setCount(2)
  expect(showNode()).toBe(showFirst)
  expect(switchNode()).toBe(switchFirst)

  // A different branch wins in each: both build new DOM for it.
  setCount(0)
  expect(showNode()?.textContent).toBe('zero')
  expect(switchNode()?.textContent).toBe('zero')
  const showZero = showNode()
  const switchZero = switchNode()

  // Back to the first side: the branch is built again, not the old nodes
  // brought back, because the choice changed.
  setCount(3)
  expect(showNode()?.textContent).toBe('nonzero')
  expect(switchNode()?.textContent).toBe('positive')
  expect(showNode()).not.toBe(showFirst)
  expect(switchNode()).not.toBe(switchFirst)
  expect(showZero?.isConnected).toBe(false)
  expect(switchZero?.isConnected).toBe(false)
  dispose()
})

/**
 * @canon spec-show-renders-its-children-when-truthy-and-its-fallback-otherwise
 */
test('static (non-function) child renders when truthy', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [cond] = signal(true)
  const dispose = render(
    () => <Show when={cond()}><p>shown</p></Show>,
    target,
  )
  expect(target.textContent).toBe('shown')
  dispose()
})
