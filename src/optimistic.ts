import { stabilize } from 'r3'
import { peek, seedLatest, type PipelineRead, type Resolved, type WithFallback } from './async'
import { computed } from './computed'
import { error as errorOf, lookupError, registerError, resetError } from './error'
import { isPending, lookupPending, promiseOf, registerPending } from './pending'
import {
  chainFor,
  committed,
  getCurrentScope,
  onSettledOn,
  ROOT_SCOPE,
  type Scope,
} from './scope'
import { signal as valueSignal, type Accessor } from './signal'

/** A stage of any shape: sync, async, or generator. */
type Stage<In, Out> = (value: In) => Out

/** Distinguishes "no layer is live" from a layer whose value is `undefined`,
 *  so the reader falls through to the derivation only when the stack is
 *  genuinely empty. */
const EMPTY = Symbol('empty')

/** The setter of an optimistic derivation. Takes the predicted value, or an
 *  update function handed the value this action can currently see — its own
 *  live prediction if it has one, and otherwise the derivation's own value,
 *  never another action's prediction. */
export type OptimisticSetter<T> = (next: T | ((prev: T) => T)) => void

/**
 * A derived signal whose setter writes an optimistic prediction rather than a
 * value.
 *
 * The pipeline is built exactly the way `computed(...)` and `signal(...)` build
 * one — same stages, same stale-while-revalidate publishing, same registration
 * with the pending and error trackers. So the accessor is an ordinary pulse
 * node and the read verb is chosen at the read site: `use(value)` suspends and
 * joins the atomic-commit gate, `latest(value)` reads tolerantly and reports
 * loading and error state to the surrounding boundaries, `peek(value)` reports
 * nothing, `isPending(value)` and `error(value)` query it.
 *
 * What differs is the write discipline. An ordinary setter's write is isolated
 * to the action that made it, invisible outside, promoted when that action
 * commits and gone if it is discarded. This setter's write is a **layer** in
 * front of the derivation instead:
 *
 * - **It leaks out.** A reader outside every action sees the top of the layer
 *   stack, so a prediction is on screen the moment it is made, from outside the
 *   action that made it.
 * - **It stays scoped inside.** A reader inside an action sees the nearest
 *   layer up its own scope chain — its own prediction, or an enclosing action's
 *   — and otherwise the derivation itself. One action never reads another's
 *   guess, so a prediction cannot be absorbed into a second action's layer and
 *   stranded there when the first rolls back.
 * - **It expires with the action.** On the commit face as well as the discard
 *   face the layer is dropped and the stack refolds to whatever is left. A
 *   prediction that turned out right survives only because the action also
 *   wrote the canonical source this pipeline reads.
 *
 * The layers sit in front of the derivation rather than being written into it,
 * so the derivation's own value is never overwritten: a source that resolves or
 * changes while a prediction is live updates underneath it and shows through
 * the moment the last layer is dropped. Nothing has to be reverted, because
 * nothing was replaced.
 *
 * While any layer is live the node reports neither pending nor failed, whatever
 * its sources are doing: a prediction is on screen, so nothing should suspend
 * behind it or swap it for an error. Both facts resume being reported the
 * moment the last layer is dropped.
 *
 * When the recipe is a single stage that is itself a pulse node — the
 * `optimistic(someSignal)` shape — this derivation registers as being
 * downstream of it, so a background refresh of that node is reported through
 * this one and a boundary's retry resets that node rather than only re-running
 * this recipe over a source that is still parked. A recipe that reads a node
 * from inside a closure is an ordinary derivation and gets neither, exactly as
 * `computed(() => someSignal())` does.
 *
 * ```ts
 * const [todos, setTodos] = signal(() => api.list(), [])
 * const [view, setView, isSpeculating] = optimistic(todos, [])
 *
 * action(function* () {
 *   setView(prev => [...prev, draft]) // prev is server truth, not a rival guess
 *   const saved = yield* from(api.add(draft))
 *   setTodos(prev => [...prev, saved]) // canonical, promoted at commit
 * })
 * ```
 */
