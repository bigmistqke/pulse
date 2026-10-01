import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  createRoot,
  flush,
  microtaskScheduler,
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
 * @canon spec-a-function-child-is-a-reactive-hole
 */
test('JSX renders an element with reactive child', () => {
  createRoot(() => {
    const [count, setCount] = signal(0)
    const el = (<div>{count()}</div>) as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('0')
    setCount(5)
    expect(el.textContent).toBe('5')
  })
})

/**
 * @canon spec-an-event-prop-adds-a-listener-until-its-owner-is-disposed
 * @canon spec-a-class-prefix-toggles-one-class-by-truthiness
 */
test('JSX renders nested element with on: and class:', () => {
  let clicked = 0
  createRoot(() => {
    const [on, setOn] = signal(false)
    const el = (
      <button on:click={() => { clicked++ }} class:active={on()}>
        ok
      </button>
    ) as HTMLButtonElement
    document.body.append(el)
    el.click()
    expect(clicked).toBe(1)
    expect(el.classList.contains('active')).toBe(false)
    setOn(true)
    expect(el.classList.contains('active')).toBe(true)
  })
})

/**
 * @canon spec-a-fragment-is-its-children-as-an-array
 */
test('JSX Fragment groups siblings', () => {
  createRoot(() => {
    const el = (
      <div>
        <>
          <span>a</span>
          <span>b</span>
        </>
      </div>
    ) as HTMLElement
    document.body.append(el)
    expect(el.children.length).toBe(2)
  })
})
