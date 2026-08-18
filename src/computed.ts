import { cancelRecompute, computed as r3Computed, getContext as r3GetContext, isRecomputeQueued, read as r3Read, setSignal as r3SetSignal, untrack as r3Untrack, unwatched, type Computed as R3Computed, type Signal as R3Signal } from 'r3'
import { isGeneratorFunction, NotReadyYet, resolvedPromise, track, type PromiseState, type PipelineRead, type Resolved } from './async'
import { runStage, resumeStage, takeGeneratorCleanups, type StageOutcome } from './driver'
import { replayDeps, snapshotDeps, type DepRecord } from './dep-replay'
import { isPromise } from './is-promise'
import { getOwner, routeError, registerWithOwner } from './owner'
import { peekValue } from './scope'
import { makeAccessor, NODE, signal, signalWithNode, type Accessor, type Signal } from './signal'
import { registerPending, lookupPending } from './pending'
import { registerFailure, lookupFailure } from './failure'
import { requestFlush } from './scheduler'
import { markFailureSource } from './transition-tracker'

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
 * - Generator stage → 'fast-forward': the paused generator is retained and re-entered
 *   with the settled value, so the code before the pause does not run again.
 *   The dependencies r3 recorded before the pause are replayed first, both to
 *   keep them linked and to detect a change — a changed dependency discards the
 *   generator (running its `finally` blocks) and runs a fresh one from the top.
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
  const built = buildStages(stages)
  return built[built.length - 1].accessor
}

/**
 * Build a pipeline of stages and return a handle per stage, in order. Disposal
 * walks stages in creation order (upstream to downstream). Each
 * `unwatched(stageN)` removes that node from its dependencies' subscriber lists;
 * if stage N+1 was the only consumer of stage N, stage N would have auto-cleaned
 * via r3's `unwatched` cascade anyway. Every stage is disposed explicitly to be
 * robust against external consumers of intermediate stages (though pulse does
 * not currently expose them).
 *
 * Exported so the writable form can build the same pipeline and keep the
 * per-stage handles, which is what lets its setter reach every stage.
 */
export function buildStages(stages: Array<(value: any) => unknown>): StageHandle[] {
  if (stages.length === 0) {
    throw new Error('computed requires at least one stage')
  }
  const built: StageHandle[] = []
  let inputAccessor: Signal<unknown> | null = null
  for (const stage of stages) {
    const handle = makeStageNode(stage, inputAccessor)
    built.push(handle)
    inputAccessor = handle.accessor
  }
  registerWithOwner({
    dispose: () => {
      for (const handle of built) unwatched(handle.r3Node)
    },
  })
  return built
}

/** What `makeStageNode` hands back: the stage's public accessor plus the
 *  operations the writable form needs to reach it. */
