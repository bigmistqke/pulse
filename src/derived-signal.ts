import { signal as valueSignal, type Accessor, type Setter } from './signal'
import { buildStages } from './computed'
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

/** Build a pipeline and return it with a setter. `computed` builds the same
 *  stages and drops the setter. */
function signalFromStages(
  ...stages: Array<(value: any) => unknown>
): [Accessor<unknown>, DerivedSetter<unknown>] {
  const built = buildStages(stages)
  const tail = built[built.length - 1]

  const setter: DerivedSetter<unknown> = (next) => {
    const value =
      typeof next === 'function'
        ? (next as (prev: unknown) => unknown)(tail.readPrev())
        : next

    // Withdrawing a queued run observes nothing, and has to happen before the
    // publish: publishing seeds the tolerant read, which stabilizes, which
    // would run the very run being withdrawn.
    for (let i = built.length - 1; i >= 0; i--) {
      built[i].withdrawQueuedRun(built[i] === tail)
    }

    // The value next, so a cleanup fired by abandoning below observes the
    // write that triggered it rather than the value it replaced.
    tail.publishValue(value)
    tail.applyWriteEffects(value)

    // Abandoning runs cleanup callbacks, so it happens after the publish — a
    // cleanup that reads the signal sees the write that triggered it.
    for (let i = built.length - 1; i >= 0; i--) {
      built[i].abandonRun()
    }
  }

  return [tail.accessor as Accessor<unknown>, setter]
}
