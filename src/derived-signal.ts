import { signal as valueSignal, type Accessor, type Setter } from './signal'
import { buildStages, type StageHandle } from './computed'
import { getCurrentScope, onSettledOn, ROOT_SCOPE, type Scope } from './scope'
import type { PipelineRead, Resolved } from './async'

/** A stage of any shape: sync, async, or generator. */
type Stage<In, Out> = (value: In) => Out

/**
 * The setter of a writable derivation.
 *
 * The value may be given bare or as a promise — a promise says "the value is
 * whatever this resolves to". The update form is handed the LAST RESOLVED
 * value, never a promise and never a sentinel, and `undefined` when the
 * derivation has not produced anything yet. Values are resolved on the write
 * side and inside a stage; the asynchronous colour is only visible on the read
 * side.
 */
export type DerivedSetter<T> = (
  next: T | Awaited<T> | ((prev: Awaited<T> | undefined) => T | Awaited<T>),
) => void

// The pipeline overloads are listed before the plain-value overload.
// TypeScript resolves a call against overloads in declaration order and stops
// at the first one that matches — it does not pick the most specific match
// across the whole list. The plain-value overload's `initial: T` accepts a
// function argument just as readily as a pipeline overload's `s0: () => A`
// does (T would simply be inferred as the function type itself), so if it
// came first every pipeline call would resolve to the value form instead.
// Listing the pipeline overloads first ensures a function argument is only
// ever matched by the plain-value overload once none of them fit — which
// only happens for a non-function argument, exactly the case that overload
// is for.
export function signal<A>(
  s0: () => A,
): [Accessor<PipelineRead<[], A>>, DerivedSetter<PipelineRead<[], A>>]
export function signal<A, B>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
): [Accessor<PipelineRead<[A], B>>, DerivedSetter<PipelineRead<[A], B>>]
export function signal<A, B, C>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
): [Accessor<PipelineRead<[A, B], C>>, DerivedSetter<PipelineRead<[A, B], C>>]
export function signal<A, B, C, D>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
): [Accessor<PipelineRead<[A, B, C], D>>, DerivedSetter<PipelineRead<[A, B, C], D>>]
export function signal<A, B, C, D, E>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
  s4: Stage<Resolved<D>, E>,
): [Accessor<PipelineRead<[A, B, C, D], E>>, DerivedSetter<PipelineRead<[A, B, C, D], E>>]
export function signal<T>(initial: T): [Accessor<T>, Setter<T>]

// `any` here is the standard implementation-signature widening for the variadic
// overloads above; narrowing to `unknown` breaks the overload contract.
export function signal(...args: any[]): [Accessor<any>, any] {
  if (typeof args[0] !== 'function') {
    return valueSignal(args[0])
  }
  return signalFromStages(...(args as Array<(value: any) => unknown>))
}

/** Run `effects` when the written value reaches the committed world. At the
 *  root that is now. Inside an action it is when that action commits — and for
 *  a nested action, only once the value has been promoted all the way out,
 *  since an inner commit promotes to its parent and the parent may still roll
 *  back. Reading the ambient scope is a plain module-level variable read and
 *  does not touch the graph, so callers may do it before anything else. */
function whenCommitted(scope: Scope, effects: () => void): void {
  if (scope === ROOT_SCOPE) {
    effects()
    return
  }
  onSettledOn(scope, (outcome) => {
    if (outcome !== 'committed') return
    whenCommitted(scope.parent ?? ROOT_SCOPE, effects)
  })
}

/** Withdraw a queued run on every stage. Pure — nothing observes it — so
 *  outside an action it runs immediately, before the value is even computed:
 *  computing an update function's value can read the graph via `readPrev`, and
 *  publishing does too, either of which would let a queued run slip past this
 *  check and run anyway. Inside an action the write may still roll back, so
 *  this is instead called again from inside `whenCommitted`, once the value
 *  has genuinely reached the committed world — withdrawing eagerly here would
 *  otherwise permanently lose a recompute an unrelated dependency change had
 *  queued, if the action that happened to write in between then rolled back. */
function withdrawQueuedRuns(built: StageHandle[], tail: StageHandle): void {
  for (let i = built.length - 1; i >= 0; i--) {
    built[i].withdrawQueuedRun(built[i] === tail)
  }
}

/** Build a pipeline and return it with a setter. `computed` builds the same
 *  stages and drops the setter. */
function signalFromStages(
  ...stages: Array<(value: any) => unknown>
): [Accessor<unknown>, DerivedSetter<unknown>] {
  const built = buildStages(stages)
  const tail = built[built.length - 1]

  const setter: DerivedSetter<unknown> = (next) => {
    const scope = getCurrentScope()

    if (scope === ROOT_SCOPE) withdrawQueuedRuns(built, tail)

    let value: unknown
    if (typeof next === 'function') {
      try {
        value = (next as (prev: unknown) => unknown)(tail.readPrev())
      } catch (e) {
        // No write is happening, so the withdrawal above was premature: it
        // left the tail clean on the promise that a write was about to
        // supply its value. With no value, the tail needs the same "recompute
        // when next pulled" state an upstream stage gets when its own run is
        // abandoned — otherwise a dependency change that queued a recompute
        // moments before this call is silently and permanently lost, with
        // nothing left to notice it. Only relevant at the root: inside an
        // action the withdrawal above never ran in the first place.
        if (scope === ROOT_SCOPE) tail.markNeedsRecomputation()
        throw e
      }
    } else {
      value = next
    }

    // Scope-aware: at the root this writes committed state; inside an action
    // it installs a slot that promotes on commit and vanishes on a discard.
    tail.publishValue(value)

    // Everything else touches state that is not scope-aware, so it waits
    // until the value is committed. Abandoning a run cannot be rolled back,
    // and the change-gate fields would otherwise be left describing a value
    // that was rolled back.
    whenCommitted(scope, () => {
      // At the root this already ran above, before the value was computed —
      // here only for a write that came from inside an action, where it could
      // not run any earlier without touching the graph before the write was
      // known to be committed.
      if (scope !== ROOT_SCOPE) withdrawQueuedRuns(built, tail)

      // Abandoning runs cleanup callbacks, so it happens after the publish —
      // a cleanup that reads the signal sees the write that triggered it. It
      // also has to happen BEFORE applyWriteEffects: abandoning the tail's
      // own pre-write run clears its suspendedOn field, and if that ran after
      // applyWriteEffects had already set suspendedOn to a just-written
      // promise, it would clobber the write's own suspension bookkeeping
      // rather than the stale one it is meant to clear.
      for (let i = built.length - 1; i >= 0; i--) {
        built[i].abandonRun()
        built[i].clearFailure()
      }

      // Last, so nothing written here is touched again. A written promise
      // sets up its own suspension in the same field abandonRun just cleared.
      tail.applyWriteEffects(value)
    })
  }

  return [tail.accessor as Accessor<unknown>, setter]
}
