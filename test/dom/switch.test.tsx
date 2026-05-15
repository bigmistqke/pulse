import { afterEach, beforeEach, expect, test } from 'vitest'
import { Match, Switch } from '../../src/dom/switch'
import {
  flush,
  microtaskScheduler,
  onCleanup,
  render,
  setScheduler,
  setSignal,
  signal,
  syncScheduler,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

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

test('Match function child receives narrowed value', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const user = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={user}>{(u) => <span>{u.name}</span>}</Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('Ada')
  dispose()
})

test('winner change disposes old branch sub-owner', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const which = signal<'a' | 'b' | 'none'>('a')
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
  setSignal(which, 'b')
  expect(target.textContent).toBe('b')
  expect(aCleaned).toBe(true)
  expect(bCleaned).toBe(false)
  setSignal(which, 'none')
  expect(target.textContent).toBe('none')
  expect(bCleaned).toBe(true)
  dispose()
})

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