export type StageHandle = {
  accessor: Signal<unknown>
  r3Node: R3Computed<unknown>
  publishValue: (value: unknown) => void
  applyWriteEffects: (value: unknown) => void
  readPrev: () => unknown
  withdrawQueuedRun: (isTail: boolean) => void
  abandonRun: () => void
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
 * - Generator stages: the paused generator is retained (`retainedGen`) rather
 *   than rebuilt. On settle, the body replays the dependencies recorded up to
 *   the pause (`depRecords`) to keep them linked, and resumes the generator
 *   forward with the settled value or rejection (`resumeWith`) — unless a
 *   replayed dependency changed, in which case the stale generator is
 *   discarded and a fresh one runs from the top.
 */
// `any` here is the standard implementation-signature widening for the
// variadic overloads above; narrowing to `unknown` breaks the overload contract.
function makeStageNode(
  stage: (value: any) => unknown,
  inputAccessor: Signal<unknown> | null,
): StageHandle {
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

  // A generator stage that pauses is retained here rather than rebuilt, so the
  // code before the pause does not run again. `depRecords` is what r3 had
  // recorded as this node's dependencies at the moment it paused; replaying
  // them on the next run keeps them linked (r3 unlinks anything a run does not
  // read) and says whether any of them changed. `resumeWith` carries the
  // settled outcome from the settle handler to the next body invocation,
  // because the handler clears `suspendedOn` before it kicks.
  let retainedGen: Generator<unknown, unknown, unknown> | null = null
  let depRecords: DepRecord[] = []
  let resumeWith: StashedResolution | null = null
  // True exactly while `suspendedOn` holds the promise `retainedGen` itself
  // paused on (yielded, and the driver returned it pending). Discarding that
  // generator should clear `suspendedOn`/`suspendedInput` along with it — see
  // `discardGen` below. This is distinct from `suspendedOn` being set by the
  // `NotReadyYet` catch further down: a generator whose body calls `use(x)`
  // directly throws that out of `gen.next()` before ever reaching a `yield`,
  // so it terminates without ever owning a suspension — `retainedGen` gets
  // set (recorded the instant the driver creates it), but `genOwnsSuspension`
  // stays false. That distinction matters because the `NotReadyYet` catch's
  // own `suspendOn` call manages a same-promise dedup guard
  // (`if (suspendedOn === p) return`, in `suspendOn` below) across repeated
  // hits on a promise that is still pending: clearing `suspendedOn` out from
  // under that guard on every hit would make it re-attach a `.then` listener
  // every time instead of once, and fire its settle callback once per
  // attachment when the promise finally settles.
  let genOwnsSuspension = false

  /**
   * End a generator: run its `finally` blocks if it has not already finished,
   * then its registered cleanups, most recently registered first. Untracked,
   * because teardown reads must not join this node's dependency list.
   *
   * `viaReturn` is true when the generator is being abandoned part-way and
   * false when it has already run to completion, in which case its `finally`
   * blocks have run and returning it again would be a no-op.
   */
  const endGen = (
    gen: Generator<unknown, unknown, unknown>,
    viaReturn: boolean,
  ): void => {
    retainedGen = null
    depRecords = []
    resumeWith = null
    // No generator is retained now, so nothing can be waiting on a pause to
    // carry it forward. The flag is already false on every path that reaches
    // here today; clearing it keeps that true by construction rather than by
    // an argument a later change could invalidate.
    genOwnsSuspension = false
    const cleanups = takeGeneratorCleanups(gen)
    try {
      r3Untrack(() => {
        if (viaReturn) gen.return(undefined)
        for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]()
      })
    } catch (e) {
      try {
        routeError(myOwner, e)
      } catch (rethrown) {
        setFailureSig(rethrown)
      }
    }
  }

  /** Abandon a generator that has not finished. */
  const discardGen = (): void => {
    const gen = retainedGen
    retainedGen = null
    depRecords = []
    resumeWith = null
    if (genOwnsSuspension) {
      // The generator being discarded is the one `suspendedOn` currently
      // belongs to (see `genOwnsSuspension`'s comment above) — clear the
      // in-flight-promise field and its recorded input along with it, or an
      // abandoned promise's settle callback still matches (`suspendedOn ===
      // p`) after the discard and kicks a spurious extra run of whatever
      // generator replaces it.
      suspendedOn = null
      suspendedInput = undefined
      genOwnsSuspension = false
    }
    if (gen !== null) endGen(gen, true)
  }

  // Owner disposal must reach a paused generator, not just unlink the r3 node,
  // so that a generator holding something across its pause releases it.
  registerWithOwner({ dispose: discardGen })

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

  // Generator-only kick: drives body re-run so a paused generator's retained
  // dependencies get replayed and the generator resumes forward. Non-generator
  // stages never trigger this (they publish via setPublishedValue directly).
  const [kick, setKick] = signal(0)
  // `kickNode` is handed to `snapshotDeps` so this signal is left out of the
  // recorded dependencies. The settle handler bumps it deliberately to force a
  // run, so recording it would make every settle look like someone else's
  // change — and the stage would restart every time instead of resuming.
  // `kick[NODE]` (not the `signalWithNode` scope wrapper) is what r3 actually
  // links into a computed's dependency list when the body reads `kick()` — the
  // same r3 node identity `publishedValue[NODE]` uses elsewhere in this file.
  const kickNode = (kick as Signal<number>)[NODE]
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
      // body invocation. (Generators have their own stash, `resumeWith` —
      // handled separately below, in the `retainedGen` branch — because a
      // generator resumes forward from its pause rather than re-invoking from
      // the top.)
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

      let outcome: StageOutcome
      if (retainedGen !== null) {
        // A generator is paused. Replaying the recorded dependencies keeps them
        // linked for this run and reports whether any of them changed.
        const changed = replayDeps(depRecords) || !Object.is(input, suspendedInput)
        const resumption = resumeWith
        resumeWith = null
        if (changed) {
          // Something the generator already read is different, so its partial
          // computation is stale. A generator cannot be rewound, only resumed
          // forward or replaced — so replace it.
          discardGen()
          outcome = runStage(stage, input, (gen) => {
            retainedGen = gen
          })
        } else if (resumption === null) {
          // The body re-ran while the generator is still waiting and nothing
          // has settled. Stay paused; the dependencies were re-read above, so
          // they remain linked.
          return null
        } else {
          const gen = retainedGen
          depRecords = []
          outcome =
            resumption.kind === 'fulfilled'
              ? resumeStage(gen, { throw: false, value: resumption.value })
              : resumeStage(gen, { throw: true, reason: resumption.reason })
        }
      } else {
        // Recorded as `retainedGen` the instant the driver creates it — not
        // only if it pauses — so a generator that completes or throws
        // entirely synchronously is still reachable below for cleanup, the
        // same as one that paused and later settled.
        //
        // A stashed resumption belongs to the generator it was recorded for.
        // There is no retained generator here, so any leftover stash is not
        // this fresh generator's to consume — clear it so the invariant
        // (`resumeWith` is non-null only while the retained generator is the
        // one it belongs to) holds even if something upstream left it set.
        resumeWith = null
        outcome = runStage(stage, input, (gen) => {
          retainedGen = gen
        })
      }

      // A generator that did not pause has run to completion — whether it was
      // resumed and finished, or ran straight through on this very call. Its
      // `finally` blocks have already run, so only its registered cleanups fire.
      //
      // A pending outcome carrying no generator means the same thing. The driver
      // hands the generator back only when a `yield` paused it; a generator that
      // RETURNED a promise is finished, and that promise is its result rather
      // than a pause to re-enter. Leaving it retained would strand the stage:
      // the next run would find a finished generator, replay an empty dependency
      // record, see nothing to resume, and return early forever.
      if (retainedGen !== null && (!outcome.pending || outcome.gen === undefined)) {
        endGen(retainedGen, false)
      }

      if (outcome.pending) {
        if (outcome.gen !== undefined) {
          retainedGen = outcome.gen
          // `suspendOn` just below is about to set `suspendedOn` to this
          // generator's own pause promise — mark it as owned so a discard
          // knows to clear it (see `genOwnsSuspension`'s comment above).
          genOwnsSuspension = true
          // The node being recomputed is the current r3 context. Reading it from
          // there rather than from `depTracker` avoids a temporal dead zone: r3
          // invokes the body while `const depTracker = r3Computed(...)` is still
          // being initialised.
          const self = r3GetContext()
          // `kickNode` is excluded: the settle handler bumps it to force this
          // run, so recording it would report a change on every settle.
          depRecords = self === null ? [] : snapshotDeps(self, kickNode)
        }
        suspendOn(outcome.promise, input, (state) => {
          // Does a retained generator wait on this pause to carry it forward?
          // Only a `yield` produces one. A generator that RETURNED a promise is
          // already finished, so its settle publishes the value directly, the
          // same way a sync or async-function stage's does — there is no body
          // left to re-enter, and re-entering a finished generator would publish
          // `undefined`.
          const resumesGenerator = genOwnsSuspension
          if (state.status === 'fulfilled') {
            suspendedOn = null
            // The pause this settle resolves is no longer the one
            // `suspendedOn` reflects (it was just cleared above), so a
            // later discard of `retainedGen` must not touch it again.
            genOwnsSuspension = false
            setPendingSig(false)
            if (resumesGenerator) {
              // Stash the fulfilled value for the retained generator's next
              // resumption, then kick → body re-runs → sees the paused
              // generator, replays its recorded deps, and resumes it forward
              // from this pause (see the `retainedGen` branch above).
              resumeWith = { kind: 'fulfilled', value: state.value }
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
            genOwnsSuspension = false
            setPendingSig(false)
            if (resumesGenerator) {
              // Stash the rejection for the retained generator's next
              // resumption, so it is thrown at the pause point — the
              // generator's own try/catch handles it (or doesn't).
              resumeWith = { kind: 'rejected', reason: state.reason }
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
        // A stage body called `use(pending)` and threw the suspension signal.
        // Treat identically to a stage that returned a pending Promise: set up
        // the same suspendOn + settle machinery.
        //
        // A generator stage body reaches this catch too: `use(x)` inside a
        // generator body throws NotReadyYet out of `gen.next()` synchronously
        // (it does not route through a `yield`), through the driver, and out
        // of `runStage` uncaught, landing here just like a sync stage's throw.
        // `retainedGen` was set the instant the driver created the generator
        // (see the comment above), but that generator has already terminated
        // — `depRecords` is empty and it will never be resumed — so it must be
        // discarded here. Otherwise every later run takes the `retainedGen`
        // resume path: replaying an empty dependency list reports no change,
        // the input still matches, and there is no stashed resumption, so the
        // body returns early forever.
        discardGen()
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
        discardGen()
        routeError(myOwner, e)
      } catch (rethrown) {
        setFailureSig(rethrown)
      }
      return null
    }
  })

  // ---- write path -------------------------------------------------------

  /** The last resolved value, or undefined when there is none. Never the
   *  sentinel, never a promise. */
  const lastResolvedOrUndefined = (): unknown =>
    lastResolvedValue === UNRESOLVED ? undefined : lastResolvedValue

  /** What an update function is handed: the last resolved value as seen from
   *  the current scope. Reads the published value through `peekValue`, so a
   *  speculative write earlier in the same action is visible, and resolves it —
   *  a settled promise unwraps, a pending one falls back to the committed last
   *  resolved value.
   *
   *  A stage's body runs at creation, not on first read — r3 evaluates a
   *  computed's body the moment it is made, when nothing else is already
   *  running (see `makeStageNode`'s `depTracker`). So `undefined` here does
   *  not mean "the derivation has not run yet"; it means nothing has RESOLVED
   *  yet — the stage ran and is still pending (async), or has not settled.
   *  A synchronous stage has a real value the instant `signal(fn)` returns,
   *  before any explicit read. */
  const readPrev = (): unknown => {
    const seen = r3Untrack(() => peekValue(publishedNode))
    if (seen === UNRESOLVED) return lastResolvedOrUndefined()
    if (!isPromise(seen)) return seen
    const state = track(seen as Promise<unknown>)
    return state.status === 'fulfilled' ? state.value : lastResolvedOrUndefined()
  }

  /** Whether a bare write has to be wrapped so the read keeps its asynchronous
   *  colour. Uses the same coarse test the publish path uses, so a write does
   *  not flip the shape a consumer sees. */
  const writeWrapsInPromise = (): boolean =>
    resumeKind === 'fast-forward' || lastPublishedShapeIsPromise

  /** Write the published value. Scope-aware: inside an action this installs a
   *  slot rather than touching committed state. */
  const publishValue = (value: unknown): void => {
    if (isPromise(value)) {
      setPublishedValue(value)
      return
    }
    setPublishedValue(writeWrapsInPromise() ? resolvedPromise(value) : value)
  }

  /** Everything a write implies that is not scope-aware. Runs immediately for a
   *  committed write, and at commit for one made inside an action. */
  const applyWriteEffects = (value: unknown): void => {
    if (isPromise(value)) return // handled in a later task
    lastResolvedValue = value
    lastPublishedShapeIsPromise = writeWrapsInPromise()
  }

  /**
   * Withdraw a run that is queued but has not started — the case where an
   * invalidation scheduled a recompute earlier in the same tick and a write
   * now supersedes it before it ever ran. `isTail` is true for the stage a
   * write lands on, which is left clean because the write supplied its value;
   * every other stage is left needing recomputation, because its input moved
   * and its published value no longer reflects that.
   *
   * Pure: nothing observes a recompute that never ran, so this has to happen
   * before anything reads the graph — before the value is computed (an update
   * function's `readPrev` peeks the previous value) and before it is published
   * (publishing seeds the tolerant read). Either of those reads a pulse signal
   * outside any reactive context, which stabilizes the whole graph — and that
   * stabilize would run the very queued recompute this is trying to withdraw,
   * before withdrawal gets the chance. For the same reason this reads no
   * signal itself: `isRecomputeQueued` is a flag test, not a signal read, and
   * `hadWork` below reads only local closure state.
   *
   * Refuses a stage whose own body is the caller.
   */
  const withdrawQueuedRun = (isTail: boolean): void => {
    const self = depTracker as R3Computed<unknown>
    if (r3GetContext() === self) return
    // A stage can be pending purely by mirroring an upstream suspension (see
    // the `isPromise(input)` branch above), with no generator or promise of
    // its own. That does not belong in `hadWork`: `cancelRecompute`'s effect
    // is governed entirely by `isRecomputeQueued`, so the only thing `hadWork`
    // needs to ask is whether THIS stage has real local work outstanding —
    // a mirrored pending flag is not that, and adding it here would only
    // force a non-tail stage with nothing queued to be marked dirty for no
    // reason. The mirrored case is `abandonRun`'s concern, not this one: it
    // runs unconditionally and clears the pending signal regardless.
    const hadWork = retainedGen !== null || suspendedOn !== null
    if (!hadWork && !isRecomputeQueued(self)) return
    cancelRecompute(self, !isTail)
  }

  /**
   * Abandon a run that is executing or paused — an in-flight fetch, or a
   * generator suspended on one. Discarding a generator calls its `return`
   * method, which runs its cleanup callbacks, so this happens after the value
   * is published: a cleanup that reads the signal it was abandoned by must see
   * the write that triggered the abandonment, not the value it is replacing.
   *
   * Refuses a stage whose own body is the caller. Discarding a generator calls
   * its `return` method, and calling that on a generator which is currently
   * executing raises a TypeError.
   *
   * No guard beyond re-entrancy: discarding when there is nothing to discard,
   * and clearing fields that are already clear, are both harmless.
   */
  const abandonRun = (): void => {
    const self = depTracker as R3Computed<unknown>
    if (r3GetContext() === self) return
    discardGen()
    suspendedOn = null
    suspendedInput = undefined
    stashedResolution = null
    setPendingSig(false)
  }

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
    if (err !== null) {
      // Tell the binding that catches this WHICH node failed, so it can reset the
      // right one. The failure may be parked on a computed created far outside the
      // boundary that ends up collecting the binding.
      markFailureSource(accessor)
      throw err
    }
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
    // Clear the parked failure and re-run the body. The kick is a dep of the body,
    // so the stage re-executes from the top and suspends on a fresh promise —
    // a genuine retry with unchanged inputs.
    reset: () => {
      // A retry starts the computation over rather than resuming a generator
      // that failed part-way through.
      discardGen()
      setFailureSig(null)
      setKick(++kickCount)
    },
    upstream: inputAccessor
      ? lookupFailure(inputAccessor as Accessor<unknown>)
      : undefined,
  })

  return {
    accessor,
    r3Node: depTracker as R3Computed<unknown>,
    publishValue,
    applyWriteEffects,
    readPrev,
    withdrawQueuedRun,
    abandonRun,
  }
}
