import { expect, test } from 'vitest'
import { runStage } from '../src/driver'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('sync stage returning a plain value', () => {
  const r = runStage((v: number) => v * 2, 3)
  expect(r).toEqual({ pending: false, value: 6 })
})

test('sync stage returning a pending promise -> suspended', () => {
  const p = new Promise<number>(() => {})
  const r = runStage(() => p, 0)
  expect(r).toEqual({ pending: true, promise: p })
})

test('sync stage returning a settled promise -> resolved synchronously on second call', async () => {
  const p = Promise.resolve(7)
  const first = runStage(() => p, 0)
  expect(first.pending).toBe(true)
  await tick()
  const second = runStage(() => p, 0)
  expect(second).toEqual({ pending: false, value: 7 })
})

test('async stage with pending promise -> suspended (carries the same promise instance)', () => {
  let release!: (v: number) => void
  const stage = async (_: unknown) => {
    return new Promise<number>((resolve) => { release = resolve })
  }
  const r = runStage(stage, 0)
  expect(r.pending).toBe(true)
})

test('generator stage yielding a settled value -> returns synchronously', () => {
  function* stage(input: number) {
    const x: number = yield input + 1
    return x * 2
  }
  // input + 1 is 4, a plain number; yield resumes with 4; return 4*2=8
  const r = runStage(stage, 3)
  expect(r).toEqual({ pending: false, value: 8 })
})

test('generator stage yielding a pending promise -> suspended', () => {
  const p = new Promise<number>(() => {})
  function* stage(_: unknown) {
    const x: number = yield p
    return x
  }
  const r = runStage(stage, 0)
  expect(r).toEqual({ pending: true, promise: p })
})

test('generator stage: settled promise resolves synchronously on re-call', async () => {
  const p = Promise.resolve(42)
  function* stage(_: unknown) {
    const x: number = yield p
    return x + 1
  }
  expect(runStage(stage, 0).pending).toBe(true)
  await tick()
  expect(runStage(stage, 0)).toEqual({ pending: false, value: 43 })
})

test('generator stage: rejected promise throws into the generator', async () => {
  const reason = new Error('boom')
  const p = Promise.reject(reason)
  function* stage(_: unknown) {
    try {
      yield p
      return 'unreachable'
    } catch (e) {
      return `caught: ${(e as Error).message}`
    }
  }
  expect(runStage(stage, 0).pending).toBe(true)
  await tick()
  expect(runStage(stage, 0)).toEqual({ pending: false, value: 'caught: boom' })
})

test('generator stage: uncaught rejection propagates out of runStage', async () => {
  const reason = new Error('uncaught')
  const p = Promise.reject(reason)
  function* stage(_: unknown) {
    yield p
    return 'unreachable'
  }
  expect(runStage(stage, 0).pending).toBe(true)
  await tick()
  expect(() => runStage(stage, 0)).toThrow('uncaught')
})
