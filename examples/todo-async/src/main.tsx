import {
  action,
  committed,
  Failed,
  For,
  isPending,
  latest,
  Loading,
  onSettled,
  optimistic,
  read,
  render,
  Show,
  signal,
  use,
} from 'pulse'
import { api, config, type Todo } from './api'

type Filter = 'all' | 'active' | 'completed'

/* ------------------------------------------------------------------ state */

type Notice = { message: string; retry?: () => void }

const [filter, setFilter] = signal<Filter>('all')
const [draft, setDraft] = signal('')
const [notice, setNotice] = signal<Notice | null>(null)
/** Bumped to refetch. Read inside `todos`'s own stage, so it is a dependency
 *  of the fetch. */
const [version, setVersion] = signal(0)

/**
 * The load, and the write target once a mutation's request confirms — one
 * signal, two sources, so there is no separate mirror to keep in sync. A
 * generator stage: `read` resolves the promise, and the stage suspends until
 * it settles. Because `version` is read before the pause, it is a dependency
 * — bumping it discards any in-flight generator and starts over.
 *
 * This is canonical server truth. `setTodos` is called only with what the
 * server actually confirmed; the speculative guess a mutation shows before
 * that lives entirely in the overlay below, never here.
 */
const [todos, setTodos] = signal(function* () {
  version()
  return yield* read(api.list())
})

/**
 * What the UI reads. While an action has a live overlay this returns the
 * speculative list; otherwise it falls through to canonical truth. The overlay
 * is dropped when the action closes on either face, so a refused write rolls
 * back without any explicit undo.
 *
 * `optimistic` wraps a tolerant, always-bare read rather than `todos` itself:
 * `todos` is a fetch, so its raw read is `Todo[] | Promise<Todo[]>`, and the
 * overlay only ever needs to compare and replace plain arrays.
 */
const [overlay, setOverlay, speculating] = optimistic(() => latest(todos) ?? [])

/** True while the load is in flight, including a refetch over a visible list. */
const loading = isPending(todos)

const visible = () => {
  const all = overlay()
  const f = filter()
  if (f === 'active') return all.filter((todo) => !todo.done)
  if (f === 'completed') return all.filter((todo) => todo.done)
  return all
}

const remaining = () => overlay().filter((todo) => !todo.done).length

/* --------------------------------------------------------------- mutations */

/** Shows `message` for four seconds. When `retry` is given, the notice grows a
 *  button that runs it and dismisses the notice — the same mutation call,
 *  fed back in, rather than a bespoke undo path. */
function flash(message: string, retry?: () => void) {
  const entry: Notice = { message, retry }
  setNotice(entry)
  setTimeout(() => setNotice((current) => (current === entry ? null : current)), 4000)
}

/**
 * Every mutation has the same shape: write the speculative list, say what to do
 * if the action is discarded, then wait for the server and fold its answer into
 * canonical truth. If the server refuses, the generator throws, the action is
 * discarded, and the overlay disappears with it.
 *
 * The overlay is built from `committed(...)` rather than from `overlay()` so it
 * layers on server truth rather than on another in-flight action's guess. Read
 * through `latest`, not called directly: `todos` is a fetch, so it may itself
 * be a promise mid-reload, and the tolerant read degrades to the last known
 * list instead — the same list a plain `Todo[]` mirror signal used to hold.
 */
/** Split from `addTodo` so a refused write's retry button can resubmit the
 *  same text — by the time it is pressed, `draft()` has moved on to whatever
 *  the user typed next. */
function submitTodo(text: string) {
  // A placeholder id, negative so it cannot collide with a real one. It only
  // ever exists inside the overlay.
  const pending: Todo = { id: -Date.now(), text, done: false }
  void action(function* () {
    setOverlay([...committed(() => latest(todos) ?? []), pending])
    onSettled((outcome) => {
      if (outcome === 'discarded') {
        flash(`Could not add "${text}" — the server refused`, () => submitTodo(text))
      }
    })
    const saved = yield* read(api.add(text))
    setTodos((prev) => [...(prev ?? []), saved])
  }).catch(() => {
    // The rejection already surfaced through `onSettled`; swallowing it here
    // keeps a refused write from becoming an unhandled rejection.
  })
}

function addTodo() {
  const text = draft().trim()
  if (text === '') return
  setDraft('')
  submitTodo(text)
}

function toggleTodo(todo: Todo) {
  void action(function* () {
    setOverlay(
      committed(() => latest(todos) ?? []).map((each) =>
        each.id === todo.id ? { ...each, done: !each.done } : each,
      ),
    )
    onSettled((outcome) => {
      if (outcome === 'discarded') {
        flash(`Could not update "${todo.text}" — the server refused`, () => toggleTodo(todo))
      }
    })
    const saved = yield* read(api.toggle(todo.id))
    setTodos((prev) => (prev ?? []).map((each) => (each.id === saved.id ? saved : each)))
  }).catch(() => {
    // The rejection already surfaced through `onSettled`; swallowing it here
    // keeps a refused write from becoming an unhandled rejection.
  })
}

function removeTodo(todo: Todo) {
  void action(function* () {
    setOverlay(committed(() => latest(todos) ?? []).filter((each) => each.id !== todo.id))
    onSettled((outcome) => {
      if (outcome === 'discarded') {
        flash(`Could not remove "${todo.text}" — the server refused`, () => removeTodo(todo))
      }
    })
    yield* read(api.remove(todo.id))
    setTodos((prev) => (prev ?? []).filter((each) => each.id !== todo.id))
  }).catch(() => {
    // The rejection already surfaced through `onSettled`; swallowing it here
    // keeps a refused write from becoming an unhandled rejection.
  })
}

