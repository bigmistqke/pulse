import { NotReadyYet } from '../async'
import { effect } from '../effect'
import {
  createSubOwner,
  disposeOwner,
  findBoundaryScope,
  findNearestErrorScope,
  getOwner,
  onCleanup,
  runWithOwner,
  type BindingController,
  type ErrorScope,
  type Owner,
} from '../owner'
import type { Accessor } from '../signal'
import { readDynamic } from './resolve'
import { runBindingCompute } from '../transition-tracker'

/**
 * Fragment (see `h.ts`) hands a function child back to its own caller
 * unresolved, to be wrapped by whichever LATER, unrelated `insertChild` call
 * ends up consuming the array - typically under a different, wrong owner
 * than the one that was ambient when the Fragment itself was built (e.g. a
 * boundary's `boundaryOwner`). `tagChildOwner` records the correct owner
 * against the function itself, keyed by reference, so `insertChild` can
 * recover it later regardless of where the wrapping actually happens.
 */
const taggedChildOwner = new WeakMap<() => unknown, Owner | null>()

export function tagChildOwner(child: () => unknown, owner: Owner | null): void {
  taggedChildOwner.set(child, owner)
}

/**
 * Wrap a reactive `apply(value)` binding in the compute/commit split. The
 * effect body evaluates `read()` (which may throw NotReadyYet), then either
 * commits via `apply(value)` immediately (no Loading scope) or defers via
 * `scope.report({status: 'ready', commit})`. On throw, reports 'throwing'
 * and re-throws so the effect's outer machinery re-runs on settle.
 */
/**
 * Per-binding intake for AMBIENT error reports — an error a `latest()` read
 * observed on a source that degraded to its last good value rather than
 * throwing. The throw path has its own reporting (in `effect.ts`); this is the
 * other half, so a subtree that reads exclusively through `latest()` still
 * participates in `<Errored>` (ADR 0015).
 *
 * The controller is persistent across re-runs, so one failed source that makes
 * this binding re-run several times stays ONE entry in the boundary's
 * collection — the same property `effect.ts`'s error controller relies on. It
 * is re-targeted if a different boundary accepts the error (a retry can fail
 * with a different type than the attempt that made the first claim), and
 * cleared to `idle` on any run that observes no error, which is what lets the
 * boundary unlatch when the source recovers.
 */
function makeAmbientErrorReporter(parentOwner: Owner | null): {
  report: (ambient: { error: unknown; source: Accessor<unknown> } | null) => void
  dispose: () => void
} {
  let controller: BindingController | null = null
  let controllerScope: ErrorScope | null = null
  return {
    report(ambient) {
      if (ambient === null) {
        controller?.report({ status: 'idle' })
        return
      }
      const found = findNearestErrorScope(parentOwner, ambient.error)
      if (found === null) {
        controller?.report({ status: 'idle' })
        return
      }
      if (controller !== null && controllerScope !== found.scope) {
        controller.unregister()
        controller = null
      }
      if (controller === null) {
        controller = found.scope.register()
        controllerScope = found.scope
      }
      controller.report({
        status: 'error',
        error: ambient.error,
        source: ambient.source,
        // The boundary's own reset already calls `resetError(source)`, which
        // recomputes the root failed stage. This binding subscribed to that
        // node's error state by reading `error(s)` inside `latest()`, so the
        // recompute re-runs it and it reports itself recovered on its own —
        // there is no separate kick to issue here.
        retry: () => {},
      })
    },
    dispose() {
      controller?.unregister()
      controller = null
    },
  }
}

