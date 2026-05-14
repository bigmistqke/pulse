import { computed as r3Computed } from 'r3'
import { makeAccessor, type Signal } from './signal'

/** A pipeline stage: receives the previous stage's value, returns the next. */
type Stage<In, Out> = (value: In) => Out

// Overloads: stage 0 takes no input; stage N takes stage N-1's return type.
export function computed<A>(s0: () => A): Signal<A>
export function computed<A, B>(s0: () => A, s1: Stage<A, B>): Signal<B>
export function computed<A, B, C>(
  s0: () => A,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
): Signal<C>
export function computed<A, B, C, D>(
  s0: () => A,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
  s3: Stage<C, D>,
): Signal<D>
export function computed<A, B, C, D, E>(
  s0: () => A,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
  s3: Stage<C, D>,
  s4: Stage<D, E>,
): Signal<E>

/**
 * Create a derived signal from a pipeline of one or more stages.
 *
 * @remarks Typed overloads cover 1–5 stages; beyond that, compose pipelines.
 */
export function computed(...stages: Array<(value: unknown) => unknown>): Signal<unknown> {
  if (stages.length === 0) {
    throw new Error('computed requires at least one stage')
  }
  return makeAccessor(
    r3Computed(() => {
      let value: unknown = stages[0](undefined)
      for (let i = 1; i < stages.length; i++) {
        value = stages[i](value)
      }
      return value
    }),
  )
}
