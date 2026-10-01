import { afterEach, expect, test } from 'vitest'
import { createRoot, effect, flush, getOwner, Loading, microtaskScheduler, render, setScheduler, signal, syncScheduler, use } from '../../src/index'
import { Fragment } from '../../src/dom'
import { h } from '../../src/dom/h'
import { jsx, jsxs } from '../../src/dom/jsx-runtime'

afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

/**
 * @canon rule-a-boundary-builds-its-children-once-up-front
 */
test('a boundary runs its children once, while showing initial, and not again when it reveals them', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let release!: (value: string) => void
  const pending = new Promise<string>((resolve) => (release = resolve))
  let bodies = 0
  function Card() {
    bodies++
    return <span>{() => use(pending)}</span>
  }
  const dispose = render(() => <Loading initial={<i>init</i>}>{() => <div><Card /></div>}</Loading>, target)
  expect(target.textContent).toBe('init')
  expect(bodies).toBe(1) // built while the placeholder is on screen
  release('loaded')
  await pending
  await new Promise((resolve) => setTimeout(resolve))
  flush()
  expect(target.textContent).toBe('loaded')
  expect(bodies).toBe(1) // revealed, not rebuilt
  dispose()
})

/**
 * @canon rule-a-fragment-child-runs-under-the-owner-the-fragment-was-built-in
 */
test('a Fragment function child inserted outside every owner runs under the owner the Fragment was built in', () => {
  setScheduler(syncScheduler(flush))
  const [count, setCount] = signal(0)
  const runs: number[] = []
  let fragmentOwner: unknown
  let childOwnerParent: unknown
  let dispose!: () => void
  let children!: unknown
  createRoot((d) => {
    dispose = d
    fragmentOwner = getOwner()
    children = h(Fragment, null, () => {
      childOwnerParent = (getOwner() as { parent: unknown } | null)?.parent
      effect(() => {
        runs.push(count())
      })
      return 'x'
    })
  })
  const host = h('div', null, children) as HTMLElement // inserted with no owner ambient
  expect(host.textContent).toBe('x')
  expect(childOwnerParent).toBe(fragmentOwner)
  setCount(1)
  const before = runs.length
  expect(runs.at(-1)).toBe(1)
  dispose() // the Fragment's owner goes, and what the child created goes with it
  setCount(2)
  expect(runs.length).toBe(before)
})

/**
 * @canon rule-the-jsx-runtime-builds-every-element-with-h
 */
test('jsx hands a component its props object as it is, getters intact', () => {
  let received: unknown
  let childrenReads = 0
  function Component(props: unknown) {
    received = props
    return document.createTextNode('c')
  }
  const props = {
    get children() {
      childrenReads++
      return 'kid'
    },
  }
  jsx(Component as never, props)
  expect(received).toBe(props)
  expect(childrenReads).toBe(0) // not read on the way in
})

/**
 * @canon rule-the-jsx-runtime-builds-every-element-with-h
 */
test('jsxs builds a DOM tag the way h does, children as separate arguments, other getters intact', () => {
  setScheduler(syncScheduler(flush))
  const [id, setId] = signal('a')
  const element = jsxs('div', {
    get id() {
      return id()
    },
    children: ['x', 'y'],
  }) as HTMLElement
  expect(element.outerHTML).toBe((h('div', { id: 'a' }, 'x', 'y') as HTMLElement).outerHTML)
  setId('b')
  expect(element.getAttribute('id')).toBe('b')
})
