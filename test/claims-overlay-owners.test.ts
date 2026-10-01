import { afterEach, expect, test, vi } from 'vitest'
import {
  computed,
  createRoot,
  effect,
  flush,
  microtaskScheduler,
  onCleanup,
  setScheduler,
  signal,
  syncScheduler,
} from '../src/index'

afterEach(() => setScheduler(microtaskScheduler(flush)))

/**
 * @canon spec-an-owner-disposes-its-children-before-its-own-cleanups
 */
test('disposing an owner disposes its children, newest first, before its own cleanups', () => {
  setScheduler(syncScheduler(flush))
  const log: string[] = []
  createRoot((dispose) => {
    onCleanup(() => log.push('own, registered first'))
    effect(() => {
      onCleanup(() => log.push('child A'))
    })
    effect(() => {
      onCleanup(() => log.push('child B'))
    })
    onCleanup(() => log.push('own, registered last'))
    dispose()
  })
  expect(log).toEqual(['child B', 'child A', 'own, registered last', 'own, registered first'])
})

/**
 * @canon spec-a-bare-effect-or-computed-without-an-owner-does-not-warn
 */
test('an effect and a computed created outside every owner do not warn', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const [source] = signal(1)
  effect(() => {
    source()
  })
  const doubled = computed(() => source() * 2)
  expect(doubled()).toBe(2)
  expect(warn).not.toHaveBeenCalled()
  warn.mockRestore()
})

/**
 * @canon spec-oncleanup-outside-every-owner-throws
 */
test('onCleanup inside an owner still registers, and returns the callback it was given', () => {
  const callback = () => {}
  let returned: unknown
  createRoot(() => {
    returned = onCleanup(callback)
  })
  expect(returned).toBe(callback)
})
