/**
 * One test per DOM-level decision: a rule that holds other rules. Each test pins
 * the decision's own statement as a whole, through a scenario its nested rules
 * do not cover on their own.
 */
import { afterEach, expect, test } from 'vitest'
import {
  flush,
  isLoading,
  Loading,
  microtaskScheduler,
  render,
  setScheduler,
  Show,
  signal,
  syncScheduler,
  use,
  latest,
} from '../../src/index'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

function mount(view: () => unknown): HTMLElement {
  const target = document.createElement('div')
  document.body.append(target)
  render(view as () => Node, target)
  return target
}

/**
 * @canon spec-a-component-runs-once-and-reactivity-lives-in-its-holes
 */
test('a component body runs once while the holes it returned follow every change', () => {
  setScheduler(syncScheduler(flush))
  const [count, setCount] = signal(0)
  let bodyRuns = 0
  function Counter() {
    bodyRuns++
    return (
      <p>
        <b>{() => String(count())}</b>
        <i class:odd={() => count() % 2 === 1}>x</i>
      </p>
    )
  }
  const target = mount(() => <Counter />)
  setCount(1)
  setCount(2)
  setCount(3)
  expect(bodyRuns).toBe(1)
  expect(target.querySelector('b')!.textContent).toBe('3')
  expect(target.querySelector('i')!.classList.contains('odd')).toBe(true)
})

/**
 * @canon spec-jsx-builds-real-dom-directly
 */
test('an update writes to its own nodes and leaves a node added from outside in place', () => {
  setScheduler(syncScheduler(flush))
  const [label, setLabel] = signal('a')
  const target = mount(() => <div>{() => label()}</div>)
  const div = target.querySelector('div')!
  const foreign = document.createElement('span')
  foreign.textContent = 'added from outside'
  div.append(foreign)
  setLabel('b')
  // Nothing compared the page with a tree of its own: the element is the same
  // one, and the node it did not create is still there.
  expect(target.querySelector('div')).toBe(div)
  expect(div.contains(foreign)).toBe(true)
  expect(div.textContent).toBe('badded from outside')
})

/**
 * @canon spec-a-boundary-wraps-what-it-coordinates
 */
test('each boundary coordinates only the region it wraps', async () => {
  const first = Promise.withResolvers<string>()
  const [left] = signal(first.promise)
  const [right] = signal('ready')
  let loadingOnTheRight: boolean | undefined
  const target = mount(() => (
    <section>
      <Loading initial={<i>left loading</i>}>{() => <b>{() => use(left())}</b>}</Loading>
      <Loading initial={<i>right loading</i>}>
        {() => (
          <u>
            {() => use(right())}
            {() => {
              loadingOnTheRight = isLoading()
              return ''
            }}
          </u>
        )}
      </Loading>
    </section>
  ))
  await tick()
  expect(target.textContent).toBe('left loadingready')
  expect(loadingOnTheRight).toBe(false)
  first.resolve('done')
  await tick()
  await tick()
  expect(target.textContent).toBe('doneready')
})

/**
 * @canon spec-control-flow-bakes-in-no-async-policy
 */
test('Show reads a pending condition as falsy and leaves the boundary around it alone', async () => {
  const pending = new Promise<boolean>(() => {})
  const target = mount(() => (
    <Loading initial={<i>boundary placeholder</i>}>
      {() => (
        <Show when={pending} fallback={<em>fallback</em>}>
          <strong>shown</strong>
        </Show>
      )}
    </Loading>
  ))
  await tick()
  // Show neither suspends nor reports to the boundary: it shows its own
  // empty form, and the boundary has nothing to wait for.
  expect(target.textContent).toBe('fallback')
})

/**
 * @canon spec-the-read-verb-decides-what-renders-and-what-waits
 */
test('three bindings of one source in one boundary each render and wait as their verb says', async () => {
  setScheduler(syncScheduler(flush))
  const first = Promise.withResolvers<string>()
  const [source, setSource] = signal<Promise<string> | string>('old')
  const [other] = signal(first.promise)
  const target = mount(() => (
    <Loading>
      {() => (
        <p>
          <b>{() => use(source())}</b>
          <i>{() => String(latest(source))}</i>
          <u>{() => use(other())}</u>
        </p>
      )}
    </Loading>
  ))
  await tick()
  setSource('new')
  await tick()
  // `use` waits for its suspended neighbour; `latest` commits at once.
  expect(target.querySelector('b')!.textContent).toBe('')
  expect(target.querySelector('i')!.textContent).toBe('new')
  first.resolve('other')
  await tick()
  await tick()
  expect(target.querySelector('b')!.textContent).toBe('new')
  expect(target.querySelector('u')!.textContent).toBe('other')
})

/**
 * @canon spec-a-prop-says-how-it-reaches-the-dom
 */
test('the same name reaches the attribute or the property by its prefix, never by guessing', () => {
  setScheduler(syncScheduler(flush))
  const [text, setText] = signal('first')
  const target = mount(() => (
    <form>
      <input name="by-attribute" value={() => text()} />
      <input name="by-property" prop:value={() => text()} />
    </form>
  ))
  const byAttribute = target.querySelector<HTMLInputElement>('[name=by-attribute]')!
  const byProperty = target.querySelector<HTMLInputElement>('[name=by-property]')!
  byAttribute.value = 'typed'
  byProperty.value = 'typed'
  setText('second')
  expect(byAttribute.getAttribute('value')).toBe('second')
  expect(byAttribute.value).toBe('typed') // the property was never touched
  expect(byProperty.value).toBe('second')
  expect(byProperty.hasAttribute('value')).toBe(false)
})

/**
 * @canon spec-a-missing-value-sets-nothing
 */
test('null, undefined and false leave nothing in the DOM, wherever they appear', () => {
  setScheduler(syncScheduler(flush))
  const [missing, setMissing] = signal<null | undefined | false | string>('present')
  const target = mount(() => (
    <p title={() => missing()} style:color={() => (missing() ? 'red' : missing())}>
      {() => missing()}
    </p>
  ))
  const p = target.querySelector('p')!
  for (const value of [null, undefined, false] as const) {
    setMissing('present')
    setMissing(value)
    expect(p.hasAttribute('title')).toBe(false)
    expect(p.style.getPropertyValue('color')).toBe('')
    expect(p.textContent).toBe('')
  }
})
