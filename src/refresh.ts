/**
 * `refresh(x)`: run a derivation's recipe again though none of its inputs
 * changed. The answer it asks again still stands while the run is in flight,
 * so a refresh is reported by `isRefreshing`, never as pending.
 */
import { isGeneratorFunction, peek } from './async'
import type { Completion, StageHandle } from './computed'
import { whenCommitted } from './derived-signal'
import { resumeStage, runStage, type StageOutcome } from './driver'
import { isPromise } from './is-promise'
import { getCurrentScope, ROOT_SCOPE, type Scope } from './scope'
import { NODE, type Accessor } from './signal'

/** What a refresh needs of a derivation: its recipe, and a handle per stage. */
interface Refreshable {
  stages: ReadonlyArray<(value: any) => unknown>
  built: StageHandle[]
  /** The promise shared by every refresh asked for in the current tick, until
   *  the refresh they coalesce into starts. */
  queued: Promise<unknown> | null
  /** Bumped by each refresh that starts, so a superseded one stops. */
  generation: number
}

const registry = new WeakMap<Accessor<unknown>, Refreshable>()

/** Register a derivation's pipeline under its public accessor. Internal. */
export function registerRefreshable(
  accessor: Accessor<unknown>,
  target: Pick<Refreshable, 'stages' | 'built'>,
): void {
  registry.set(accessor, { ...target, queued: null, generation: 0 })
}

/**
 * Run the recipe of the derivation `x` again, though none of its inputs
 * changed, and return a promise for the next value it settles to.
 *
 * - Every stage of the pipeline runs once, in order. A stage that hands on an
 *   unchanged value still has the next stage run.
 * - Refreshes asked for in one tick start a single run. A refresh abandons a
 *   run already in flight, which never publishes.
 * - The promise delivers what finally lands, even when a later refresh or a
 *   revision supersedes this one, and rejects when that run fails. A rejection
 *   nobody handles is not reported as unhandled.
 * - Inside an action the refreshed answer is part of its speculation: seen
 *   inside it, committed with it, discarded with it.
 *
 * Anything that is not a derivation runs nothing: `refresh` logs a warning on
 * every call and returns a promise for the current value.
 */
export function refresh<T>(x: Accessor<T>): Promise<Awaited<T>> {
  const target = registry.get(x as Accessor<unknown>)
  if (target === undefined) {
    console.warn('refresh: only a derivation can be refreshed; this call ran nothing.', x)
    const current = typeof x === 'function' && NODE in x ? peek(x) : undefined
    return Promise.resolve(current) as Promise<Awaited<T>>
  }
  const scope = getCurrentScope()
  const promise =
    scope === ROOT_SCOPE ? refreshCommitted(target) : refreshInSpeculation(target, scope)
  promise.catch(() => {})
  return promise as Promise<Awaited<T>>
}

/** Queue a refresh of committed state, starting it once the tick ends. */
function refreshCommitted(target: Refreshable): Promise<unknown> {
  if (target.queued !== null) return target.queued
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  target.queued = promise
  queueMicrotask(() => {
    target.queued = null
    start(target, (completion) => {
      if (completion.failed) reject(completion.reason)
      else resolve(completion.value)
    })
  })
  return promise
}

/**
 * Start a refresh: abandon what is in flight, arm every stage, and run the
 * first one. A stage that completes with a changed value has the next one run
 * through the graph; one that completes unchanged has the next one run here.
 * `settle` hears the next completion of the last stage, whichever run it is.
 */
function start(target: Refreshable, settle: (completion: Completion) => void): void {
  const { built } = target
  const generation = ++target.generation
  for (const handle of built) handle.abandonRun()
  for (const handle of built) handle.armRefresh()
  built.forEach((handle, i) => {
    if (i === built.length - 1) return
    handle.onceCompleted((completion) => {
      if (target.generation !== generation) return
      if (completion.failed || completion.changed) return
      // Not from inside the run that just completed.
      queueMicrotask(() => {
        if (target.generation === generation) built[i + 1].kickRefresh()
      })
    })
  })
  built[built.length - 1].onceCompleted(settle)
  built[0].kickRefresh()
}

/**
 * Refresh inside an action. The recipe runs now, inside the action's scope,
 * and its result is written into the speculation like a write to the
 * derivation: promoted at commit, gone at a discard.
 */
function refreshInSpeculation(target: Refreshable, scope: Scope): Promise<unknown> {
  const { built, stages } = target
  const tail = built[built.length - 1]
  const result = runRecipe(stages)
  tail.publishValue(result)
  whenCommitted(scope, () => {
    for (let i = built.length - 1; i >= 0; i--) built[i].abandonRun()
    tail.applyWriteEffects(result)
  })
  return result
}

/** Run every stage of a recipe in order, each on the value the one before it
 *  resolved to. The first stage runs at once, in the caller's scope. */
function runRecipe(stages: ReadonlyArray<(value: any) => unknown>): Promise<unknown> {
  const step = (i: number, input: unknown): unknown => {
    if (i === stages.length) return input
    const out = runWhole(stages[i], input)
    return isPromise(out)
      ? (out as Promise<unknown>).then((value) => step(i + 1, value))
      : step(i + 1, out)
  }
  try {
    return Promise.resolve(step(0, undefined))
  } catch (error) {
    return Promise.reject(error)
  }
}

/** Run one stage to its end: its value, or a promise for it. A generator is
 *  driven through each pause it takes. */
function runWhole(stage: (value: any) => unknown, input: unknown): unknown {
  if (!isGeneratorFunction(stage)) return stage(input)
  const drive = (outcome: StageOutcome): unknown => {
    if (!outcome.pending) return outcome.value
    const { gen, promise } = outcome
    if (gen === undefined) return promise
    return promise.then(
      (value) => drive(resumeStage(gen, { throw: false, value })),
      (reason) => drive(resumeStage(gen, { throw: true, reason })),
    )
  }
  return drive(runStage(stage, input))
}
