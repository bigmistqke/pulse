import { computed, For, isPending, latest, Loading, peek, render, Show, signal, use } from 'pulse'
import {
	clearLog,
	config,
	detail,
	requests,
	search,
	type LatencyMode,
	type Request,
	type SearchResult,
} from './api'
import './style.css'

const [query, setQuery] = signal('')
const [selected, setSelected] = signal('Amsterdam')
const [mode, setMode] = signal<LatencyMode>(config.mode)

/**
 * One request per keystroke, deliberately undebounced. Debouncing narrows the
 * window in which two requests are in flight at once but never closes it, so
 * it would hide the behaviour this demo is here to show.
 */
const results = computed(() => search(query()))

const NOTHING: SearchResult = { query: '', cities: [] }

/**
 * The result set on screen, which during a refetch is still the prior one.
 * `latest` rather than `use`: the list wants a total value and wants the
 * boundary to hear about the refresh, but has no reason to join its gate.
 */
const shown = () => latest(results, NOTHING)

/**
 * True when a settled result set on screen was computed from a query other
 * than the one in the box. Nothing should ever make this true: it would mean
 * an older request's answer had overwritten a newer one's.
 */
const listTorn = () => !isPending(results) && shown().query !== query()

/**
 * A selection is always a city name, never null, so this never has an absent
 * case and `use(record)` hands every field a settled record.
 */
const record = computed(() => detail(selected()))

/**
 * True when a settled record on screen is not the city that is selected.
 * `peek` rather than `use`: a check on what reached the screen has to read
 * with no coordination of its own, or it suspends during exactly the window
 * it exists to watch.
 */
const detailTorn = () => !isPending(record) && peek(record)?.name !== selected()

function Explainer() {
	return (
		<header class="explainer">
			<h1>typeahead — supersession</h1>
			<p>
				Type into the box. Every keystroke issues a request, and in the default latency mode a
				shorter query is answered more slowly than a longer one, so each request's answer arrives
				after the answer to the request that replaced it. The list must end up showing results for
				what is in the box, and must not flicker through the answers that arrived late.
			</p>
			<p>
				The same race runs on a second axis: click one city and then another before the first answer
				lands. The panel must end up on the city you clicked last.
			</p>
		</header>
	)
}

function Controls() {
	return (
		<div class="controls">
			<label>
				latency
				<select
					data-testid="mode"
					on:change={(e: Event) => {
						const value = (e.target as HTMLSelectElement).value as LatencyMode
						config.mode = value
						setMode(value)
					}}
				>
					<option attr:value="inverse" prop:selected={mode() === 'inverse'}>
						inverse — shorter label, slower answer
					</option>
					<option attr:value="fixed" prop:selected={mode() === 'fixed'}>
						fixed
					</option>
					<option attr:value="random" prop:selected={mode() === 'random'}>
						random
					</option>
				</select>
			</label>
			<Show when={mode() === 'fixed'}>
				<label>
					ms
					<input
						data-testid="fixed-latency"
						attr:type="number"
						attr:min="0"
						attr:step="50"
						prop:defaultValue={String(config.fixedLatency)}
						on:input={(e: Event) => {
							config.fixedLatency = Number((e.target as HTMLInputElement).value)
						}}
					/>
				</label>
			</Show>
			<button data-testid="clear-log" on:click={() => clearLog()}>
				Clear log
			</button>
		</div>
	)
}

function SearchBox() {
	return (
		<input
			class="search"
			data-testid="search"
			attr:type="search"
			attr:placeholder="Search cities…"
			attr:autocomplete="off"
			prop:value={query()}
			on:input={(e: Event) => setQuery((e.target as HTMLInputElement).value)}
		/>
	)
}

function ListSkeleton() {
	return (
		<ul class="skeleton" data-testid="list-skeleton">
			<li />
			<li />
			<li />
			<li />
			<li />
		</ul>
	)
}

function Results() {
	return (
		<div class="results">
			<div class="result-head">
				<span class="showing" data-testid="showing-query">
					{shown().query === '' ? 'every city' : `results for “${shown().query}”`}
				</span>
				<span class="count" data-testid="result-count">
					{shown().cities.length}
				</span>
				<Show when={isPending(results)}>
					<span class="inflight" data-testid="searching">
						searching…
					</span>
				</Show>
			</div>

			<Show when={listTorn()}>
				<p class="torn" data-testid="list-torn">
					{`the list settled on results for “${shown().query}” while the box says “${query()}”`}
				</p>
			</Show>

			<ul class="hits" class:stale={isPending(results)} data-testid="hits">
				<For each={shown().cities}>
					{city => (
						<li>
							<button
								class="hit"
								class:selected={selected() === city.name}
								data-testid="hit"
								on:click={() => setSelected(city.name)}
							>
								<span class="city">{city.name}</span>
								<span class="country">{city.country}</span>
								<span class="pop">{city.population.toLocaleString('en-US')}</span>
							</button>
						</li>
					)}
				</For>
			</ul>

			<Show when={!isPending(results) && shown().cities.length === 0}>
				<p class="empty" data-testid="empty">
					{`no city matches “${query()}”`}
				</p>
			</Show>
		</div>
	)
}