export function optimistic<A>(
  s0: () => A,
): [Accessor<PipelineRead<[], A>>, OptimisticSetter<Resolved<A>>, Accessor<boolean>]
// The single-stage form with a default, mirroring `signal`'s own: `fallback` is
// what the tolerant read reports before stage 0 has resolved anything, and what
// an update function is handed in place of `undefined` until then.
export function optimistic<A>(
  s0: () => A,
  fallback: Resolved<A>,
): [
  WithFallback<Accessor<PipelineRead<[], A>>, Resolved<A>>,
  OptimisticSetter<Resolved<A>>,
  Accessor<boolean>,
]
export function optimistic<A, B>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
): [Accessor<PipelineRead<[A], B>>, OptimisticSetter<Resolved<B>>, Accessor<boolean>]
export function optimistic<A, B, C>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
): [Accessor<PipelineRead<[A, B], C>>, OptimisticSetter<Resolved<C>>, Accessor<boolean>]
export function optimistic<A, B, C, D>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
): [Accessor<PipelineRead<[A, B, C], D>>, OptimisticSetter<Resolved<D>>, Accessor<boolean>]
export function optimistic<A, B, C, D, E>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
  s4: Stage<Resolved<D>, E>,
): [Accessor<PipelineRead<[A, B, C, D], E>>, OptimisticSetter<Resolved<E>>, Accessor<boolean>]