function reactiveCommit<T>(
  parentOwner: Owner | null,
  read: () => T,
  apply: (value: T) => void,
): void {
  const ambientErrors = makeAmbientErrorReporter(parentOwner)
  let controller: BindingController | null = null
  const ensureController = (): BindingController | null => {
    if (controller !== null) return controller
    const scope = findBoundaryScope(parentOwner, 'pending')
    if (scope === null) return null
    controller = scope.register()
    return controller
  }
  onCleanup(() => {
    controller?.unregister()
    controller = null
    ambientErrors.dispose()
  })
  effect(() => {
    let result: {
      value: T
      engagedTransition: boolean
      backgroundPromise: Promise<unknown> | null
      firstLoadPromise: Promise<unknown> | null
      ambientError: { error: unknown; source: Accessor<unknown> } | null
    }
    try {
      // runWithOwner(parentOwner, ...) so that owner-aware reads inside
      // `read` (e.g. `useLoading()`) walk from parentOwner up — finding
      // the boundary scope that was ambient when this binding was created.
      // Without this, the effect body runs with whatever owner happens to
      // be set globally during r3 stabilize, which loses the connection
      // to the enclosing <Loading>.
      result = runWithOwner(parentOwner, () =>
        runBindingCompute(() => read()),
      )
    } catch (e) {
      if (e instanceof NotReadyYet) {
        ensureController()?.report({ status: 'throwing' })
        throw e
      }
      // A real error is not a pending state: a binding that fails must leave
      // the boundary's pending collection, or the boundary can never see its
      // pending count reach zero and its gate stays shut forever.
      controller?.report({ status: 'idle' })
      throw e
    }
    const { value, engagedTransition, backgroundPromise, firstLoadPromise, ambientError } = result
    // A use.latest()/latest() SWR read: has a value, but its accessor is
    // pending again underneath. Not part of the gate at all (it's committing
    // right now, regardless of which path below) — only the boundary's
    // isLoading() aggregate needs to hear about it. A latest() read with NO
    // value goes to trackFirstLoad instead, which additionally drives the
    // boundary's `initial` swap.
    if (backgroundPromise !== null) {
      findBoundaryScope(parentOwner, 'pending')?.trackBackground(backgroundPromise)
    }
    if (firstLoadPromise !== null) {
      findBoundaryScope(parentOwner, 'pending')?.trackFirstLoad(firstLoadPromise)
    }
    // Unconditional, both ways: reporting clears to `idle` when this run saw
    // no error, which is what unlatches the boundary once the source recovers.
    ambientErrors.report(ambientError)
    const commit = () => apply(value)
    // If there's a prior controller (binding previously threw), always go
    // through the controller to consume its pendingSet entry.
    if (controller !== null) {
      controller.report({ status: 'ready', commit })
      return
    }
    // No prior throw. If use() was called inside a Loading scope, ALWAYS
    // route through deferOrCommit — even if scope.active() is false right
    // now. The scope decides whether to fire immediately or defer at end
    // of microtask. This is required because of the ordering race: a
    // sibling binding that will throw in the same flush may not have
    // reported yet, so scope.active() is a false-negative at this moment.
    if (engagedTransition) {
      const scope = findBoundaryScope(parentOwner, 'pending')
      if (scope !== null) {
        scope.deferOrCommit(commit)
        return
      }
    }
    // No scope ancestor — commit immediately.
    commit()
  })
}

/**
 * Warn (once per occurrence) when a reactive binding or event listener is
 * created without an ambient owner. The framework remains permissive — the
 * binding still works — but it will never be cleaned up, so we surface the
 * leak loudly. Wrap in `render()` or `createRoot()` to silence.
 */
function warnIfOrphaned(kind: string, owner: Owner | null = getOwner()): void {
  if (owner === null) {
    console.warn(
      `pulse: ${kind} created outside any owner — it will live forever. ` +
      `Wrap in render() or createRoot().`,
    )
  }
}

/**
 * Insert `value` as a child (or children) of `parent`.
 *
 * - string / number → text node
 * - null / undefined / boolean → nothing
 * - DOM Node → inserted as-is
 * - array → each item inserted recursively
 * - function → wrapped in a binding-effect: the function runs reactively;
 *   its result is inserted between two marker comments and replaced on
 *   re-run. `use(...)` inside the function suspends only this binding;
 *   throws route to the nearest `catchError`.
 */
