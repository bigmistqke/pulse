/**
 * A fake server. Every call takes time and may refuse, which is the whole point
 * of this example — the coordination pulse does is invisible against an instant,
 * reliable backend.
 *
 * Latency and error rate are plain mutable module state rather than signals,
 * deliberately. They are read inside `delay`, which runs while a reactive
 * computation is on the stack, and reading a signal there would make every
 * request a dependency of the stage that issued it — so changing the latency
 * slider would refetch the list.
 *
 * Both are seeded from the query string so a test can pin them:
 * `?latency=80&fail=0`. `fail` is a rate between 0 and 1.
 */

export type Todo = {
  id: number
  text: string
  done: boolean
}

/** Thrown only by `list()`. Distinguishes a load error from a mutation
 *  error by type, so the two can be routed to different boundaries. */
export class LoadFailedError extends Error {}

function fromQuery(key: string, fallback: number): number {
  const raw = new URLSearchParams(window.location.search).get(key)
  if (raw === null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

let latencyMs = fromQuery('latency', 500)
let failureRate = fromQuery('fail', 0.15)

export const config = {
  get latency() {
    return latencyMs
  },
  set latency(value: number) {
    latencyMs = value
  },
  get failureRate() {
    return failureRate
  },
  set failureRate(value: number) {
    failureRate = value
  },
}

let store: Todo[] = []
let nextId = 1

/** Resolve with `produce()` after the configured latency, or reject with
 *  `makeError()` — a plain server-refused `Error` unless the caller needs a
 *  different class, the way `list()` does below. */
function respond<T>(
  produce: () => T,
  makeError: () => Error = () => new Error('the server refused this request'),
): Promise<T> {
  const ms = latencyMs
  const rate = failureRate
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      if (Math.random() < rate) {
        reject(makeError())
        return
      }
      resolve(produce())
    }, ms)
  })
}

export const api = {
  /** A fresh array of fresh objects every time, as a real endpoint would give. */
  list: (): Promise<Todo[]> =>
    respond(
      () => store.map((todo) => ({ ...todo })),
      () => new LoadFailedError('the server refused this request'),
    ),

  add: (text: string): Promise<Todo> =>
    respond(() => {
      const todo: Todo = { id: nextId++, text, done: false }
      store = [...store, todo]
      return { ...todo }
    }),

  toggle: (id: number): Promise<Todo> =>
    respond(() => {
      store = store.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo))
      const updated = store.find((todo) => todo.id === id)
      if (updated === undefined) throw new Error(`no todo with id ${id}`)
      return { ...updated }
    }),

  remove: (id: number): Promise<void> =>
    respond(() => {
      store = store.filter((todo) => todo.id !== id)
    }),
}
