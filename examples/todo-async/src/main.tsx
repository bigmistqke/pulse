import {
	action,
	committed,
	Errored,
	For,
	isErrored,
	isPending,
	latest,
	Loading,
	optimistic,
	from,
	render,
	Show,
	signal,
	use,
} from 'pulse'
import { api, config, LoadFailedError, type Todo } from './api'

type Filter = 'all' | 'active' | 'completed'

/* ------------------------------------------------------------------ state */

const [filter, setFilter] = signal<Filter>('all')
const [draft, setDraft] = signal('')
/** Bumped to refetch. Read inside `todos`'s own stage, so it is a dependency
 *  of the fetch. */
const [version, setVersion] = signal(0)

/**
 * The load, and the write target once a mutation's request confirms — one
 * signal, two sources, so there is no separate mirror to keep in sync. A
 * plain function stage: it returns the fetch's promise directly, with
 * nothing to do after it resolves, so there is no need for a generator —
 * those are for a stage that keeps running after an `await`, not for a bare
 * fetch. Because `version` is read before the fetch starts, it is a
 * dependency — bumping it discards any in-flight request and starts over.
 *
 * This is canonical server truth. `setTodos` is called only with what the
 * server actually confirmed; the speculative guess a mutation shows before
 * that lives entirely in the overlay below, never here.
 *
 * The `[]` default seeds `latest(todos)`'s fallback, so every tolerant read
 * below can drop its own `?? []` — `latest(todos)` reports `[]` on its own
 * until the first load resolves, exactly as if that had already happened.
 * `setTodos`'s update form gets the same substitution, so a mutation below
 * can write `(prev) => [...prev, x]` directly with no `?? []` of its own
 * either. The strict read (`todos()`, `use(todos)`) is unaffected: it still
 * stays a Promise while the load is genuinely in flight.
 */
const [todos, setTodos] = signal(() => {
	version()
	return api.list()
}, [] as Todo[])

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
const [overlay, setOverlay, speculating] = optimistic(() => latest(todos))

const visible = () => {
	const all = overlay()
	const f = filter()
	if (f === 'active') return all.filter(todo => !todo.done)
	if (f === 'completed') return all.filter(todo => todo.done)
	return all
}

const remaining = () => overlay().filter(todo => !todo.done).length

/* --------------------------------------------------------------- mutations */

/**
 * A refused write's error routes automatically to the nearest `<Errored>`
 * boundary — the generator's throw discards the action and the overlay with
 * it, with no wiring needed here. Built from `committed(...)`, not
 * `overlay()`, so it layers on server truth rather than another in-flight
 * action's guess.
 */
function submitTodo(text: string) {
	// A placeholder id, negative so it cannot collide with a real one. It only
	// ever exists inside the overlay.
	const pending: Todo = { id: -Date.now(), text, done: false }
	action(function* () {
		setOverlay([...committed(() => latest(todos)), pending])
		const saved = yield* from(api.add(text))
		setTodos(prev => [...prev, saved])
	})
}

function addTodo() {
	const text = draft().trim()
	if (text === '') return
	setDraft('')
	submitTodo(text)
}

function toggleTodo(todo: Todo) {
	action(function* () {
		setOverlay(
			committed(() => latest(todos)).map(each =>
				each.id === todo.id ? { ...each, done: !each.done } : each,
			),
		)
		const saved = yield* from(api.toggle(todo.id))
		setTodos(prev => prev.map(each => (each.id === saved.id ? saved : each)))
	})
}

function removeTodo(todo: Todo) {
	action(function* () {
		setOverlay(committed(() => latest(todos)).filter(each => each.id !== todo.id))
		yield* from(api.remove(todo.id))
		setTodos(prev => prev.filter(each => each.id !== todo.id))
	})
}

/* ------------------------------------------------------------- components */

function Skeleton() {
	return (
		<ul class="skeleton" data-testid="skeleton">
			<li />
			<li />
			<li />
		</ul>
	)
}

