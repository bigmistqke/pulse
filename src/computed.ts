import { computed as r3Computed, read as r3Read, unwatched, type Computed as R3Computed } from 'r3'
import { isGeneratorFunction, track, type Resolved } from './async'
import { runStage } from './driver'
import { isPromise } from './is-promise'
import { getOwner, routeError, registerWithOwner } from './owner'
import { makeAccessor, NODE, PENDING, signal, type Signal } from './signal'

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
// `any` here is the standard implementation-signature widening for the
// variadic overloads above; narrowing to `unknown` breaks the overload contract.
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

/** Stash for 'fast-forward' resumption: the settled fulfillment or rejection of
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
 *
 * Architecture:
 * - The body ALWAYS runs on dep changes (including settle-triggered kicks) so
 *   r3 dep links are never dropped.
 * - Non-generator stages: resolved-value keyed cache. On settle, kick fires and
 *   the body re-runs. The new resolved value is compared with Object.is to the
 *   last resolved value; downstream is only invalidated if changed.
 *   Stale-while-revalidate: the last resolved value is returned during refetch.
 * - Generator stages: fast-forward + stash mechanism. The stash is consumed
 *   by the body when input matches, allowing the generator to resume correctly.
 */
// `any` here is the standard implementation-signature widening for the
// variadic overloads above; narrowing to `unknown` breaks the overload contract.
function makeStageNode(
  stage: (value: any) => unknown,
  inputAccessor: Signal<unknown> | null,
): { accessor: Signal<unknown>; r3Node: R3Computed<unknown> } {
  const myOwner = getOwner()
  const resumeKind: ResumeKind = isGeneratorFunction(stage) ? 'fast-forward' : 'reuse-value'

  // Sentinel for "first load — no resolved value yet."
  const UNRESOLVED = Symbol('unresolved')
  let lastResolvedValue: unknown = UNRESOLVED
  let suspendedOn: Promise<unknown> | null = null
  let suspendedInput: unknown = undefined
  let stashedResolution: StashedResolution | null = null
  let deferredError: { error: unknown } | null = null

  // Published view value: settle handler updates this DIRECTLY (out-of-band)
  // so body doesn't re-run on settle. Consumers reading the accessor get this.
  const [publishedValue, setPublishedValue] = signal<unknown>(UNRESOLVED as unknown)

  // Reactive pending state. Brand on accessor exposes this to `isPending()`.
  const [pendingSig, setPendingSig] = signal(false)

  // Generator-only kick: drives body re-run so the generator-driver can
  // fast-forward through the WeakMap-cached settled yields. Non-generator
  // stages never trigger this (they publish via setPublishedValue directly).
  const [kick, setKick] = signal(0)
  let kickCount = 0

  // dep-tracker: runs the body for r3 dep tracking. Side-effects into
  // publishedValue / pendingSig. Its OWN return value is irrelevant — we
  // never read it for the value.
  const depTracker = r3Computed(() => {
    try {
      kick() // dep so generator stash-rerun can force body re-run

      let input: unknown = undefined
      if (inputAccessor !== null) {
        input = inputAccessor()
        if (isPromise(input)) {
          // Upstream stage suspended; mirror its state.
          stashedResolution = null
          suspendedOn = null
          setPendingSig(true)
          if (lastResolvedValue === UNRESOLVED) {
            setPublishedValue(input)
          }
          // else: stale-while-revalidate
          return null
        }
      }

      // Non-generator stages can stash a resolved value to consume on next
      // body invocation. (Generators don't stash — they re-invoke from the top
      // and the driver's WeakMap fast-forwards through settled yields.)
      if (resumeKind === 'reuse-value' && stashedResolution !== null) {
        if (Object.is(input, suspendedInput)) {
          const r = stashedResolution
          stashedResolution = null
          suspendedOn = null
          setPendingSig(false)
          if (r.kind === 'rejected') {
            deferredError = { error: r.reason }
            setPublishedValue(r.reason)
            return null
          }
          lastResolvedValue = r.value
          deferredError = null
          setPublishedValue(r.value)
          return null
        }
        stashedResolution = null
      }

      const outcome = runStage(stage, input)

      if (outcome.pending) {
        const p = outcome.promise
        if (suspendedOn !== p) {
          // New (or different) Promise → suspend on it.
          suspendedOn = p
          suspendedInput = input
          setPendingSig(true)
          // First-load: publish the Promise. Refetch: keep stale value visible.
          if (lastResolvedValue === UNRESOLVED) {
            setPublishedValue(p)
          }
          // else: stale-while-revalidate (don't update publishedValue)

          const rerun = () => {
            if (suspendedOn !== p) return // superseded
            const state = track(p)
            if (state.status === 'fulfilled') {
              suspendedOn = null
              setPendingSig(false)
              if (resumeKind === 'fast-forward') {
                // Generators: no stash. Kick → body re-runs → generator
                // re-invokes from top; driver fast-forwards via WeakMap and
                // returns the GENERATOR'S TRUE RETURN (which may be a
                // transformation of the yielded value).
                setKick(++kickCount)
                return
              }
              // Non-generators: resolved-value-keyed cache. Publish only on change.
              if (
                lastResolvedValue === UNRESOLVED ||
                !Object.is(lastResolvedValue, state.value)
              ) {
                lastResolvedValue = state.value
                deferredError = null
                setPublishedValue(state.value)
              }
              // else: same value, no downstream invalidation
            } else if (state.status === 'rejected') {
              suspendedOn = null
              setPendingSig(false)
              if (resumeKind === 'fast-forward') {
                // Generators handle rejection via their own try/catch around
                // yield. Kick → body re-runs → driver re-throws on the yield,
                // generator catches (or doesn't), runStage returns/throws.
                setKick(++kickCount)
                return
              }
              deferredError = { error: state.reason }
              // Bump publishedValue to dirty consumers so they re-read and throw.
              setPublishedValue(state.reason)
            }
          }
          p.then(rerun, rerun)
        }
        // No body return value — view is via publishedValue.
        return null
      }

      // Sync result.
      suspendedOn = null
      setPendingSig(false)
      if (
        lastResolvedValue === UNRESOLVED ||
        !Object.is(lastResolvedValue, outcome.value)
      ) {
        lastResolvedValue = outcome.value
        setPublishedValue(outcome.value)
      }
      deferredError = null
      return null
    } catch (e) {
      try {
        routeError(myOwner, e)
      } catch (rethrown) {
        deferredError = { error: rethrown }
      }
      return null
    }
  })

  // User-facing accessor: reads depTracker (to register as sub so dep
  // changes propagate AND to trigger lazy first eval) and publishedValue
  // (the actual view value). Surfaces parked errors.
  const accessor = (() => {
    if (deferredError !== null) throw deferredError.error
    r3Read(depTracker as R3Computed<unknown>)
    return publishedValue()
  }) as Signal<unknown>
  accessor[NODE] = depTracker as R3Computed<unknown>
  // Pipeline-aware pending: this stage is pending if its own fetch is in flight
  // OR any upstream stage is. Necessary because SWR hides upstream Promises
  // (downstream stages see the prior resolved value during a refetch, so their
  // own pendingSig stays false even though the pipeline is mid-refetch).
  const upstreamPending = inputAccessor?.[PENDING]
  accessor[PENDING] = upstreamPending
    ? () => pendingSig() || upstreamPending()
    : pendingSig
  return { accessor, r3Node: depTracker as R3Computed<unknown> }
}
