/**
 * How a boundary builds its children. `<Loading>` and `<Errored>` both build
 * theirs once, up front, inside their own owner, and both need what goes wrong
 * while building them to stay in their region. This is that one mechanism.
 */
import { untrack } from 'r3'
import { NotReadyYet } from '../async'
import {
  createSubOwner,
  disposeOwner,
  findBoundaryScope,
  findNearestErrorScope,
  registerWithOwner,
  routeError,
  runWithOwner,
  type BindingController,
  type Owner,
} from '../owner'
import { signal, type Accessor } from '../signal'
import { bindValue } from './bindings'

/**
 * Build `props.children` once, inside a sub-owner of `boundaryOwner`, and
 * return an accessor to the result.
 *
 * - A function the author passed as the children is a thunk for them: it is
 *   called once, untracked, like a component body.
 * - The children getter is read once, which runs the components it builds.
 *   A function it returns is the resolved value, such as an accessor held in
 *   a variable: it is resolved by a binding under the build owner, so it runs
 *   inside the boundary, and the accessor returns its current value.
 *
 * The build is guarded. A failure thrown from it goes to the nearest error
 * boundary or error handler above the children, with a retry that builds them
 * again. A suspension thrown from it suspends the nearest loading boundary,
 * which is `boundaryOwner`'s own when the boundary is a `<Loading>`, and the
 * children are built again once the promise settles. Each build disposes what
 * the previous one created.
 */
export function buildBoundaryChildren(
  props: object,
  boundaryOwner: Owner,
): Accessor<unknown> {
  // Every write goes through an update function, because a pulse setter
  // given a function calls it, and the children may well be a function.
  const [built, setBuilt] = signal<unknown>(undefined)
  let buildOwner: Owner | null = null
  let failure: BindingController | null = null
  let suspension: BindingController | null = null
  let waitingOn: Promise<unknown> | null = null

  const build = (): void => {
    if (boundaryOwner.disposed) return
    if (buildOwner !== null) disposeOwner(buildOwner)
    buildOwner = createSubOwner(boundaryOwner)
    const owner = buildOwner
    waitingOn = null
    try {
      const value = runWithOwner(owner, () =>
        untrack(() => {
          const descriptor = Object.getOwnPropertyDescriptor(props, 'children')
          if (descriptor?.get) {
            const resolved = descriptor.get.call(props)
            if (typeof resolved !== 'function') return resolved
            // Resolved inside the boundary by a binding of its own, which
            // reports its suspension and failure here like any binding, and
            // commits the function's value into `current`. Left for the caller
            // to insert, the function would become a hole inside whatever
            // shows the boundary's region, and a swap would dispose it.
            const [current, setCurrent] = signal<unknown>(undefined)
            bindValue(resolved as () => unknown, (next) => setCurrent(() => next))
            return new Resolved(current)
          }
          const children = descriptor?.value
          return typeof children === 'function' ? (children as () => unknown)() : children
        }),
      )
      setBuilt(() => value)
      failure?.report({ status: 'idle' })
      suspension?.report({ status: 'idle' })
    } catch (error) {
      setBuilt(() => undefined)
      if (error instanceof NotReadyYet) {
        failure?.report({ status: 'idle' })
        const scope = findBoundaryScope(owner, 'pending')
        if (scope !== null) {
          suspension ??= scope.register()
          suspension.report({ status: 'throwing' })
        }
        const promise = error.promise
        waitingOn = promise
        const rebuild = (): void => {
          if (waitingOn === promise) build()
        }
        promise.then(rebuild, rebuild)
        return
      }
      suspension?.report({ status: 'idle' })
      const found = findNearestErrorScope(owner, error)
      if (found === null) {
        routeError(owner, error)
        return
      }
      failure ??= found.scope.register()
      failure.report({ status: 'error', error, source: null, retry: build })
    }
  }

  runWithOwner(boundaryOwner, () =>
    registerWithOwner({
      dispose: () => {
        waitingOn = null
        failure?.unregister()
        suspension?.unregister()
      },
    }),
  )
  build()
  return () => {
    const value = built()
    return value instanceof Resolved ? value.current() : value
  }
}

/** A function child resolved inside the boundary: its value, as it commits. */
class Resolved {
  constructor(readonly current: Accessor<unknown>) {}
}