function ServerPanel() {
	return (
		<aside class="panel">
			<h2>server</h2>
			<p class="hint">
				Canonical truth. The list on the left may be ahead of this while a write is in flight, and
				snaps back to it if the server refuses.
			</p>
			<ul class="canonical" data-testid="canonical-list">
				<For each={latest(todos)}>
					{(todo: Todo) => (
						<li class:done={todo.done} data-testid="canonical-row">
							{todo.text}
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
			<button data-testid="refetch" on:click={() => setVersion(v => v + 1)}>
				Refetch
			</button>
		</div>
	)
}

/** Shows the nearest `<Errored>` boundary's error without unmounting
 *  anything — unlike the load boundary's `fallback`, this only overlays a
 *  message; it never swaps the list out. */
function MutationError() {
	return (
		<Errored.Error>
			{(error, retry) => (
				<div class="mutation-error" data-testid="mutation-error-panel">
					<p>{String((error as Error)?.message ?? error)}</p>
					<button data-testid="mutation-retry" on:click={retry}>
						Try again
					</button>
				</div>
			)}
		</Errored.Error>
	)
}

function TodoList() {
	return (
		<div class="list-area">
			<MutationError />
			<ul class="todo-list" class:speculative={speculating()} data-testid="todo-list">
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
						<li class:done={todo.done} data-testid="todo-row">
							<input
								attr:type="checkbox"
								prop:checked={todo.done}
								on:change={() => toggleTodo(todo)}
							/>
							<span class="text">{todo.text}</span>
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
						class:active={filter() === 'all'}
						on:click={() => setFilter('all')}
					>
						All
					</button>
					<button
						data-testid="filter-active"
						class:active={filter() === 'active'}
						on:click={() => setFilter('active')}
					>
						Active
					</button>
					<button
						data-testid="filter-completed"
						class:active={filter() === 'completed'}
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
				{/* True while the load is in flight, including a refetch over a visible list. */}
				<Show when={isPending(todos)}>
					<span class="inflight" data-testid="inflight">
						loading…
					</span>
				</Show>
				{/* The third value `optimistic` hands back: true while any action has a
            live overlay, so the list is showing a guess rather than truth. */}
				<Show when={speculating()}>
					<span class="inflight" data-testid="saving">
						saving…
					</span>
				</Show>
			</header>

			<Controls />

			<div class="columns">
				{/* Two boundaries at the same wrapping point, split by error type
            rather than by position — the load and every mutation both
            originate from inside the same subtree below (`use(todos)` and
            the row buttons both live in `<TodoList>`), so which one claims
            a given error depends entirely on `for`, not on where either
            boundary sits. The outer boundary only accepts a LoadFailedError
            (`list()`'s own error class) and swaps the whole column for it —
            there is nothing useful to show once the load itself failed. The
            inner boundary accepts everything else (every mutation error)
            and has no `fallback`: it is pure scoping, so `<MutationError>`
            inside `TodoList` can show the error without unmounting
            anything, and a mutation error never reaches the outer swap. */}
				<Errored
					for={(e): e is LoadFailedError => e instanceof LoadFailedError}
					fallback={(error, reset: () => void) => (
						<div class="error" data-testid="error-panel">
							<p>{error.message}</p>
							<button data-testid="retry" on:click={reset}>
								Try again
							</button>
						</div>
					)}
				>
					<div class="main-column">
						<Errored for={e => !(e instanceof LoadFailedError)}>
							<div class="mutation-scope">
								<input
									class="new-todo"
									// Unfiltered: reads the same boundary MutationError
									// does, just to drive a CSS class rather than to
									// render anything — isErrored() !== undefined is
									// exactly "is a mutation currently failing", with no
									// swap involved. As a getter, this is called fresh on
									// every reactive read, so it needs no stored accessor.
									class:has-error={isErrored() !== undefined}
									data-testid="new-todo"
									attr:placeholder="What needs doing?"
									prop:value={draft()}
									on:input={(e: Event) => setDraft((e.target as HTMLInputElement).value)}
									on:keydown={(e: Event) => {
										if ((e as KeyboardEvent).key === 'Enter') addTodo()
									}}
								/>
								<Loading initial={<Skeleton />}>
									<TodoList />
								</Loading>
							</div>
						</Errored>
					</div>
				</Errored>
				<ServerPanel />
			</div>
		</div>
	)
}

render(() => <App />, document.getElementById('app')!)
