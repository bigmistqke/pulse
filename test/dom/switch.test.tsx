import { afterEach, beforeEach, expect, test } from 'vitest'
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
 * @canon spec-switch-renders-the-first-truthy-match
 */
test('first truthy Match wins', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={false}><p>a</p></Match>
        <Match when={true}><p>b</p></Match>
        <Match when={true}><p>c</p></Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('b')
  dispose()
})

/**
 * @canon spec-switch-renders-the-first-truthy-match
 */
test('no Match truthy → fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={false}><p>a</p></Match>
        <Match when={null}><p>b</p></Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('none')
  dispose()
})

/**
 * @canon spec-switch-renders-the-first-truthy-match
 */
test('non-Match children inside Switch are ignored', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => (
      <Switch fallback={<p>fallback</p>}>
        {'stray text'}
        <Match when={true}><p>b</p></Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('b')
  dispose()
})

/**
 * @canon spec-switch-renders-the-first-truthy-match
 */
test('Match function child receives narrowed value', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [user] = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={user()}>{(u) => <span>{u.name}</span>}</Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('Ada')
  dispose()
})

/**
 * @canon spec-switch-rebuilds-only-when-the-winning-match-changes
 */
test('winner change disposes old branch sub-owner', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [which, setWhich] = signal<'a' | 'b' | 'none'>('a')
  let aCleaned = false
  let bCleaned = false
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={() => which() === 'a'}>{() => {
          onCleanup(() => { aCleaned = true })
          return <p>a</p>
        }}</Match>
        <Match when={() => which() === 'b'}>{() => {
          onCleanup(() => { bCleaned = true })
          return <p>b</p>
        }}</Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('a')
  setWhich('b')
  expect(target.textContent).toBe('b')
  expect(aCleaned).toBe(true)
  expect(bCleaned).toBe(false)
  setWhich('none')
  expect(target.textContent).toBe('none')
  expect(bCleaned).toBe(true)
  dispose()
})

/**
 * @canon spec-switch-rebuilds-only-when-the-winning-match-changes
 */
test('disposing surrounding owner disposes active branch', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const dispose = render(
    () => (
      <Switch>
        <Match when={true}>{() => {
          onCleanup(() => { cleaned = true })
          return <p>x</p>
        }}</Match>
      </Switch>
    ),
    target,
  )
  expect(cleaned).toBe(false)
  dispose()
  expect(cleaned).toBe(true)
})

/**
 * @canon spec-a-pending-condition-reads-as-falsy
 */
test('a Match whose when is a pending promise is skipped', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const pending = new Promise<boolean>(() => {})
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={pending}><p>a</p></Match>
        <Match when={true}><p>b</p></Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('b')
  dispose()
})

/**
 * @canon spec-switch-rebuilds-only-when-the-winning-match-changes
 */
test('a re-evaluation that picks the same Match keeps its branch without rebuilding it', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [count, setCount] = signal(1)
  let builds = 0
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={count() > 0}>
          {() => {
            builds++
            return <p>positive</p>
          }}
        </Match>
      </Switch>
    ),
    target,
  )
  expect(builds).toBe(1)
  setCount(2) // the condition re-runs and the same Match wins again
  expect(target.textContent).toBe('positive')
  expect(builds).toBe(1)
  dispose()
})
