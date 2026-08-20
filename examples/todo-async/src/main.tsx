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

const [filter, setFilter] = signal<Filter>('all')
const [draft, setDraft] = signal('')
const [version, setVersion] = signal(0)

const [todos, setTodos] = signal(() => {
	version()
	return api.list()
}, [] as Todo[])

const [overlay, setOverlay, speculating] = optimistic(todos, [] as Todo[])

const visible = () => {
	const all = latest(overlay)
	const f = filter()
	if (f === 'active') return all.filter(todo => !todo.done)
	if (f === 'completed') return all.filter(todo => todo.done)
	return all
}

const remaining = () => latest(overlay).filter(todo => !todo.done).length

function submitTodo(text: string) {
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
				<Show when={isPending(todos)}>
					<span class="inflight" data-testid="inflight">
						loading…
					</span>
				</Show>
				<Show when={speculating()}>
					<span class="inflight" data-testid="saving">
						saving…
					</span>
				</Show>
			</header>

			<Controls />

			<div class="columns">
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
