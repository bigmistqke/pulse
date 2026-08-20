export type Todo = {
  id: number
  text: string
  done: boolean
}

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