export function insertChild(parent: Node, value: unknown): void {
  if (typeof value === 'function') {
    // Capture the owner at h()-call time — unless Fragment already tagged
    // this exact function with the owner ambient when IT was built (see
    // tagChildOwner above): a Fragment child is resolved later, by whichever
    // unrelated call ends up consuming Fragment's returned array, so the
    // owner ambient right here can be the wrong one. The binding-effect
    // lives until this owner is disposed. Each run of the effect gets its
    // own sub-owner so any nested effects/computeds created by the user
    // function are cleaned up before the next run — no leak across re-runs.
    const parentOwner = taggedChildOwner.has(value as () => unknown)
      ? taggedChildOwner.get(value as () => unknown)!
      : getOwner()
    warnIfOrphaned('reactive child', parentOwner)
    const start = document.createComment('')
    const end = document.createComment('')
    parent.appendChild(start)
    parent.appendChild(end)
    let runOwner: Owner | null = null
    let controller: BindingController | null = null
    const ensureController = (): BindingController | null => {
      if (controller !== null) return controller
      const scope = findBoundaryScope(parentOwner, 'pending')
      if (scope === null) return null
      controller = scope.register()
      return controller
    }
    const ambientErrors = makeAmbientErrorReporter(parentOwner)
    onCleanup(() => {
      controller?.unregister()
      controller = null
      ambientErrors.dispose()
    })
    effect(() => {
      // Build the fragment FIRST inside a fresh sub-owner so any nested
      // binding-effects/computeds the user creates are bound to this run.
      const nextRunOwner = createSubOwner(parentOwner)
      let frag: DocumentFragment | null = null
      let engagedTransition = false
      let ambientError: { error: unknown; source: Accessor<unknown> } | null = null
      let backgroundPromise: Promise<unknown> | null = null
      let firstLoadPromise: Promise<unknown> | null = null
      try {
        runWithOwner(nextRunOwner, () => {
          const result = runBindingCompute(() => {
            const next = (value as () => unknown)()
            frag = document.createDocumentFragment()
            insertChild(frag, next)
          })
          engagedTransition = result.engagedTransition
          backgroundPromise = result.backgroundPromise
          firstLoadPromise = result.firstLoadPromise
          ambientError = result.ambientError
        })
        // Unconditional, both ways: reporting clears to `idle` when this run
        // saw no error, which unlatches the boundary once the source recovers.
        ambientErrors.report(ambientError)
        // A use.latest()/latest() SWR read inside this child: has a value
        // (already built into `frag` above), but its accessor is pending
        // again underneath. Not part of the gate — only the boundary's
        // isLoading() aggregate needs to hear about it. A latest() read with
        // NO value goes to trackFirstLoad instead, which additionally drives
        // the boundary's `initial` swap.
        if (backgroundPromise !== null) {
          findBoundaryScope(parentOwner, 'pending')?.trackBackground(backgroundPromise)
        }
        if (firstLoadPromise !== null) {
          findBoundaryScope(parentOwner, 'pending')?.trackFirstLoad(firstLoadPromise)
        }
      } catch (e) {
        // Sub-owner from the failed run is orphaned — dispose to clean up
        // any partial nested registrations.
        disposeOwner(nextRunOwner)
        if (e instanceof NotReadyYet) {
          ensureController()?.report({ status: 'throwing' })
          // Re-throw so the outer effect() handles re-run-on-settle.
          // The outer effect's controller registration becomes redundant
          // with ours — we accept the small duplication; both controllers
          // report 'throwing' to the same scope, and both will report
          // 'idle'/'ready' on success. The scope's Set semantics dedupe
          // per-controller, so two reports just mean two controllers in
          // pendingSet — the gate still opens correctly when BOTH report
          // non-throwing. NOTE: this is slightly wasteful; future cleanup
          // could let insertChild own a custom effect-like primitive that
          // bypasses the outer scope registration.
          throw e
        }
        // A real error is not a pending state: a binding that fails must
        // leave the boundary's pending collection, or the boundary can never
        // see its pending count reach zero and its gate stays shut forever.
        controller?.report({ status: 'idle' })
        throw e
      }
      // Successful compute. Build the commit. The commit captures oldRunOwner
      // from the surrounding `let runOwner` variable, so it disposes the
      // previous run's owner on commit and installs the new one.
      const oldRunOwner = runOwner
      const commit = () => {
        // Defensive: a deferred commit (via scope.deferOrCommit) may fire after
        // the binding's subtree has been unmounted (markers removed from DOM).
        // Skip silently — the binding is gone, the commit is moot.
        if (end.parentNode === null) {
          disposeOwner(nextRunOwner)
          return
        }
        // Dispose the previous run's owner; install the new one.
        if (oldRunOwner !== null) disposeOwner(oldRunOwner)
        runOwner = nextRunOwner
        // Clear DOM between markers and insert the fragment.
        let cur = start.nextSibling
        while (cur !== null && cur !== end) {
          const after: ChildNode | null = cur.nextSibling
          cur.remove()
          cur = after
        }
        end.parentNode.insertBefore(frag!, end)
      }
      // If there's a prior controller (binding previously threw), always go
      // through the controller to consume its pendingSet entry.
      if (controller !== null) {
        controller.report({ status: 'ready', commit })
        return
      }
      // No prior throw. If use() was called inside a Loading scope, ALWAYS
      // route through deferOrCommit — even if scope.active() is false right
      // now. The scope's tail-check at end of microtask decides whether to
      // fire immediately or defer; this avoids the false-negative race when
      // a sibling that will throw in the same flush hasn't reported yet.
      if (engagedTransition) {
        const scope = findBoundaryScope(parentOwner, 'pending')
        if (scope !== null) {
          scope.deferOrCommit(commit)
          return
        }
      }
      // No coordination needed — commit immediately.
      commit()
    })
    return
  }
  if (value === null || value === undefined || typeof value === 'boolean') return
  if (typeof value === 'string' || typeof value === 'number') {
    parent.appendChild(document.createTextNode(String(value)))
    return
  }
  if (value instanceof Node) {
    parent.appendChild(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) insertChild(parent, item)
    return
  }
  throw new Error(`insertChild: unsupported child value: ${typeof value}`)
}