// `any` here is the standard implementation-signature widening for the variadic
// overloads above, the same as `computed`'s and `signal`'s.
export function optimistic(...args: any[]): [Accessor<any>, any, Accessor<boolean>] {
  if (typeof args[0] !== 'function') {
    throw new Error('optimistic requires a stage function, not a plain value')
  }
  // A lone non-function second argument is a fallback for the tolerant read,
  // not a second stage — a real stage is always itself a function, so this
  // never misreads a genuine two-stage call. Same rule as `signal`.
  const hasFallback = args.length === 2 && typeof args[1] !== 'function'
  const fallback = hasFallback ? args[1] : undefined
  const stages = (hasFallback ? [args[0]] : args) as Array<(value: any) => unknown>

  // `computed`'s exported overloads are per-arity; the implementation behind
  // them is variadic, which is what a runtime-collected stage list needs.
  const buildPipeline = computed as unknown as (
    ...s: Array<(value: any) => unknown>
  ) => Accessor<unknown>
  const derivation = buildPipeline(...stages)
  // The derivation's own tracker entries, wrapped rather than replaced below:
  // this reader is the node consumers name, so it is the one the trackers have
  // to answer for. `ownError.value` is the derivation's raw, non-throwing read.
  const ownPending = lookupPending(derivation)!
  const ownError = lookupError(derivation)!

  // One layer per action that currently has a live prediction. A Map iterates
  // in insertion order, so the last entry is the top of the stack.
  const layers = new Map<Scope, unknown>()
  // The top of the stack, mirrored into a signal so a reader outside every
  // action is reactive to it and is deduplicated on the value the way any
  // other read is. Written in committed state, which is what makes a
  // prediction visible from outside the action that made it.
  const [top, setTop] = valueSignal<unknown>(EMPTY)

  const publishTop = (): void => {
    let current: unknown = EMPTY
    for (const value of layers.values()) current = value
    committed(() => setTop(current))
  }

  /**
   * The layer this scope can see: the nearest one up its own chain, so an
   * action sees its own prediction and a nested action sees an enclosing one's,
   * and nothing else. `EMPTY` when there is none — including when a sibling
   * action has a live layer, which is the isolation that keeps one action's
   * prediction from being read into another's.
   */
  const layerFor = (scope: Scope): unknown => {
    for (const s of chainFor(scope)) {
      if (layers.has(s)) return layers.get(s)
    }
    return EMPTY
  }

  /** Which layer a read from the current scope sees, or `EMPTY` for none. At
   *  the root that is the top of the stack, read whether or not it wins so a
   *  reader outside every action re-runs when the stack changes and picks the
   *  derivation back up as the last layer goes. Inside an action it is the
   *  nearest layer up that action's own chain, consulted directly: such a read
   *  happens once, inside an action's body, rather than being held by a
   *  binding, so it does not need to be reactive to the stack. */
  const visibleLayer = (): unknown => {
    const scope = getCurrentScope()
    return scope === ROOT_SCOPE ? top() : layerFor(scope)
  }

  const value: Accessor<unknown> = () => {
    const layer = visibleLayer()
    if (layer === EMPTY) return derivation()
    // A winning layer still reads the derivation, through the raw non-throwing
    // view so that a parked error stays masked behind the prediction. Same
    // reason as the tracker entry's own `value` below: it keeps the pipeline
    // pulled while a prediction is showing.
    ownError.value()
    return layer
  }

  const setOptimisticValue = (next: unknown): void => {
    const scope = getCurrentScope()
    if (scope === ROOT_SCOPE) {
      throw new Error('an optimistic setter requires an active speculative scope')
    }
    const firstForScope = !layers.has(scope)
    // Resolved against what THIS scope can see, so an update function builds on
    // its own prediction or on the derivation — never on a rival action's.
    //
    // The derivation is read at committed level rather than through this
    // scope. A tracked read of a computed inside a speculation re-runs its
    // recipe there, which for an async recipe means a fresh promise that has
    // settled nothing, so there would be no resolved value to build on. What
    // an update function wants is the last RESOLVED value, and that is what
    // has actually come back — server truth, not an isolated re-derivation of
    // it. The cost is that a canonical write made earlier in the same action
    // is not visible here; a prediction layers over what the server has
    // confirmed, which is the base the canonical write is itself heading for.
    const layer = layerFor(scope)
    const resolved =
      typeof next === 'function'
        ? (next as (prev: unknown) => unknown)(
            layer === EMPTY ? committed(() => peek(derivation, fallback)) : layer,
          )
        : next
    // Re-inserted rather than updated in place, so a repeated write from the
    // same action moves it to the top of the stack instead of staying where it
    // was.
    layers.delete(scope)
    layers.set(scope, resolved)
    publishTop()
    if (firstForScope) {
      onSettledOn(scope, () => {
        // Bring the graph up to date BEFORE revealing what is under this
        // layer. A settle callback runs after an action's writes have been
        // promoted but before the flush that propagates them, so dropping the
        // layer first would reveal a derivation that has not yet followed the
        // write this very action just made — a visible flash of pre-action
        // content on exactly the frame it commits.
        stabilize()
        layers.delete(scope)
        publishTop()
      })
    }
  }

  const isOptimistic: Accessor<boolean> = () => top() !== EMPTY

  if (hasFallback) seedLatest(value, fallback)
  // The wrapped node, when the recipe is a single stage that is one. A stage
  // reaches its input's pending and error state through the upstream chain,
  // which links stages within one pipeline; a node wrapped from outside is not
  // on that chain, so it is consulted directly here instead.
  const source = stages.length === 1 ? (stages[0] as Accessor<unknown>) : undefined
  const wrapsNode =
    source !== undefined &&
    (lookupPending(source) !== undefined || lookupError(source) !== undefined)

  registerPending(value, {
    // Both facts are read on every call, before the mask is applied, so a
    // consumer keeps its subscription to them while a prediction hides them and
    // hears about them again the moment the last layer goes.
    pending: () => {
      const here = ownPending.pending()
      const upstream = wrapsNode ? isPending(source!) : false
      return !isOptimistic() && (here || upstream)
    },
    promise: () => {
      const here = ownPending.promise()
      const upstream = wrapsNode ? promiseOf(source!) : null
      return isOptimistic() ? null : (here ?? upstream)
    },
  })

  registerError(value, {
    error: () => {
      const here = ownError.error()
      const upstream = wrapsNode ? errorOf(source!) : null
      return isOptimistic() ? null : ((here ?? upstream) ?? null)
    },
    // The raw, non-throwing read a tolerant read degrades to — through this
    // reader, so a live prediction is what it degrades to. This is the path
    // `peek`/`latest` take (they read a registered node through its entry, not
    // through its accessor), which is why the derivation is read here on every
    // call and not only when it wins: it is the tolerant reader's only link to
    // the pipeline while a prediction is showing, and without it the pipeline
    // stops being pulled — a source that changes while the prediction is up is
    // not followed, and dropping the layer reveals the value the derivation
    // held when the prediction started rather than the current one.
    value: () => {
      const layer = visibleLayer()
      const raw = ownError.value()
      return layer === EMPTY ? raw : layer
    },
    // The wrapped node first: re-running this recipe over a source that is
    // still parked would only park the same error again, so a boundary's retry
    // has to reach past this derivation to the node the failure came from.
    reset: () => {
      if (wrapsNode) resetError(source!)
      ownError.reset()
    },
  })

  return [value, setOptimisticValue, isOptimistic]
}
