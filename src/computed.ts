import { computed as r3Computed, read as r3Read, setSignal as r3SetSignal, unwatched, type Computed as R3Computed, type Signal as R3Signal } from 'r3'
import { isGeneratorFunction, NotReadyYet, resolvedPromise, track, type PromiseState, type PipelineRead, type Resolved } from './async'
import { runStage } from './driver'
import { isPromise } from './is-promise'
import { getOwner, routeError, registerWithOwner } from './owner'
import { makeAccessor, NODE, signal, signalWithNode, type Accessor, type Signal } from './signal'
import { registerPending, lookupPending } from './pending'
import { registerFailure, lookupFailure } from './failure'
import { requestFlush } from './scheduler'

/** A pipeline stage of any shape: sync, async, or generator. The return type
 *  is whatever the function returns — sync `R`, async `Promise<R>`, or
 *  `Generator<…, R, …>`. The pipeline unwraps to `Resolved<R>` for the next stage. */
type Stage<In, Out> = (value: In) => Out

// Overloads: stage N's input is `Resolved<stage N-1's return type>`; the pipeline
// result is `Resolved<last stage's return type>`.
export function computed<A>(s0: () => A): Signal<PipelineRead<[], A>>
export function computed<A, B>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
): Signal<PipelineRead<[A], B>>
export function computed<A, B, C>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
): Signal<PipelineRead<[A, B], C>>
export function computed<A, B, C, D>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
): Signal<PipelineRead<[A, B, C], D>>
export function computed<A, B, C, D, E>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
  s4: Stage<Resolved<D>, E>,
): Signal<PipelineRead<[A, B, C, D], E>>

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
  // The last value this stage actually resolved to. Kept as a small private
  // cache even though the published signal already holds a value, because the
  // two answer different questions: the published value may be a settled value,
  // a promise still in flight, an error, or the "nothing yet" sentinel above,
  // while this is only ever the last real resolved value. It is read to tell a
  // first load apart from a refresh, and to skip re-publishing when a stage
  // resolves to the same value it had before.
  let lastResolvedValue: unknown = UNRESOLVED
  // Whether the last publish wrapped the value in a promise. The change-gate
  // keys on the resolved value alone, so without this a shape flip at the same
  // value (bare<->promise, e.g. a downstream stage settling to a bare input
  // after briefly seeing a fulfilled upstream promise) would be suppressed.
  let lastPublishedShapeIsPromise = false
  let suspendedOn: Promise<unknown> | null = null
  let suspendedInput: unknown = undefined
  let stashedResolution: StashedResolution | null = null

  // The parked failure, as reactive graph state — the mirror of pendingSig. A
  // consumer subscribes to it through the accessor, so it re-runs when this node
  // fails or recovers. Crucially the failure lives HERE and not in publishedValue:
  // the published value keeps holding the last resolved value, so a tolerant read
  // (`latest`) can degrade to it instead of blowing up. Pending already works this
  // way — it holds the prior value and tracks the in-flight promise out of band.
  const [failureSig, setFailureSig] = signal<unknown>(null)

  // Published view value: settle handler updates this DIRECTLY (out-of-band)
  // so body doesn't re-run on settle. Consumers reading the accessor get this.
  const [publishedValue, setPublishedValue, publishedNode] = signalWithNode<unknown>(
    UNRESOLVED as unknown,
  )

  // Speculation: give the published node a recipe so the overlay can recompute this
  // stage INSIDE a speculative scope. `readValue` only takes the defaultRecipe
  // branch when the scope is not root, so the committed path below is untouched —
  // but under an action, reading this computed runs the stage into a per-scope slot,
  // and the upstream reads inside it resolve to their speculative values. That is
  // what lets a speculative write flow into derived state.
  publishedNode.defaultRecipe = () => {
    let input: unknown = undefined
    if (inputAccessor !== null) {
      input = inputAccessor()
      if (isPromise(input)) {
        const st = track(input as Promise<unknown>)
        // A settled upstream unwraps, as on the committed path. A still-pending one
        // is handed back as the promise: the suspend/settle machinery is r3-driven
        // and does not run inside a speculation (see the note in the speculation
        // tests) — async under speculation is not supported yet.
        if (st.status === 'fulfilled') input = st.value
        else return input
      }
    }
    const outcome = runStage(stage, input)
    return outcome.pending ? outcome.promise : outcome.value
  }

  // Publish a fresh fulfilled promise straight to the r3 backing node. This runs
  // in an onSettle .then handler (async context, getContext()===null); writing
  // directly skips the signal setter's promise-tracking branch, which is
  // redundant here anyway — resolvedPromise has already recorded the state. A
  // fresh promise object each settle is what re-fires consumers.
  const publishResolvedPromise = (value: unknown): void => {
    lastPublishedShapeIsPromise = true
    r3SetSignal((publishedValue as Signal<unknown>)[NODE] as R3Signal<unknown>, resolvedPromise(value))
    requestFlush()
  }

  // Reactive pending state. Exposed to `isPending()` via the external
  // registry entry constructed below.
  const [pendingSig, setPendingSig] = signal(false)

  // Generator-only kick: drives body re-run so the generator-driver can
  // fast-forward through the WeakMap-cached settled yields. Non-generator
  // stages never trigger this (they publish via setPublishedValue directly).
  const [kick, setKick] = signal(0)
  let kickCount = 0

  // Shared envelope: assign suspendedOn/suspendedInput, flip pendingSig,
  // publish the Promise on first-load (else SWR), and wire settle handlers.
  // Per-callsite settle behavior is delegated to `onSettle`.
  const suspendOn = (
    p: Promise<unknown>,
    input: unknown,
    onSettle: (state: PromiseState) => void,
  ) => {
    if (suspendedOn === p) return
    suspendedOn = p
    suspendedInput = input
    setPendingSig(true)
    if (lastResolvedValue === UNRESOLVED) {
      track(p)
      setPublishedValue(p)
    }
    // else: stale-while-revalidate — prior value stays published (no republish
    // during SWR: publishing a fresh promise would fire downstream unnecessarily,
    // breaking the Object.is change-gate tests)
    const rerun = () => {
      if (suspendedOn !== p) return // superseded
      onSettle(track(p))
    }
    p.then(rerun, rerun)
  }

  // dep-tracker: runs the body for r3 dep tracking. Side-effects into
  // publishedValue / pendingSig. Its OWN return value is irrelevant — we
  // never read it for the value.
  const depTracker = r3Computed(() => {
    try {
      kick() // dep so generator stash-rerun can force body re-run

      let input: unknown = undefined
      // Did this evaluation's input arrive as a promise (an async upstream)? If
      // so, a synchronous final stage still publishes a promise, so the read
      // stays honest to the pipeline's async colour instead of flipping to bare.
      let inputWasAsync = false
      if (inputAccessor !== null) {
        input = inputAccessor()
        if (isPromise(input)) {
          inputWasAsync = true
          const st = track(input as Promise<unknown>)
          if (st.status === 'fulfilled') {
            // Settled upstream: unwrap to the bare resolved value and fall
            // through to normal stage execution.
            input = st.value
          } else {
            // Pending upstream: mirror suspension on the promise itself.
            stashedResolution = null
            suspendedOn = null
            setPendingSig(true)
            if (lastResolvedValue === UNRESOLVED) {
              track(input as Promise<unknown>)
              setPublishedValue(input)
            }
            // else: stale-while-revalidate — prior value stays published
            return null
          }
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
            // Park the failure as graph state; leave publishedValue holding the
            // stale value so a tolerant read can still degrade to it.
            setFailureSig(r.reason)
            return null
          }
          lastResolvedValue = r.value
          setFailureSig(null)
          setPublishedValue(resolvedPromise(r.value))
          return null
        }
        stashedResolution = null
      }

      const outcome = runStage(stage, input)

      if (outcome.pending) {
        suspendOn(outcome.promise, input, (state) => {
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
            // Non-generators: resolved-value-keyed cache. Publish on a value
            // change OR a shape flip — this path always publishes a promise, so
            // it must re-publish when the last published value was bare (a
            // conditionally-async stage flipping back to its promise branch at an
            // unchanged value), which the value-only gate would otherwise suppress.
            if (
              lastResolvedValue === UNRESOLVED ||
              !Object.is(lastResolvedValue, state.value) ||
              !lastPublishedShapeIsPromise
            ) {
              lastResolvedValue = state.value
              setFailureSig(null)
              publishResolvedPromise(state.value)
            }
            // else: same value, already a promise — no downstream invalidation
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
            // Park the failure as graph state. Do NOT publish the reason over the
            // value: that used to destroy the last resolved value, which is what a
            // tolerant read (`latest`) needs to degrade to. Consumers are dirtied
            // by the failure signal instead, which the accessor reads.
            setFailureSig(state.reason)
          }
        })
        // No body return value — view is via publishedValue.
        return null
      }

      // Sync result.
      suspendedOn = null
      setPendingSig(false)
      // Publish a promise when the stage is async-coloured — a generator, or a
      // synchronous stage fed by an async upstream — so the read stays a Promise.
      // A purely synchronous stage (sync input, sync body) publishes the bare
      // value. Re-publish when the value changes OR the shape flips at the same
      // value (the change-gate keys on value alone).
      const asPromise = resumeKind === 'fast-forward' || inputWasAsync
      if (
        lastResolvedValue === UNRESOLVED ||
        !Object.is(lastResolvedValue, outcome.value) ||
        asPromise !== lastPublishedShapeIsPromise
      ) {
        lastResolvedValue = outcome.value
        lastPublishedShapeIsPromise = asPromise
        if (asPromise) {
          setPublishedValue(resolvedPromise(outcome.value))
        } else {
          setPublishedValue(outcome.value)
        }
      }
      setFailureSig(null)
      return null
    } catch (e) {
      if (e instanceof NotReadyYet) {
        // Sync/async-function stage body called `use(pending)` and threw the
        // suspension signal. Treat identically to a stage that returned a
        // pending Promise: set up the same suspendOn + settle machinery.
        // Generator stages route suspension via their driver and never reach
        // this catch with a NotReadyYet.
        suspendOn(e.promise, /* input */ undefined, (state) => {
          if (state.status === 'fulfilled') {
            suspendedOn = null
            setPendingSig(false)
            // Re-run body via kick (resolved-value cache is meaningless here
            // because the throw means body never returned — re-execute fully).
            // Stash the resolved value first so that SWR works: if the body
            // throws again on re-run (e.g. it creates a fresh promise), the
            // suspendOn path sees lastResolvedValue != UNRESOLVED and holds
            // the prior value visible while the new promise is in-flight.
            if (
              lastResolvedValue === UNRESOLVED ||
              !Object.is(lastResolvedValue, state.value)
            ) {
              lastResolvedValue = state.value
              setFailureSig(null)
              // Publish the prior as a BARE value, not a promise: a use()-suspended
              // stage is sync-typed (use erases the async colour), so it must not
              // look async to a downstream stage. The kick below re-runs the body
              // and publishes the stage's real result.
              setPublishedValue(state.value)
            }
            setKick(++kickCount)
          } else if (state.status === 'rejected') {
            suspendedOn = null
            setPendingSig(false)
            setFailureSig(state.reason)
            setKick(++kickCount)
          }
        })
        return null
      }
      try {
        routeError(myOwner, e)
      } catch (rethrown) {
        setFailureSig(rethrown)
      }
      return null
    }
  })

  // User-facing accessor: reads depTracker (to register as sub so dep
  // changes propagate AND to trigger lazy first eval) and publishedValue
  // (the actual view value). Surfaces parked errors.
  const accessor = (() => {
    // Subscribe to ALL THREE before any throw, even on the error path:
    //  - depTracker triggers the lazy first eval (its own value is always null, so
    //    it never fires on its own),
    //  - publishedValue changes when this computed produces a new value,
    //  - failureSig changes when it fails or recovers.
    // Throwing before those reads would leave a consumer that catches the error
    // with no subscription, so a later successful refetch could never reach it and
    // a single transient failure would be permanent. (Same reasoning as `use()`,
    // which calls the accessor before its pending check.) Reading depTracker can
    // also set or clear the failure via the lazy eval, so the check belongs after.
    //
    // This is the STRICT view of the failure state: the raw read throws. The
    // tolerant view (`latest`) reads publishedValue directly and degrades to it;
    // the query view is `failure(x)`.
    r3Read(depTracker as R3Computed<unknown>)
    const value = publishedValue()
    const err = failureSig()
    if (err !== null) throw err
    return value
  }) as Signal<unknown>
  accessor[NODE] = depTracker as R3Computed<unknown>

  // Register with the external pending tracker (Plan A foundation). The
  // entry stores LOCAL state (pendingSig + a function returning suspendedOn);
  // pipeline-OR walking is the tracker's job, driven by the `upstream` link.
  const upstreamEntry = inputAccessor
    ? lookupPending(inputAccessor as Accessor<unknown>)
    : undefined
  registerPending(accessor, {
    pending: pendingSig,
    promise: () => suspendedOn,
    upstream: upstreamEntry,
  })

  // Register with the failure tracker — the same shape, walked the same way.
  // `value` is the raw, non-throwing read of the published value, which is what
  // lets a tolerant read degrade to the stale value instead of throwing.
  registerFailure(accessor, {
    error: failureSig,
    // The raw read: the same subscriptions the accessor makes (lazy first eval via
    // depTracker, plus the value) but WITHOUT the throw. Reading publishedValue
    // alone would not trigger the lazy eval, so a never-read node would hand back
    // the "nothing yet" sentinel.
    value: () => {
      r3Read(depTracker as R3Computed<unknown>)
      return publishedValue()
    },
    upstream: inputAccessor
      ? lookupFailure(inputAccessor as Accessor<unknown>)
      : undefined,
  })

  return { accessor, r3Node: depTracker as R3Computed<unknown> }
}