function applyAttr(el: Element, name: string, value: unknown): void {
  if (value === null || value === undefined || value === false) {
    el.removeAttribute(name)
  } else {
    el.setAttribute(name, value === true ? '' : String(value))
  }
}

/**
 * Apply one prop entry to `el`, reading it from `props[name]` rather than
 * receiving an already-read value. Every kind except `ref` and `on:`
 * always wraps the read in a reactive effect - it does not check whether
 * the value is a function first. A getter-backed prop (from the
 * props-to-getters compiler) reads its live value on every run, so its own
 * reactive dependencies (if it has any) are picked up by r3's tracking,
 * active during that read; a plain value just makes the effect a one-shot
 * (e.g. a genuinely static `attr:type`) - functionally harmless, the same
 * accepted overhead as everywhere else in this design.
 */
export function bindProp(el: Element, name: string, props: Record<string, unknown>): void {
  // ref — callback invoked once with the element; not reactive
  if (name === 'ref') {
    const value = props[name]
    if (typeof value === 'function') (value as (el: Element) => void)(el)
    return
  }
  // on:event — direct addEventListener, wrapped to restore the owner that was
  // ambient when this binding was created. Without this, code run from inside
  // the handler (onCleanup, action()'s boundary discovery) has no owner to
  // reach, because a DOM event fires outside any owner context entirely.
  if (name.startsWith('on:')) {
    const event = name.slice(3)
    const value = props[name]
    if (typeof value !== 'function') return
    warnIfOrphaned('event listener')
    const capturedOwner = getOwner()
    const handler = value as EventListener
    const wrapped = (e: Event) => runWithOwner(capturedOwner, () => handler(e))
    el.addEventListener(event, wrapped)
    onCleanup(() => el.removeEventListener(event, wrapped))
    return
  }
  // attr:name — explicit setAttribute, always reactive
  if (name.startsWith('attr:')) {
    const attr = name.slice(5)
    warnIfOrphaned('attr binding')
    const parentOwner = getOwner()
    reactiveCommit(parentOwner, () => readDynamic(props, name), (v) => applyAttr(el, attr, v))
    return
  }
  // prop:name — DOM property assignment, always reactive
  if (name.startsWith('prop:')) {
    const prop = name.slice(5)
    warnIfOrphaned('prop binding')
    const parentOwner = getOwner()
    reactiveCommit(parentOwner, () => readDynamic(props, name), (v) => { (el as any)[prop] = v })
    return
  }
  // class:name — toggle a single class, always reactive
  if (name.startsWith('class:')) {
    const cls = name.slice(6)
    warnIfOrphaned('class binding')
    const parentOwner = getOwner()
    reactiveCommit(parentOwner, () => readDynamic(props, name), (v) => el.classList.toggle(cls, !!v))
    return
  }
  // style:name — set/remove a single style property, always reactive
  if (name.startsWith('style:')) {
    const prop = name.slice(6)
    warnIfOrphaned('style binding')
    const parentOwner = getOwner()
    reactiveCommit(parentOwner, () => readDynamic(props, name), (v) => {
      if (v === null || v === undefined || v === false) {
        ;(el as HTMLElement).style.removeProperty(prop)
      } else {
        ;(el as HTMLElement).style.setProperty(prop, String(v))
      }
    })
    return
  }
  // default — same as attr:, with bare name, always reactive
  warnIfOrphaned('attr binding')
  const parentOwner = getOwner()
  reactiveCommit(parentOwner, () => readDynamic(props, name), (v) => applyAttr(el, name, v))
}
