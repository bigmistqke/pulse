import { computed as r3Computed } from 'r3'
import { isGeneratorFunction, track, type Resolved } from './async'
import { runStage } from './driver'
import { isPromise } from './is-promise'
import { makeAccessor, setSignal, signal, type Signal } from './signal'

/** A pipeline stage of any shape: sync, async, or generator. The return type
 *  is whatever the function returns — sync `R`, async `Promise<R>`, or
 *  `Generator<…, R, …>`. The pipeline unwraps to `Resolved<R>` for the next stage. */
type Stage<In, Out> = (value: In) => Out

// Overloads: stage N's input is `Resolved<stage N-1's return type>`; the pipeline
// result is `Resolved<last stage's return type>`.
export function computed<A>(s0: () => A): Signal<Resolved<A>>
export function computed<A, B>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
): Signal<Resolved<B>>
export function computed<A, B, C>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
): Signal<Resolved<C>>
export function computed<A, B, C, D>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
): Signal<Resolved<D>>
export function computed<A, B, C, D, E>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
  s4: Stage<Resolved<D>, E>,
): Signal<Resolved<E>>

/**
 * Create a derived signal from a pipeline of one or more stages. Each stage may
 * be sync `(v) => T`, async `async (v) => Promise<T>`, or generator
 * `function* (v): Generator<…, T, …>`. Inside a generator stage, use
 * `yield* read(x)` to read signals and await promises with correct per-yield
 * inference. The pipeline suspends when a stage's promise is pending (the stage's
 * r3 value becomes that in-flight `Promise<T>` — async color flows downstream).
 *
 * Resumption is two-mode, discriminated by stage type:
 * - Generator stage → 'fast-forward': on settle, the stage is re-invoked from
 *   scratch; the driver fast-forwards through the WeakMap-cached settled yield
 *   and runs the rest of the body. Stage value = the generator's true return.
 * - Non-generator stage (sync/async) that returned a promise → 'reuse-value':
 *   on settle, the rerun callback stashes the resolved value; the next r3 fn
 *   invocation returns it directly WITHOUT re-invoking the stage. This is
 *   required for async functions, which create a fresh outer promise on every
 *   call and would otherwise never converge under restart-from-top semantics.
 *
 * @remarks Typed overloads cover 1–5 stages; beyond that, compose pipelines.
 */
export function computed(...stages: Array<(value: any) => unknown>): Signal<unknown> {
  if (stages.length === 0) {
    throw new Error('computed requires at least one stage')
  }

  // Build the chain: stage 0 has no input; later stages read the previous accessor.
  let prevAccessor: Signal<unknown> | null = null
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const inputAccessor = prevAccessor
    prevAccessor = makeStageNode(stage, inputAccessor)
  }
  return prevAccessor as Signal<unknown>
}

/** Resumption strategy for a suspended stage — see the `computed` JSDoc. */
type ResumeKind = 'fast-forward' | 'reuse-value'

/** Stash for 'reuse-value' resumption: the settled fulfillment or rejection of
 *  the suspending promise, to be consumed by the next r3 fn invocation. */
type StashedResolution =
  | { kind: 'fulfilled'; value: unknown }
  | { kind: 'rejected'; reason: unknown }

/**
 * Wrap a single stage in an r3 computed that handles suspension propagation.
 * If `inputAccessor` is null, the stage has no input (it is stage 0). Otherwise
 * the stage reads its predecessor — and if that value is a pending promise, this
 * stage's value becomes the same promise (color propagates without re-entering
 * the stage's logic).
 */
function makeStageNode(
  stage: (value: any) => unknown,
  inputAccessor: Signal<unknown> | null,
): Signal<unknown> {
  // `kick` lets a settled promise re-trigger this stage's r3 computed.
  const kick = signal(0)
  // `kickCount` increments per kick so each `setSignal(kick, ...)` is a distinct value
  // (r3's setSignal bails on `el.value === v`, so writing the same value would be a no-op).
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  let stashedResolution: StashedResolution | null = null

  // The resumption strategy for this stage is fixed by its type at construction.
  const resumeKind: ResumeKind = isGeneratorFunction(stage) ? 'fast-forward' : 'reuse-value'

  const r3Node = r3Computed(() => {
    kick() // depend on the kick signal so a settled promise can re-trigger this stage

    // Consume a stashed resolution from a 'reuse-value' suspension first — the
    // resolved value of the outer promise IS the stage value; no re-invocation.
    if (stashedResolution !== null) {
      const r = stashedResolution
      stashedResolution = null
      suspendedOn = null
      if (r.kind === 'rejected') throw r.reason
      return r.value
    }

    // Propagate a suspended input: if the previous stage's value is a promise,
    // this stage's value is the same promise. Do not run `stage` — re-entering
    // when the input value flips will re-evaluate this whole body anyway.
    let input: unknown = undefined
    if (inputAccessor !== null) {
      input = inputAccessor()
      if (isPromise(input)) {
        // The previous stage is suspended; mirror its state.
        suspendedOn = null
        return input
      }
    }

    const outcome = runStage(stage, input)
    if (outcome.pending) {
      const p = outcome.promise
      if (suspendedOn !== p) {
        suspendedOn = p
        const rerun = () => {
          if (suspendedOn === p) {
            if (resumeKind === 'reuse-value') {
              const state = track(p)
              if (state.status === 'fulfilled') {
                stashedResolution = { kind: 'fulfilled', value: state.value }
              } else if (state.status === 'rejected') {
                stashedResolution = { kind: 'rejected', reason: state.reason }
              }
              // 'pending' is unreachable here — rerun fires only after settle.
            }
            // 'fast-forward': do not stash; the next r3 fn invocation will
            // re-invoke the stage, and the driver's WeakMap-backed `track`
            // will see the yielded promise as settled and fast-forward.
            suspendedOn = null
            setSignal(kick, ++kickCount)
          }
        }
        p.then(rerun, rerun)
      }
      return p
    }

    suspendedOn = null
    return outcome.value
  })

  return makeAccessor(r3Node)
}
