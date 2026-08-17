import type { Disposable } from 'r3'
import { isPromise } from './is-promise'
import { isGeneratorFunction, track } from './async'
import { collectGeneratorCleanups } from './generator-cleanup'

/** Outcome of running a single stage: either a settled value, or pending on a
 *  promise. A generator stage additionally hands back the paused generator, so
 *  the caller can resume it later instead of building a new one. */
export type StageOutcome =
  | { pending: false; value: unknown }
  | {
      pending: true
      promise: Promise<unknown>
      gen?: Generator<unknown, unknown, unknown>
    }

/** How to re-enter a paused generator: with the value its pending promise
 *  fulfilled to, or with the reason it rejected. */
export type Resumption =
  | { throw: false; value: unknown }
  | { throw: true; reason: unknown }

/**
 * Resolve a possibly-async value to a `StageOutcome`. Used by the driver after
 * a stage returns / yields. Settled fulfillment -> `{value}`; pending -> `{pending}`;
 * settled rejection -> re-throws the reason (so the caller can route it — into
 * a generator's try/catch via `gen.throw`, or out of `runStage` as a real error).
 */
function settle(value: unknown): StageOutcome {
  if (!isPromise(value)) return { pending: false, value }
  const state = track(value)
  if (state.status === 'fulfilled') return { pending: false, value: state.value }
  if (state.status === 'rejected') throw state.reason
  return { pending: true, promise: value }
}

/** Cleanups registered through `onCleanup` while a generator was being driven.
 *  Held against the generator rather than the stage node, because the callbacks
 *  belong to that generator's lifetime and the node recomputes more often than
 *  the generator restarts. */
const cleanupsByGen = new WeakMap<Generator<unknown, unknown, unknown>, Disposable[]>()

/** Hand over a generator's registered cleanups and forget them. Returns an
 *  empty array when it registered none. */
export function takeGeneratorCleanups(
  gen: Generator<unknown, unknown, unknown>,
): Disposable[] {
  const list = cleanupsByGen.get(gen)
  if (list === undefined) return []
  cleanupsByGen.delete(gen)
  return list
}

/**
 * Drive a generator from wherever it currently is. Each yielded value goes
 * through `settle`:
 * - settled value -> resume the generator with it via `gen.next`
 * - settled rejection -> resume via `gen.throw` (user's try/catch can handle it;
 *   if uncaught, the generator throws back to us and we propagate)
 * - pending -> short-circuit with `{ pending, promise, gen }`
 * The generator's own return value is itself run through `settle` (a generator
 * may `return await something` and the runtime should still wait on it).
 *
 * `seed` says how to make the first `gen.next` / `gen.throw` call. A fresh
 * generator is seeded with `undefined`, which a generator ignores on its first
 * resumption; a retained one is seeded with what its pending promise settled to.
 */
function driveGenerator(
  gen: Generator<unknown, unknown, unknown>,
  seed: Resumption,
): StageOutcome {
  let nextValue: unknown = seed.throw ? undefined : seed.value
  let nextThrow: unknown = seed.throw ? seed.reason : undefined
  let hasThrow = seed.throw
  while (true) {
    let list = cleanupsByGen.get(gen)
    if (list === undefined) {
      list = []
      cleanupsByGen.set(gen, list)
    }
    // Wrap only the generator's own execution. `settle` below must not collect.
    const result = collectGeneratorCleanups(list, () =>
      hasThrow ? gen.throw(nextThrow) : gen.next(nextValue),
    )
    hasThrow = false
    if (result.done) return settle(result.value)
    let outcome: StageOutcome
    try {
      outcome = settle(result.value)
    } catch (rejection) {
      // settled rejection: feed it into the generator's try/catch
      nextThrow = rejection
      hasThrow = true
      continue
    }
    if (outcome.pending) return { pending: true, promise: outcome.promise, gen }
    nextValue = outcome.value
  }
}

/**
 * Run a single pipeline stage with the given input. Detects the stage's shape
 * (generator function / async function / sync function) and dispatches.
 *
 * NOTE: async functions are not detected explicitly — an async function's
 * returned promise is handled by `settle` just like any other returned promise,
 * so the sync path catches it correctly. Generator detection is the only
 * dispatch we need; async vs sync is handled uniformly by `settle`.
 */
// `any` here is the standard implementation-signature widening for the
// variadic overloads above; narrowing to `unknown` breaks the overload contract.
export function runStage(
  stage: (value: any) => unknown,
  input: unknown,
  onGenCreated?: (gen: Generator<unknown, unknown, unknown>) => void,
): StageOutcome {
  if (isGeneratorFunction(stage)) {
    const gen = stage(input) as Generator<unknown, unknown, unknown>
    // Hand the generator to the caller before driving it, so the caller can
    // record it as the generator whose lifetime owns any `onCleanup` callbacks
    // — even if this very call runs it to completion or has it throw
    // synchronously, without ever pausing on a promise.
    onGenCreated?.(gen)
    return driveGenerator(gen, {
      throw: false,
      value: undefined,
    })
  }
  // Sync OR async function — both return a value that `settle` handles uniformly
  // (an async function's return is always a promise; `settle` routes it through `track`).
  return settle(stage(input))
}

/**
 * Drive an already-started generator forward from the pause it is sitting at.
 * The code before that pause does not run again.
 */
export function resumeStage(
  gen: Generator<unknown, unknown, unknown>,
  seed: Resumption,
): StageOutcome {
  return driveGenerator(gen, seed)
}
