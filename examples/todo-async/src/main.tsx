import {
	action,
	Errored,
	For,
	from,
	isErrored,
	isPending,
	latest,
	Loading,
	optimistic,
	render,
	Show,
	signal,
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
 * The `[]` default seeds the tolerant read's fallback, so every read below can
 * drop its own `?? []` — `latest(todos)`/`peek(todos)` report `[]` on their
 * own until the first load resolves. `setTodos`'s update form gets the same
 * substitution, so a mutation below can write `(prev) => [...prev, x]`
 * directly with no `?? []` of its own either.
 *
 * The seed says what to DISPLAY meanwhile; it does not claim the fetch has
 * finished. `latest` tracks genuine resolution separately, so this signal
 * still reports its first load to the surrounding `<Loading>` and still gets
 * the Skeleton — see ADR 0015.
 */
const [todos, setTodos] = signal(() => {
	version()
	return api.list()
}, [] as Todo[])

/**
 * What the UI reads. `optimistic` is `signal` with a different write
 * discipline: the same pipeline, the same stale-while-revalidate publishing,
 * the same registration with the pending and error trackers — but its setter
 * writes a layer in FRONT of the derivation rather than a value into it. The
 * layer leaks out, so every consumer sees the prediction at once; it stays
 * scoped to the action that wrote it, so a second in-flight write builds on
 * server truth rather than on a rival guess; and it is dropped when that
 * action closes, on either face. So a refused write rolls back with no
 * explicit undo, and a confirmed one survives only because the action also
 * wrote `todos`, which this recipe reads.
 *
 * Its accessor is an ordinary node, so the read verb is chosen at each read
 * site below rather than baked in here. Wrapping `todos` registers this node as
 * downstream of it: a refetch is reported through this node too, and the
 * boundary's retry resets `todos` rather than only re-running this recipe over
 * a source that is still parked.
 *
 * The `[]` default plays the same role it does on `todos` — it is what the
 * tolerant read reports until the first load resolves, so no read below needs
 * its own `?? []`.
 */
const [overlay, setOverlay, speculating] = optimistic(todos, [] as Todo[])

const visible = () => {
	const all = latest(overlay)
	const f = filter()
	if (f === 'active') return all.filter(todo => !todo.done)
	if (f === 'completed') return all.filter(todo => todo.done)
	return all
}

const remaining = () => latest(overlay).filter(todo => !todo.done).length

/* --------------------------------------------------------------- mutations */

/**
 * A refused write's error routes automatically to the nearest `<Errored>`
 * boundary — the generator's throw discards the action and its layer with it,
 * with no wiring needed here. The update form's `prev` is server truth, not
 * another in-flight action's guess: a layer is scoped to the action that wrote
 * it, so one action's prediction is never read into another's and can always
 * be withdrawn by the action that made it.
 */
function submitTodo(text: string) {
	// A placeholder id, negative so it cannot collide with a real one. It only
	// ever exists inside the overlay.
	const pending: Todo = { id: -Date.now(), text, done: false }
	action(function* () {
		setOverlay(prev => [...prev, pending])
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
		setOverlay(prev =>
			prev.map(each => (each.id === todo.id ? { ...each, done: !each.done } : each)),
		)
		const saved = yield* from(api.toggle(todo.id))
		setTodos(prev => prev.map(each => (each.id === saved.id ? saved : each)))
	})
}

function removeTodo(todo: Todo) {
	action(function* () {
		setOverlay(prev => prev.filter(each => each.id !== todo.id))
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
				<For each={visible()}>
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
				<span class="count" data-testid="remaining">{`${remaining()} left`}</span>
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
            originate from inside the same subtree below (the list's own
            `latest(todos)` reads and the row buttons all live in
            `<TodoList>`), so which one claims a given error depends entirely
            on `for`, not on where either boundary sits. Note that nothing in
            that subtree throws: a failed load reaches the outer boundary
            because `latest` reports its source's error state ambiently, the
            same way it reports pending — see ADR 0015. The outer boundary
            only accepts a LoadFailedError
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