/* ------------------------------------------------------------- components */

function Skeleton() {
  return (
    <ul class="skeleton" data-testid="skeleton">
      <li/>
      <li/>
      <li/>
    </ul>
  )
}

function ServerPanel() {
  return (
    <aside class="panel">
      <h2>server</h2>
      <p class="hint">
        Canonical truth. The list on the left may be ahead of this while a write
        is in flight, and snaps back to it if the server refuses.
      </p>
      <ul class="canonical" data-testid="canonical-list">
        <For each={() => latest(todos) ?? []}>
          {(todo: Todo) => (
            <li class:done={() => todo.done} data-testid="canonical-row">
              {() => todo.text}
            </li>
          )}
        </For>
      </ul>
    </aside>
  )
}

function Controls() {
  return (
    <div class="controls">
      <label>
        latency
        <input
          data-testid="latency"
          attr:type="number"
          attr:min="0"
          attr:step="50"
          prop:defaultValue={String(config.latency)}
          on:input={(e: Event) => {
            config.latency = Number((e.target as HTMLInputElement).value)
          }}
        />
        ms
      </label>
      <label>
        failure rate
        <input
          data-testid="fail-rate"
          attr:type="number"
          attr:min="0"
          attr:max="1"
          attr:step="0.1"
          prop:defaultValue={String(config.failureRate)}
          on:input={(e: Event) => {
            config.failureRate = Number((e.target as HTMLInputElement).value)
          }}
        />
      </label>
      <button data-testid="refetch" on:click={() => setVersion((v) => v + 1)}>
        Refetch
      </button>
    </div>
  )
}

function TodoList() {
  return (
    <div class="list-area">
      <ul class="todo-list" class:speculative={speculating} data-testid="todo-list">
        <For
          each={() => {
            // The opt-in. Calling `use` here is what enrols this binding in the
            // surrounding `<Loading>`: it throws while the load is in flight, so
            // the boundary shows `initial` on a first load and holds the prior
            // list on a refetch. The rows themselves come from `visible()`.
            use(todos)
            return visible()
          }}
        >
          {(todo: Todo) => (
            <li class:done={() => todo.done} data-testid="todo-row">
              <input
                attr:type="checkbox"
                prop:checked={() => todo.done}
                on:change={() => toggleTodo(todo)}
              />
              <span class="text">{() => todo.text}</span>
              <button class="remove" on:click={() => removeTodo(todo)}>
                ×
              </button>
            </li>
          )}
        </For>
      </ul>
      <footer class="footer">
        <span class="count" data-testid="remaining">
          {() => {
            // Enrolled the same way, so the count and the list commit together
            // rather than the count updating a frame ahead of the rows.
            use(todos)
            return `${remaining()} left`
          }}
        </span>
        <div class="filters">
          <button
            data-testid="filter-all"
            class:active={() => filter() === 'all'}
            on:click={() => setFilter('all')}
          >
            All
          </button>
          <button
            data-testid="filter-active"
            class:active={() => filter() === 'active'}
            on:click={() => setFilter('active')}
          >
            Active
          </button>
          <button
            data-testid="filter-completed"
            class:active={() => filter() === 'completed'}
            on:click={() => setFilter('completed')}
          >
            Completed
          </button>
        </div>
      </footer>
    </div>
  )
}

function App() {
  return (
    <div class="app">
      <header class="top">
        <h1>todos</h1>
        <Show when={loading}>
          <span class="inflight" data-testid="inflight">
            loading…
          </span>
        </Show>
        {/* The third value `optimistic` hands back: true while any action has a
            live overlay, so the list is showing a guess rather than truth. */}
        <Show when={speculating}>
          <span class="inflight" data-testid="saving">
            saving…
          </span>
        </Show>
      </header>

      <Controls/>

      <input
        class="new-todo"
        data-testid="new-todo"
        attr:placeholder="What needs doing?"
        prop:value={draft}
        on:input={(e: Event) => setDraft((e.target as HTMLInputElement).value)}
        on:keydown={(e: Event) => {
          if ((e as KeyboardEvent).key === 'Enter') addTodo()
        }}
      />

      <Show when={notice}>
        <p class="notice" data-testid="notice">
          <span class="notice-message">{() => notice()?.message}</span>
          <Show when={() => notice()?.retry}>
            <button
              class="notice-retry"
              data-testid="notice-retry"
              on:click={() => {
                const pending = notice()
                setNotice(null)
                pending?.retry?.()
              }}
            >
              Retry
            </button>
          </Show>
        </p>
      </Show>

      <div class="columns">
        <Failed
          fallback={(error: unknown, reset: () => void) => (
            <div class="error" data-testid="error-panel">
              <p>{String((error as Error)?.message ?? error)}</p>
              <button data-testid="retry" on:click={reset}>
                Try again
              </button>
            </div>
          )}
        >
          {() => (
            // A static element between the boundary and its children: a
            // component sitting directly in the fragment here would be wrapped
            // under the outer hole's owner and never find the boundary's scope.
            <div class="main-column">
              <Loading initial={<Skeleton/>}>{() => <TodoList/>}</Loading>
            </div>
          )}
        </Failed>

        <ServerPanel/>
      </div>
    </div>
  )
}

render(() => <App/>, document.getElementById('app')!)
