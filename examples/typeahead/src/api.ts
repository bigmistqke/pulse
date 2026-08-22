import { signal } from 'pulse'
import { CITIES, type City, type CityDetail } from './data'

export type { City, CityDetail }

export type SearchResult = {
	/**
	 * The query this result set was computed from. The list renders it, so a
	 * result set that reaches the screen after a newer query was typed is
	 * visible as a mismatch against the input instead of blending in.
	 */
	query: string
	cities: City[]
}

export type RequestKind = 'search' | 'detail'

export type Request = {
	id: number
	kind: RequestKind
	label: string
	/** Milliseconds since page load, at the moment the request was issued. */
	sentAt: number
	/** Milliseconds since page load, at the moment it resolved. Null while in flight. */
	settledAt: number | null
	/**
	 * The id of the first later request of the same kind that was issued while
	 * this one was still in flight. A request with an id here is one whose
	 * answer nothing should be waiting for by the time it arrives.
	 */
	supersededBy: number | null
}

export type LatencyMode = 'inverse' | 'fixed' | 'random'

function fromQuery(key: string, fallback: string): string {
	return new URLSearchParams(window.location.search).get(key) ?? fallback
}

let latencyMode = fromQuery('mode', 'inverse') as LatencyMode
let fixedLatency = Number(fromQuery('latency', '400'))

export const config = {
	get mode() {
		return latencyMode
	},
	set mode(value: LatencyMode) {
		latencyMode = value
	},
	get fixedLatency() {
		return fixedLatency
	},
	set fixedLatency(value: number) {
		fixedLatency = value
	},
}

/**
 * In `inverse` mode a shorter label is answered more slowly. Typing forwards
 * therefore issues requests whose answers arrive in reverse order, which is
 * the race a typeahead hits in production and which fixed latency never
 * reproduces.
 */
export function latencyFor(label: string): number {
	if (latencyMode === 'fixed') return fixedLatency
	if (latencyMode === 'random') return 150 + Math.round(Math.random() * 850)
	return Math.max(150, 1000 - label.length * 80)
}

const start = performance.now()

function now(): number {
	return Math.round(performance.now() - start)
}

const [requests, setRequests] = signal<Request[]>([])

export { requests }

export function clearLog(): void {
	setRequests([])
}

let nextId = 1

function begin(kind: RequestKind, label: string): Request {
	const request: Request = {
		id: nextId++,
		kind,
		label,
		sentAt: now(),
		settledAt: null,
		supersededBy: null,
	}
	// A search request is issued from inside the recompute that reacted to the
	// query changing. Deferring the log write keeps that write out of the
	// recompute, so the demo exercises supersession and nothing else.
	queueMicrotask(() => {
		setRequests(prev => [
			...prev.map(each =>
				each.kind === kind && each.settledAt === null && each.supersededBy === null
					? { ...each, supersededBy: request.id }
					: each,
			),
			request,
		])
	})
	return request
}

function end(request: Request): void {
	const settledAt = now()
	setRequests(prev => prev.map(each => (each.id === request.id ? { ...each, settledAt } : each)))
}

function respond<T>(kind: RequestKind, label: string, produce: () => T): Promise<T> {
	const request = begin(kind, label)
	const ms = latencyFor(label)
	return new Promise<T>(resolve => {
		setTimeout(() => {
			end(request)
			resolve(produce())
		}, ms)
	})
}

function matches(query: string): City[] {
	const needle = query.trim().toLowerCase()
	const found =
		needle === ''
			? CITIES
			: CITIES.filter(
					city =>
						city.name.toLowerCase().includes(needle) ||
						city.country.toLowerCase().includes(needle),
				)
	return found.map(({ name, country, population }) => ({ name, country, population }))
}

export function search(query: string): Promise<SearchResult> {
	return respond('search', query, () => ({ query, cities: matches(query) }))
}

export function detail(name: string): Promise<CityDetail> {
	return respond('detail', name, () => {
		const city = CITIES.find(each => each.name === name)
		if (city === undefined) throw new Error(`no city named ${name}`)
		return city
	})
}
