/**
 * A component whose body suspends: the body runs again when the source
 * settles, and pulse warns about it, once per component function.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { flush, microtaskScheduler, onCleanup, render, setScheduler, use } from '../../src/index'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick()
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

function mount(view: () => unknown): HTMLElement {
  const target = document.createElement('div')
  document.body.append(target)
  render(view as () => Node, target)
  return target
}

/** A promise that fulfils with `value` on the next macrotask. */
const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 1))

/**
 * @canon exception-a-component-that-suspends-in-its-body-runs-again
 */
test('a component whose body suspends runs again when the source settles, and recreates what it built', async () => {
  const name = later('Ada')
  let runs = 0
  let cleaned = 0
  function Profile() {
    runs++
    onCleanup(() => cleaned++)
    // Called in the body itself: `{use(name)}` in the JSX would compile to a
    // hole of its own, and only that hole would suspend.
    const value = use(name)
    return <span>{value}</span>
  }
  const target = mount(() => <div>{() => <Profile />}</div>)
  expect(runs).toBe(1)
  expect(target.querySelector('span')).toBeNull()

  await ticks(5)

  // The first run threw, so the body ran again, and what the first run
  // registered was disposed before the second.
  expect(runs).toBe(2)
  expect(cleaned).toBe(1)
  expect(target.querySelector('span')?.textContent).toBe('Ada')
})

/**
 * @canon spec-a-component-that-suspends-in-its-body-warns
 */
test('a suspending component body warns once per component, naming only the component that suspended', async () => {
  const first = later('one')
  const second = later('two')
  function Suspends(props: { source: Promise<string> }) {
    const value = use(props.source)
    return <b>{value}</b>
  }
  function Wrapper(props: { source: Promise<string> }) {
    // Built in Wrapper's body, so the throw passes through Wrapper too.
    const inner = <Suspends source={props.source} />
    return <i>{inner}</i>
  }
  function Plain() {
    return <u>plain</u>
  }
  const target = mount(() => (
    <div>
      {() => <Wrapper source={first} />}
      {() => <Suspends source={second} />}
      {() => <Plain />}
    </div>
  ))
  await ticks(5)

  // Suspends suspended twice, directly and inside Wrapper: one warning names
  // it. Wrapper only passed the throw on, and Plain never suspended.
  const messages = warn.mock.calls.map((call) => String(call[0]))
  expect(messages.filter((m) => m.includes('suspended in its body'))).toHaveLength(1)
  expect(messages[0]).toContain('Suspends')
  expect(messages.some((m) => m.includes('Wrapper') || m.includes('Plain'))).toBe(false)
  // The components still ran again and rendered their values.
  expect(target.querySelector('i b')?.textContent).toBe('one')
  expect(target.querySelector('div > b')?.textContent).toBe('two')
  expect(target.querySelector('u')?.textContent).toBe('plain')
})
