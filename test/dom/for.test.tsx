import { afterEach, beforeEach, expect, test } from 'vitest'
import { For } from '../../src/dom/for'
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

test('renders rows in order', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const items = signal([1, 2, 3])
  const dispose = render(
    () => <For each={items}>{(n) => <li>{n}</li>}</For>,
    target,
  )
  expect(target.querySelectorAll('li')).toHaveLength(3)
  expect(target.textContent).toBe('123')
  dispose()
})

test('empty array → fallback rendered', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const items = signal<number[]>([])
  const dispose = render(
    () => <For each={items} fallback={<p>empty</p>}>{(n) => <li>{n}</li>}</For>,
    target,
  )
  expect(target.textContent).toBe('empty')
  dispose()
})

test('adding items mounts new DOM at the right position', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const items = signal([a, b])
  const dispose = render(
    () => <For each={items}>{(item) => <li>{item.id}</li>}</For>,
    target,
  )
  expect(target.textContent).toBe('ab')
  setSignal(items, [a, b, c])
  expect(target.textContent).toBe('abc')
  dispose()
})

test('removing items fires per-row onCleanup', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const cleanups: string[] = []
  const items = signal([a, b])
  const dispose = render(
    () => <For each={items}>{(item) => {
      onCleanup(() => cleanups.push(item.id))
      return <li>{item.id}</li>
    }}</For>,
    target,
  )
  expect(cleanups).toEqual([])
  setSignal(items, [a]) // b leaves
  expect(cleanups).toEqual(['b'])
  dispose()
  expect(cleanups).toEqual(['b', 'a']) // a disposed on render dispose
})

test('reorder: same DOM node identities, repositioned', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const items = signal([a, b, c])
  const dispose = render(
    () => <For each={items}>{(item) => <li>{item.id}</li>}</For>,
    target,
  )
  const lisBefore = Array.from(target.querySelectorAll('li'))
  setSignal(items, [c, a, b])
  const lisAfter = Array.from(target.querySelectorAll('li'))
  expect(target.textContent).toBe('cab')
  expect(lisAfter).toEqual([lisBefore[2], lisBefore[0], lisBefore[1]])
  dispose()
})

test('pending Promise<T[]> → fallback rendered', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<number[]>(() => {})
  const items = signal<number[] | Promise<number[]>>(p)
  const dispose = render(
    () => <For each={items} fallback={<p>loading</p>}>{(n) => <li>{n}</li>}</For>,
    target,
  )
  expect(target.textContent).toBe('loading')
  dispose()
})

test('index accessor is reactive: rendered DOM updates on reorder', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const items = signal([a, b, c])
  const dispose = render(
    () => (
      <For each={items}>
        {(item, index) => (
          <li>
            {index}:{item.id}
          </li>
        )}
      </For>
    ),
    target,
  )
  expect(target.textContent).toBe('0:a1:b2:c')
  setSignal(items, [c, a, b])
  expect(target.textContent).toBe('0:c1:a2:b')
  dispose()
})