/**
 * The header sits outside the boundary and reads `isPending(record)` directly:
 * what it wants to know is whether this record is in flight, which is a fact
 * about the accessor and needs no scope at all. It never calls `use`, so it
 * commits on its own pass and names the city being requested while the fields
 * below still hold the previous one.
 *
 * The boundary wraps the fields and nothing else, and carries no `initial` or
 * `fallback` because it is not here to display anything — it is here to gate.
 * Each field calls `use(record)` and so suspends on its own, and the boundary
 * flushes them in a single pass.
 *
 * It is not what makes them agree here. All seven read the same record, so they
 * are invalidated together and recompute in one propagation with or without a
 * gate. The boundary is what a field reading a second source would join, and
 * this panel has no such field.
 */
function Detail() {
	return (
		<section class="detail">
			<div class="detail-head">
				<h2>detail</h2>
				<span class="requested" data-testid="detail-requested">
					{selected()}
				</span>
				<Show when={isPending(record)}>
					<span class="inflight" data-testid="detail-loading">
						loading…
					</span>
				</Show>
			</div>

			<Show when={detailTorn()}>
				<p class="torn" data-testid="detail-torn">
					{`the panel settled on ${peek(record)?.name} while ${selected()} is selected`}
				</p>
			</Show>

			<Loading>
				<div class="detail-body" class:stale={isPending(record)}>
					<h3 data-testid="detail-name">{use(record).name}</h3>
					<dl class="detail-fields">
						<dt>country</dt>
						<dd data-testid="detail-country">{use(record).country}</dd>
						<dt>population</dt>
						<dd>{use(record).population.toLocaleString('en-US')}</dd>
						<dt>timezone</dt>
						<dd>{use(record).timezone}</dd>
						<dt>founded</dt>
						<dd>{use(record).founded < 0 ? `${-use(record).founded} BCE` : use(record).founded}</dd>
						<dt>elevation</dt>
						<dd>{`${use(record).elevation} m`}</dd>
						<dt>rivers</dt>
						<dd>{use(record).rivers.join(', ')}</dd>
					</dl>
				</div>
			</Loading>
		</section>
	)
}

function verdict(request: Request): string {
	if (request.settledAt === null) return 'in flight'
	if (request.supersededBy === null) return 'applied'
	return `discarded — superseded by #${request.supersededBy}`
}

function timing(request: Request): string {
	return request.settledAt === null
		? `sent ${request.sentAt}ms`
		: `${request.sentAt}ms → ${request.settledAt}ms`
}

function RequestLog() {
	const recent = () => requests().slice(-16).reverse()
	return (
		<section class="log">
			<h2>requests</h2>
			<p class="hint">
				Newest first. A row is discarded when a later request of the same kind was issued before
				this one came back.
			</p>
			<ol class="log-rows">
				<For each={recent()}>
					{(request: Request) => (
						<li
							class:inflight={request.settledAt === null}
							class:discarded={request.settledAt !== null && request.supersededBy !== null}
							data-testid="log-row"
							attr:data-request-id={String(request.id)}
							attr:data-kind={request.kind}
							attr:data-label={request.label}
							attr:data-settled-at={request.settledAt === null ? '' : String(request.settledAt)}
							attr:data-superseded-by={
								request.supersededBy === null ? '' : String(request.supersededBy)
							}
						>
							<span class="row-id">{`#${request.id}`}</span>
							<span class="row-kind">{request.kind}</span>
							<span class="row-label">{request.label === '' ? '(everything)' : request.label}</span>
							<span class="row-timing">{timing(request)}</span>
							<span class="row-verdict">{verdict(request)}</span>
						</li>
					)}
				</For>
			</ol>
		</section>
	)
}

function App() {
	return (
		<div class="app">
			<Explainer />
			<Controls />
			<SearchBox />
			<div class="columns">
				<Loading initial={<ListSkeleton />}>
					<Results />
				</Loading>
				<div class="side">
					<Detail />
					<RequestLog />
				</div>
			</div>
		</div>
	)
}

render(() => <App />, document.getElementById('app')!)
