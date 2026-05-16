import { isPromise } from './is-promise'
import { isGeneratorFunction, track } from './async'

/** Outcome of running a single stage: either a settled value, or pending on a promise. */
export type StageOutcome =
  | { pending: false; value: unknown }
  | { pending: true; promise: Promise<unknown> }

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

/**
 * Drive a generator. Each yielded value goes through `settle`:
 * - settled value -> resume the generator with it via `gen.next`
 * - settled rejection -> resume via `gen.throw` (user's try/catch can handle it;
 *   if uncaught, the generator throws back to us and we propagate)
 * - pending -> short-circuit with `{ pending, promise }`
 * The generator's own return value is itself run through `settle` (a generator
 * may `return await something` and the runtime should still wait on it).
 */
function driveGenerator(gen: Generator<unknown, unknown, unknown>): StageOutcome {
  let nextValue: unknown = undefined
  let nextThrow: unknown = undefined // only read when hasThrow is true
  let hasThrow = false
  while (true) {
    const result = hasThrow ? gen.throw(nextThrow) : gen.next(nextValue)
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
    if (outcome.pending) return outcome
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
export function runStage(
  stage: (value: any) => unknown,
  input: unknown,
): StageOutcome {
  if (isGeneratorFunction(stage)) {
    return driveGenerator(stage(input) as Generator<unknown, unknown, unknown>)
  }
  // Sync OR async function — both return a value that `settle` handles uniformly
  // (an async function's return is always a promise; `settle` routes it through `track`).
  return settle(stage(input))
}
