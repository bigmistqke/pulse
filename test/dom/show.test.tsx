import { afterEach, beforeEach, expect, test } from 'vitest'
import { Show } from '../../src/dom/show'
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

test('truthy when mounts function child with narrowed value', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [user] = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => <Show when={user}>{(u) => <span>{u.name}</span>}</Show>,
    target,
  )
  expect(target.textContent).toBe('Ada')
  dispose()
})

test('falsy when mounts fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [user] = signal<{ name: string } | null>(null)
  const dispose = render(
    () => (
      <Show when={user} fallback={<p>none</p>}>
        {(u) => <span>{u.name}</span>}
      </Show>
    ),
    target,
  )
  expect(target.textContent).toBe('none')
  dispose()
})

test('pending Promise<T> when → fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<{ name: string }>(() => {})
  const [user] = signal<{ name: string } | Promise<{ name: string }>>(p)
  const dispose = render(
    () => (
      <Show when={user} fallback={<p>loading</p>}>
        {(u) => <span>{u.name}</span>}
      </Show>
    ),
    target,
  )
  expect(target.textContent).toBe('loading')
  dispose()
})

test('truthy → truthy with different value preserves subtree (children not re-called)', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let calls = 0
  const [user, setUser] = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => (
      <Show when={user}>
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

test('truthy → falsy disposes branch sub-owner', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const [user, setUser] = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => (
      <Show when={user} fallback={<p>none</p>}>
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

test('falsy → truthy mounts fresh children invocation', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let calls = 0
  const [user, setUser] = signal<{ name: string } | null>(null)
  const dispose = render(
    () => (
      <Show when={user} fallback={<p>none</p>}>
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

test('disposing surrounding owner disposes active branch', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const [cond] = signal(true)
  const dispose = render(
    () => (
      <Show when={cond}>
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

test('static (non-function) child renders when truthy', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [cond] = signal(true)
  const dispose = render(
    () => <Show when={cond}><p>shown</p></Show>,
    target,
  )
  expect(target.textContent).toBe('shown')
  dispose()
})
