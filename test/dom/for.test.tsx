import { afterEach, beforeEach, expect, test } from 'vitest'
import { For } from '../../src/dom/for'
import { Show } from '../../src/dom/show'
import {
  effect,
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
 * @canon spec-for-renders-its-fallback-when-there-are-no-rows
 */
test('renders rows in order', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [items] = signal([1, 2, 3])
  const dispose = render(
    () => <For each={items()}>{(n) => <li>{n}</li>}</For>,
    target,
  )
  expect(target.querySelectorAll('li')).toHaveLength(3)
  expect(target.textContent).toBe('123')
  dispose()
})

/**
 * @canon spec-for-renders-its-fallback-when-there-are-no-rows
 */
test('empty array → fallback rendered', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [items] = signal<number[]>([])
  const dispose = render(
    () => <For each={items()} fallback={<p>empty</p>}>{(n) => <li>{n}</li>}</For>,
    target,
  )
  expect(target.textContent).toBe('empty')
  dispose()
})

/**
 * @canon spec-list-rows-are-keyed-by-reference
 */
test('adding items mounts new DOM at the right position', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const [items, setItems] = signal([a, b])
  const dispose = render(
    () => <For each={items()}>{(item) => <li>{item.id}</li>}</For>,
    target,
  )
  expect(target.textContent).toBe('ab')
  setItems([a, b, c])
  expect(target.textContent).toBe('abc')
  dispose()
})

/**
 * @canon spec-map-array-builds-each-item-once-under-its-own-owner
 */
test('removing items fires per-row onCleanup', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const cleanups: string[] = []
  const [items, setItems] = signal([a, b])
  const dispose = render(
    () => <For each={items()}>{(item) => {
      onCleanup(() => cleanups.push(item.id))
      return <li>{item.id}</li>
    }}</For>,
    target,
  )
  expect(cleanups).toEqual([])
  setItems([a]) // b leaves
  expect(cleanups).toEqual(['b'])
  dispose()
  expect(cleanups).toEqual(['b', 'a']) // a disposed on render dispose
})

/**
 * Content built in each of the three places that build content: a reactive
 * hole, a `<Show>` branch and a `<For>` row. Each piece creates an effect, a
 * nested reactive child and an `onCleanup`, all following `tick`, and records
 * its name when any of them runs or is cleaned up.
 */
function ownedContentProbe() {
  const [tick, setTick] = signal(0)
  const runs: string[] = []
  const cleaned: string[] = []
  const content = (name: string) => {
    effect(() => {
      tick()
      runs.push(`${name} effect`)
    })
    onCleanup(() => cleaned.push(name))
    return (
      <em>
        {() => {
          tick()
          runs.push(`${name} child`)
          return name
        }}
      </em>
    )
  }
  return { setTick, runs, cleaned, content }
}

/**
 * @canon spec-what-a-hole-builds-lives-under-its-own-owner-until-it-leaves
 */
test('content a hole, a branch or a row built is disposed with everything it created when it leaves', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const { setTick, runs, cleaned, content } = ownedContentProbe()
  const a = { id: 'a' }
  const b = { id: 'b' }
  const [holeKey, setHoleKey] = signal('x')
  const [shown, setShown] = signal(true)
  const [items, setItems] = signal([a, b])
  const dispose = render(
    () => (
      <div>
        {() => content(`hole ${holeKey()}`)}
        <Show when={shown()}>{() => content('branch')}</Show>
        <For each={items()}>{(item) => content(`row ${item.id}`)}</For>
      </div>
    ),
    target,
  )

  // Before anything leaves, every piece follows `tick`.
  runs.length = 0
  setTick(1)
  expect(runs.sort()).toEqual([
    'branch child', 'branch effect',
    'hole x child', 'hole x effect',
    'row a child', 'row a effect',
    'row b child', 'row b effect',
  ])

  // Each piece leaves: the hole re-runs, the branch flips away, row b is removed.
  setHoleKey('y')
  setShown(false)
  setItems([a])
  expect(cleaned.sort()).toEqual(['branch', 'hole x', 'row b'])

  // Only what is still in the page follows `tick`. What left keeps nothing running.
  runs.length = 0
  setTick(2)
  expect(runs.sort()).toEqual(['hole y child', 'hole y effect', 'row a child', 'row a effect'])
  dispose()
})

/**
 * @canon spec-what-a-hole-builds-lives-under-its-own-owner-until-it-leaves
 */
test('content a hole, a branch or a row built is disposed with everything it created when the surrounding owner is disposed', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const { setTick, runs, cleaned, content } = ownedContentProbe()
  const [items] = signal([{ id: 'a' }])
  const dispose = render(
    () => (
      <div>
        {() => content('hole')}
        <Show when={true}>{() => content('branch')}</Show>
        <For each={items()}>{(item) => content(`row ${item.id}`)}</For>
      </div>
    ),
    target,
  )
  runs.length = 0
  setTick(1)
  expect(runs).toHaveLength(6)
  expect(cleaned).toEqual([])

  dispose()
  expect(cleaned.sort()).toEqual(['branch', 'hole', 'row a'])
  runs.length = 0
  setTick(2)
  expect(runs).toEqual([])
})

/**
 * @canon spec-list-rows-are-keyed-by-reference
 */
test('reorder: same DOM node identities, repositioned', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const [items, setItems] = signal([a, b, c])
  const dispose = render(
    () => <For each={items()}>{(item) => <li>{item.id}</li>}</For>,
    target,
  )
  const lisBefore = Array.from(target.querySelectorAll('li'))
  setItems([c, a, b])
  const lisAfter = Array.from(target.querySelectorAll('li'))
  expect(target.textContent).toBe('cab')
  expect(lisAfter).toEqual([lisBefore[2], lisBefore[0], lisBefore[1]])
  dispose()
})

/**
 * @canon spec-a-pending-list-reads-as-empty
 */
test('pending Promise<T[]> → fallback rendered', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<number[]>(() => {})
  const [items] = signal<number[] | Promise<number[]>>(p)
  const dispose = render(
    () => <For each={items()} fallback={<p>loading</p>}>{(n) => <li>{n}</li>}</For>,
    target,
  )
  expect(target.textContent).toBe('loading')
  dispose()
})

/**
 * @canon spec-a-row-index-follows-its-position
 */
test('index accessor is reactive: rendered DOM updates on reorder', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const [items, setItems] = signal([a, b, c])
  const dispose = render(
    () => (
      <For each={items()}>
        {(item, index) => (
          <li>
            {index()}:{item.id}
          </li>
        )}
      </For>
    ),
    target,
  )
  expect(target.textContent).toBe('0:a1:b2:c')
  setItems([c, a, b])
  expect(target.textContent).toBe('0:c1:a2:b')
  dispose()
})
