import { computed as r3Computed, unwatched, type Computed as R3Computed } from 'r3'
import { isGeneratorFunction, track, type Resolved } from './async'
import { runStage } from './driver'
import { isPromise } from './is-promise'
import { getOwner, routeError, registerWithOwner } from './owner'
import { makeAccessor, NODE, setSignal, signal, type Signal } from './signal'

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
  const r3Nodes: R3Computed<unknown>[] = []
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const inputAccessor = prevAccessor
    const { accessor, r3Node } = makeStageNode(stage, inputAccessor)
    r3Nodes.push(r3Node)
    prevAccessor = accessor
  }
  // Disposal walks stages in creation order (upstream → downstream). Each
  // `unwatched(stageN)` removes that node from its deps' sub-lists; if stage
  // N+1 was the only consumer of stage N, stage N would have auto-cleaned via
  // r3's `unwatched` cascade anyway. We dispose every stage explicitly to be
  // robust against external consumers of intermediate stages (though pulse
  // doesn't currently expose them).
  registerWithOwner({
    dispose: () => {
      for (const node of r3Nodes) unwatched(node)
    },
  })
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
): { accessor: Signal<unknown>; r3Node: R3Computed<unknown> } {
  const myOwner = getOwner()
  let lastGoodValue: unknown = undefined
  // `kick` lets a settled promise re-trigger this stage's r3 computed.
  const kick = signal(0)
  // `kickCount` increments per kick so each `setSignal(kick, ...)` is a distinct value
  // (r3's setSignal bails on `el.value === v`, so writing the same value would be a no-op).
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  let stashedResolution: StashedResolution | null = null
  // The input value at the time of the most recent suspension. Used to invalidate
  // the stash if the input has changed since (e.g., upstream re-suspended with a
  // new pending promise concurrently with this stage's kick).
  let suspendedInput: unknown = undefined

  // The resumption strategy for this stage is fixed by its type at construction.
  const resumeKind: ResumeKind = isGeneratorFunction(stage) ? 'fast-forward' : 'reuse-value'

  // When routeError finds no handler it re-throws; r3 evaluates eagerly at
  // construction so that re-throw would escape the r3Computed(...) call rather
  // than the later c() read. We catch that re-throw here, park the error, and
  // surface it from the accessor wrapper below so it propagates at c() time.
  let deferredError: { error: unknown } | null = null

  const r3Node = r3Computed(() => {
    try {
      kick() // depend on the kick signal so a settled promise can re-trigger this stage

      // Read input first so we can validate (or discard) a pending stash.
      let input: unknown = undefined
      if (inputAccessor !== null) {
        input = inputAccessor()
        if (isPromise(input)) {
          // The previous stage is suspended; mirror its state.
          // Any stash we held was for the OLD (pre-promise) input — drop it.
          stashedResolution = null
          suspendedOn = null
          return input
        }
      }

      // Consume a stashed resolution IFF the input that produced it still matches.
      // If the input has changed, the stash is stale and we re-run normally.
      if (stashedResolution !== null) {
        if (Object.is(input, suspendedInput)) {
          const r = stashedResolution
          stashedResolution = null
          suspendedOn = null
          if (r.kind === 'rejected') throw r.reason
          lastGoodValue = r.value
          deferredError = null
          return r.value
        }
        // Input changed — discard the stale stash and fall through.
        stashedResolution = null
      }

      const outcome = runStage(stage, input)
      if (outcome.pending) {
        const p = outcome.promise
        if (suspendedOn !== p) {
          suspendedOn = p
          suspendedInput = input
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
      lastGoodValue = outcome.value
      deferredError = null
      return outcome.value
    } catch (e) {
      try {
        routeError(myOwner, e) // throws if no handler catches
      } catch (rethrown) {
        // No handler — park the error so the accessor can surface it at read time.
        // This decouples the throw from r3's eager construction call.
        deferredError = { error: rethrown }
        return lastGoodValue
      }
      // Handler caught — return the cached last-good value so r3 sees no value
      // change → no propagation to downstream subs → throwing stage stays frozen.
      return lastGoodValue
    }
  })

  // Wrap the raw accessor: if a previous run parked an unhandled error, throw it
  // now so callers see the throw at read time rather than at construction time.
  const rawAccessor = makeAccessor(r3Node)
  const accessor = (() => {
    if (deferredError !== null) {
      throw deferredError.error
    }
    return rawAccessor()
  }) as Signal<unknown>
  accessor[NODE] = r3Node
  return { accessor, r3Node: r3Node as R3Computed<unknown> }
}
