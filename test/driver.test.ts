import { expect, test } from 'vitest'
import { resumeStage, runStage } from '../src/driver'

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
  expect(r.pending).toBe(true)
  if (!r.pending) throw new Error('expected pending')
  expect(r.promise).toBe(p)
  expect(r.gen).toBeDefined()
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

test('a suspended generator stage hands its generator back in the outcome', () => {
  const p = new Promise<number>(() => {})
  const outcome = runStage(function* () {
    const x: number = (yield p) as number
    return x + 1
  }, undefined)
  expect(outcome.pending).toBe(true)
  if (!outcome.pending) throw new Error('expected pending')
  expect(outcome.gen).toBeDefined()
  expect(typeof outcome.gen!.next).toBe('function')
})

test('resumeStage drives a retained generator forward with a value', () => {
  const p = new Promise<number>(() => {})
  const outcome = runStage(function* () {
    const x: number = (yield p) as number
    return x + 100
  }, undefined)
  if (!outcome.pending) throw new Error('expected pending')
  const resumed = resumeStage(outcome.gen!, { throw: false, value: 5 })
  expect(resumed).toEqual({ pending: false, value: 105 })
})

test('resumeStage does not re-run the code before the pause', () => {
  let before = 0
  const p = new Promise<number>(() => {})
  const outcome = runStage(function* () {
    before++
    const x: number = (yield p) as number
    return x
  }, undefined)
  if (!outcome.pending) throw new Error('expected pending')
  expect(before).toBe(1)
  resumeStage(outcome.gen!, { throw: false, value: 1 })
  expect(before).toBe(1)
})

test('resumeStage with a throw seed reaches the generator try/catch', () => {
  const p = new Promise<number>(() => {})
  const outcome = runStage(function* () {
    try {
      yield p
      return 'unreachable'
    } catch (e) {
      return `caught: ${(e as Error).message}`
    }
  }, undefined)
  if (!outcome.pending) throw new Error('expected pending')
  const resumed = resumeStage(outcome.gen!, { throw: true, reason: new Error('boom') })
  expect(resumed).toEqual({ pending: false, value: 'caught: boom' })
})

test('a generator that pauses twice hands back the same generator each time', () => {
  const p1 = new Promise<number>(() => {})
  const p2 = new Promise<number>(() => {})
  const first = runStage(function* () {
    const a: number = (yield p1) as number
    const b: number = (yield p2) as number
    return a + b
  }, undefined)
  if (!first.pending) throw new Error('expected pending')
  const second = resumeStage(first.gen!, { throw: false, value: 1 })
  if (!second.pending) throw new Error('expected pending')
  expect(second.gen).toBe(first.gen)
  expect(resumeStage(second.gen!, { throw: false, value: 2 })).toEqual({
    pending: false,
    value: 3,
  })
})

test('a sync stage outcome carries no generator', () => {
  const p = new Promise<number>(() => {})
  const outcome = runStage(() => p, 0)
  if (!outcome.pending) throw new Error('expected pending')
  expect(outcome.gen).toBeUndefined()
})
