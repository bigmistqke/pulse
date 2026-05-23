# `examples/transitions` Edge-Case Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four edge-case tabs (E1–E4) to the existing `examples/transitions` example, each demonstrating a genuine limitation of pulse's current async machinery.

**Architecture:** Extends the existing example (Approach A — shared kernel + `TabFrame` pattern). One small kernel change (`mockFetch` gains an `AbortSignal` option), four new tab files, a grouped tab bar in `main.tsx`. Each tab ships a Playwright spec asserting the _correct_ behavior; E2/E3/E4 are expected red, E1 is an oracle.

**Tech Stack:** TypeScript, pulse (local `../../src`), Vite 6, Playwright, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-05-20-transitions-edge-cases-design.md`.

**Notes for the implementer:**

- The `examples/transitions` example already exists with a kernel (`src/kernel/{event-log.tsx,mock-async.ts,latency-controls.tsx,tab-frame.tsx}`), four FM tabs, and `src/main.tsx`. See any existing tab (e.g. `src/tabs/torn-state.tsx`) for the established pattern.
- An async derivation is `computed<Promise<T>>(() => mockFetch(...))`, read with `use(x)`. The explicit type arg is `Promise<T>` because `mockFetch` returns a Promise.
- Run commands from `examples/transitions/`. Commit directly to `main` (the user consented).
- Existing FM1/FM3/FM4 specs must stay green; FM2 stays red. The kernel change is additive (an optional option), so it must not affect them.

---

## Task 1: Kernel — `mockFetch` AbortSignal support

**Files:**

- Modify: `examples/transitions/src/kernel/mock-async.ts` (full rewrite)

- [ ] **Step 1: Rewrite `src/kernel/mock-async.ts`**

Adds an optional `signal?: AbortSignal` to `MockFetchOptions`. When the signal aborts before the latency timer fires, `mockFetch` clears the timer, skips `produce()`, emits a `resolve` event labelled `(cancelled)`, and rejects.

```ts
import { signal, type Accessor, type Setter } from 'pulse'
import type { EventLog } from './event-log'

export interface LatencyKnob {
	name: string
	ms: Accessor<number>
	setMs: Setter<number>
}

export function latencyKnob(name: string, initialMs: number): LatencyKnob {
	const [ms, setMs] = signal(initialMs)
	return { name, ms, setMs }
}

export interface MockFetchOptions<T> {
	log: EventLog
	knob: LatencyKnob
	generation: string
	produce: () => T
	/** Optional abort signal. If it aborts before the latency timer fires,
	 *  `produce` is skipped and the promise rejects. */
	signal?: AbortSignal
}

/**
 * Emit `request`, wait `knob.ms()` (sampled now), emit `resolve`, return
 * `produce()`. If `signal` aborts first: skip `produce`, emit a `(cancelled)`
 * resolve event, and reject.
 */
export function mockFetch<T>(options: MockFetchOptions<T>): Promise<T> {
	const { log, knob, generation, produce, signal } = options
	const ms = knob.ms()
	log.emit('request', `${knob.name} (${ms}ms)`, generation)
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			if (signal?.aborted) {
				log.emit('resolve', `${knob.name} (cancelled)`, generation)
				reject(new Error(`${knob.name} aborted`))
				return
			}
			log.emit('resolve', `${knob.name}`, generation)
			resolve(produce())
		}, ms)
		if (signal) {
			signal.addEventListener(
				'abort',
				() => {
					clearTimeout(timer)
					log.emit('resolve', `${knob.name} (cancelled)`, generation)
					reject(new Error(`${knob.name} aborted`))
				},
				{ once: true },
			)
		}
	})
}
```

- [ ] **Step 2: Verify typecheck**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify the existing suite is unaffected**

Run (from `examples/transitions`): `pnpm test`
Expected: unchanged — 3 passed (`torn-state`, `lost-interactivity`, `uncommittable-speculation`), 1 failed (`spinner-flash`). The kernel change is additive; if any FM spec's result changed, stop and report.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/src/kernel/mock-async.ts
git commit -m "feat(examples): transitions kernel — mockFetch AbortSignal support"
```

---

## Task 2: App shell — four stub tabs and grouped tab bar

**Files:**

- Create: `examples/transitions/src/tabs/stale-side-effects.tsx`
- Create: `examples/transitions/src/tabs/torn-across-boundaries.tsx`
- Create: `examples/transitions/src/tabs/optimistic-clobbered.tsx`
- Create: `examples/transitions/src/tabs/entanglement.tsx`
- Modify: `examples/transitions/src/main.tsx` (full rewrite)
- Modify: `examples/transitions/src/style.css` (append)

- [ ] **Step 1: Create the four stub tab files**

Each a placeholder, fleshed out in Tasks 3–6. Create with this shape (change export name + text per file):

`src/tabs/stale-side-effects.tsx`:

```tsx
export function StaleSideEffects() {
	return <div attr:data-testid="tab-body">E1 — stale side effects (stub)</div>
}
```

`src/tabs/torn-across-boundaries.tsx`:

```tsx
export function TornAcrossBoundaries() {
	return <div attr:data-testid="tab-body">E2 — torn across boundaries (stub)</div>
}
```

`src/tabs/optimistic-clobbered.tsx`:

```tsx
export function OptimisticClobbered() {
	return <div attr:data-testid="tab-body">E3 — optimistic clobbered (stub)</div>
}
```

`src/tabs/entanglement.tsx`:

```tsx
export function Entanglement() {
	return <div attr:data-testid="tab-body">E4 — entanglement (stub)</div>
}
```

- [ ] **Step 2: Rewrite `src/main.tsx`**

Adds the four edge-case tabs, a `group` field on each `TABS` entry, and a two-group tab bar.

```tsx
import { render, Show, signal } from 'pulse'
import { LostInteractivity } from './tabs/lost-interactivity'
import { SpinnerFlash } from './tabs/spinner-flash'
import { TornState } from './tabs/torn-state'
import { UncommittableSpeculation } from './tabs/uncommittable-speculation'
import { StaleSideEffects } from './tabs/stale-side-effects'
import { TornAcrossBoundaries } from './tabs/torn-across-boundaries'
import { OptimisticClobbered } from './tabs/optimistic-clobbered'
import { Entanglement } from './tabs/entanglement'
import './style.css'

type TabId =
	| 'torn-state'
	| 'spinner-flash'
	| 'lost-interactivity'
	| 'uncommittable'
	| 'stale-side-effects'
	| 'torn-across-boundaries'
	| 'optimistic-clobbered'
	| 'entanglement'

type TabGroup = 'failure-mode' | 'edge-case'

const TABS: Array<{ id: TabId; label: string; group: TabGroup }> = [
	{ id: 'torn-state', label: 'FM1 · torn state', group: 'failure-mode' },
	{ id: 'spinner-flash', label: 'FM2 · spinner flash', group: 'failure-mode' },
	{ id: 'lost-interactivity', label: 'FM3 · lost interactivity', group: 'failure-mode' },
	{ id: 'uncommittable', label: 'FM4 · uncommittable speculation', group: 'failure-mode' },
	{ id: 'stale-side-effects', label: 'E1 · stale side effects', group: 'edge-case' },
	{ id: 'torn-across-boundaries', label: 'E2 · torn across boundaries', group: 'edge-case' },
	{ id: 'optimistic-clobbered', label: 'E3 · optimistic clobbered', group: 'edge-case' },
	{ id: 'entanglement', label: 'E4 · entanglement', group: 'edge-case' },
]

const GROUPS: Array<{ group: TabGroup; label: string }> = [
	{ group: 'failure-mode', label: 'the four failure modes' },
	{ group: 'edge-case', label: 'edge cases — where it falls short' },
]

const [active, setActive] = signal<TabId>('torn-state')

function App() {
	return (
		<div class="app">
			<header class="app-head">
				<h1>transitions — failure modes &amp; edge cases</h1>
				<nav class="tabs">
					{GROUPS.map(g => (
						<div class="tab-group">
							<span class="tab-group-label">{g.label}</span>
							<div class="tab-group-buttons">
								{TABS.filter(t => t.group === g.group).map(tab => (
									<button
										class:active={() => active() === tab.id}
										attr:data-testid={`tab-${tab.id}`}
										on:click={() => setActive(tab.id)}
									>
										{tab.label}
									</button>
								))}
							</div>
						</div>
					))}
				</nav>
			</header>
			<main class="tab-host">
				<Show when={() => active() === 'torn-state'}>{() => <TornState />}</Show>
				<Show when={() => active() === 'spinner-flash'}>{() => <SpinnerFlash />}</Show>
				<Show when={() => active() === 'lost-interactivity'}>{() => <LostInteractivity />}</Show>
				<Show when={() => active() === 'uncommittable'}>{() => <UncommittableSpeculation />}</Show>
				<Show when={() => active() === 'stale-side-effects'}>{() => <StaleSideEffects />}</Show>
				<Show when={() => active() === 'torn-across-boundaries'}>
					{() => <TornAcrossBoundaries />}
				</Show>
				<Show when={() => active() === 'optimistic-clobbered'}>
					{() => <OptimisticClobbered />}
				</Show>
				<Show when={() => active() === 'entanglement'}>{() => <Entanglement />}</Show>
			</main>
		</div>
	)
}

render(() => <App />, document.getElementById('app')!)
```

- [ ] **Step 3: Append to `src/style.css`**

Add these rules at the end of the file:

```css
.tab-group {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin-right: 16px;
}
.tab-group-label {
	font-size: 11px;
	text-transform: uppercase;
	color: #6f6f7c;
}
.tab-group-buttons {
	display: flex;
	gap: 4px;
}
.tabs {
	align-items: flex-start;
}
.counter {
	margin-top: 10px;
	color: #b6b6c0;
}
```

- [ ] **Step 4: Verify the shell runs and typechecks**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit` — expect no errors.
Start the dev server (`pnpm exec vite --port 5182`), `curl -s http://localhost:5182` to confirm HTTP 200, stop the server. (You cannot open a browser visually; the typecheck plus the per-tab Playwright specs in Tasks 3–6 are the real verification.)

- [ ] **Step 5: Commit**

```bash
git add examples/transitions/src/main.tsx examples/transitions/src/style.css examples/transitions/src/tabs/stale-side-effects.tsx examples/transitions/src/tabs/torn-across-boundaries.tsx examples/transitions/src/tabs/optimistic-clobbered.tsx examples/transitions/src/tabs/entanglement.tsx
git commit -m "feat(examples): transitions — grouped tab bar and edge-case stubs"
```

---

## Task 3: E1 — stale side effects tab and spec

**Files:**

- Modify: `examples/transitions/src/tabs/stale-side-effects.tsx` (full rewrite)
- Create: `examples/transitions/tests/stale-side-effects.spec.ts`

**This spec is an ORACLE** — it passes only if pulse runs `onCleanup` when a `computed` re-runs (superseding the prior run). The outcome is genuinely unknown; record whatever happens. Do NOT modify pulse, do NOT loosen the test.

- [ ] **Step 1: Confirm `onCleanup` is exported from pulse**

Run (from repo root): `grep -n "onCleanup" src/index.ts`
Expected: `onCleanup` is re-exported. If it is NOT exported, stop and report NEEDS_CONTEXT — E1 needs it.

- [ ] **Step 2: Rewrite `src/tabs/stale-side-effects.tsx`**

```tsx
import { computed, Loading, onCleanup, signal, use } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function StaleSideEffects() {
	const log = createEventLog()
	const knob = latencyKnob('save', 600)
	const [version, setVersion] = signal(0)
	const [sideEffectsRan, setSideEffectsRan] = signal(0)

	const save = computed<Promise<{ version: number; text: string }>>(() => {
		const v = version()
		const controller = new AbortController()
		onCleanup(() => controller.abort())
		return mockFetch({
			log,
			knob,
			generation: `v${v}`,
			signal: controller.signal,
			produce: () => {
				setSideEffectsRan(n => n + 1)
				return { version: v, text: `saved #${v}` }
			},
		})
	})

	function doSave() {
		const next = version() + 1
		log.emit('action', `save → v${next}`, `v${next}`)
		setVersion(next)
	}

	const scenario = (
		<div class="scenario">
			<button attr:data-testid="save" on:click={doSave}>
				save
			</button>
			<Loading initial={<div class="payload">no save yet</div>}>
				{() => (
					<div class="payload" attr:data-testid="committed" attr:data-gen="current">
						{() => use(save).text}
					</div>
				)}
			</Loading>
			<div class="counter">
				side effects executed:{' '}
				<span attr:data-testid="side-effect-count">{() => sideEffectsRan()}</span>
			</div>
		</div>
	)

	return (
		<TabFrame
			title="E1 · Stale side effects"
			quality="When a computed run is superseded, its in-flight work should be cancellable — onCleanup should fire on re-run so a wired AbortController can abort it."
			actual="Oracle: counts whether a superseded save's side effect still runs. Passes only if pulse fires onCleanup when a computed re-runs."
			scenario={scenario}
			controls={<LatencyControls knobs={[knob]} />}
			timeline={<EventTimeline log={log} />}
		/>
	)
}
```

- [ ] **Step 3: Create `tests/stale-side-effects.spec.ts`**

```ts
import { expect, test } from '@playwright/test'

test.describe('E1 — stale side effects', () => {
	test('a superseded save cancels its in-flight work (side effect does not run)', async ({
		page,
	}) => {
		await page.goto('/')
		await page.locator('[data-testid="tab-stale-side-effects"]').click()

		// First save completes — 1 side effect.
		await page.locator('[data-testid="save"]').click()
		await expect(page.locator('[data-testid="committed"]')).toContainText('saved #1')
		await expect(page.locator('[data-testid="side-effect-count"]')).toHaveText('1')

		// Save twice rapidly — save #2 is superseded by save #3 before it resolves.
		await page.locator('[data-testid="save"]').click()
		await page.locator('[data-testid="save"]').click()
		await expect(page.locator('[data-testid="committed"]')).toContainText('saved #3')

		// Correct behavior: save #2 was cancelled, so only saves #1 and #3 ran
		// their side effect — total 2. Oracle: passes iff pulse fires onCleanup on
		// computed re-run.
		await page.waitForTimeout(900)
		await expect(page.locator('[data-testid="side-effect-count"]')).toHaveText('2')
	})
})
```

- [ ] **Step 4: Typecheck and run the spec**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit` — expect no errors.
Run: `pnpm exec playwright test stale-side-effects` — record the FULL output.

- PASS → pulse fires `onCleanup` on computed re-run; cancellation works.
- FAIL at the final assertion (count is `3`) → pulse does not cancel superseded runs.
  Either is a valid oracle result — record it. A failure of an _earlier_ assertion, or the tab not rendering, is a real bug in the tab/spec code — fix only that.

- [ ] **Step 5: Commit**

```bash
git add examples/transitions/src/tabs/stale-side-effects.tsx examples/transitions/tests/stale-side-effects.spec.ts
git commit -m "feat(examples): transitions E1 — stale side effects tab and spec"
```

---

## Task 4: E2 — torn across boundaries tab and spec

**Files:**

- Modify: `examples/transitions/src/tabs/torn-across-boundaries.tsx` (full rewrite)
- Create: `examples/transitions/tests/torn-across-boundaries.spec.ts`

**This spec is expected RED** — two sibling `<Loading>` boundaries commit independently. A failing spec is the intended living-spec state.

- [ ] **Step 1: Rewrite `src/tabs/torn-across-boundaries.tsx`**

```tsx
import { computed, For, Loading, signal, use } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

type UserId = 'alice' | 'bob'

const DATA: Record<UserId, { name: string; count: number; posts: string[] }> = {
	alice: { name: 'Alice Alpha', count: 128, posts: ['alice one', 'alice two'] },
	bob: { name: 'Bob Beta', count: 57, posts: ['bob one', 'bob two', 'bob three'] },
}

export function TornAcrossBoundaries() {
	const log = createEventLog()
	const headerKnob = latencyKnob('header', 200)
	const bodyKnob = latencyKnob('body', 1000)
	const [userId, setUserId] = signal<UserId>('alice')

	const headerData = computed<Promise<{ user: UserId; name: string }>>(() => {
		const u = userId()
		return mockFetch({
			log,
			knob: headerKnob,
			generation: u,
			produce: () => ({ user: u, name: DATA[u].name }),
		})
	})
	const countData = computed<Promise<{ user: UserId; count: number }>>(() => {
		const u = userId()
		return mockFetch({
			log,
			knob: bodyKnob,
			generation: u,
			produce: () => ({ user: u, count: DATA[u].count }),
		})
	})
	const postsData = computed<Promise<{ user: UserId; posts: string[] }>>(() => {
		const u = userId()
		return mockFetch({
			log,
			knob: bodyKnob,
			generation: u,
			produce: () => ({ user: u, posts: DATA[u].posts }),
		})
	})

	function navigate() {
		const next: UserId = userId() === 'alice' ? 'bob' : 'alice'
		log.emit('action', `navigate → ${next}`, next)
		setUserId(next)
	}

	const scenario = (
		<div class="scenario">
			<button attr:data-testid="navigate" on:click={navigate}>
				navigate alice ⇄ bob
			</button>
			<Loading initial={<div class="pane">loading header…</div>}>
				{() => (
					<div
						class="pane pane-header"
						attr:data-testid="header"
						attr:data-gen={() => use(headerData).user}
					>
						{() => use(headerData).name}
					</div>
				)}
			</Loading>
			<Loading initial={<div class="pane">loading body…</div>}>
				{() => (
					<div
						class="pane pane-body"
						attr:data-testid="body"
						attr:data-gen={() => use(countData).user}
					>
						<div>{() => `${use(countData).count} followers`}</div>
						<ul>
							<For each={() => use(postsData).posts}>{p => <li>{p}</li>}</For>
						</ul>
					</div>
				)}
			</Loading>
		</div>
	)

	return (
		<TabFrame
			title="E2 · Torn across boundaries"
			quality="One logical change spanning multiple <Loading> boundaries should commit as a whole — header and body must never show different generations at once."
			actual="Fails. Each boundary gathers correctly on its own, but the two commit independently — the header flips to the new user while the body still holds the old."
			scenario={scenario}
			controls={<LatencyControls knobs={[headerKnob, bodyKnob]} />}
			timeline={<EventTimeline log={log} />}
		/>
	)
}
```

- [ ] **Step 2: Create `tests/torn-across-boundaries.spec.ts`**

```ts
import { expect, test } from '@playwright/test'

test.describe('E2 — torn across boundaries', () => {
	test('header and body boundaries never show different generations at once', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-testid="tab-torn-across-boundaries"]').click()

		await expect(page.locator('[data-testid="header"]')).toHaveAttribute('data-gen', 'alice')
		await expect(page.locator('[data-testid="body"]')).toHaveAttribute('data-gen', 'alice')

		await page.locator('[data-testid="navigate"]').click()

		// Poll the whole transition: header and body must never disagree.
		const sawTear = await page.evaluate(async () => {
			let tear = false
			const deadline = performance.now() + 2500
			while (performance.now() < deadline) {
				const h = document.querySelector('[data-testid="header"]')?.getAttribute('data-gen')
				const b = document.querySelector('[data-testid="body"]')?.getAttribute('data-gen')
				if (h && b && h !== b) tear = true
				await new Promise(r => setTimeout(r, 8))
			}
			return tear
		})
		expect(sawTear).toBe(false)
	})
})
```

- [ ] **Step 3: Typecheck and run the spec**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit` — expect no errors.
Run: `pnpm exec playwright test torn-across-boundaries` — record the FULL output.
Expected: **FAIL** at `expect(sawTear).toBe(false)` — the header (200ms) commits before the body (1000ms). Intended red state. A failure of an earlier assertion or the tab not rendering is a real bug — fix only that.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/src/tabs/torn-across-boundaries.tsx examples/transitions/tests/torn-across-boundaries.spec.ts
git commit -m "feat(examples): transitions E2 — torn across boundaries tab and spec"
```

---

## Task 5: E3 — optimistic clobbered tab and spec

**Files:**

- Modify: `examples/transitions/src/tabs/optimistic-clobbered.tsx` (full rewrite)
- Create: `examples/transitions/tests/optimistic-clobbered.spec.ts`

**This spec is expected RED** — a refetch overwrites the shared `comments` signal and the optimistic entry vanishes.

- [ ] **Step 1: Rewrite `src/tabs/optimistic-clobbered.tsx`**

```tsx
import { For, signal } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

interface Comment {
	id: string
	text: string
	optimistic: boolean
}

const SERVER_LIST: Comment[] = [
	{ id: 's1', text: 'first comment', optimistic: false },
	{ id: 's2', text: 'second comment', optimistic: false },
]

export function OptimisticClobbered() {
	const log = createEventLog()
	const addKnob = latencyKnob('add', 1200)
	const refreshKnob = latencyKnob('refresh', 300)
	const [comments, setComments] = signal<Comment[]>(SERVER_LIST.map(c => ({ ...c })))
	let tempSeq = 0

	async function addComment() {
		const tempId = `temp-${tempSeq++}`
		const text = `optimistic comment ${tempId}`
		log.emit('action', `add (optimistic) ${tempId}`, 'stale')
		setComments(c => [...c, { id: tempId, text, optimistic: true }])
		const saved = await mockFetch({
			log,
			knob: addKnob,
			generation: 'stale',
			produce: (): Comment => ({ id: `srv-${tempId}`, text, optimistic: false }),
		})
		// Replace the optimistic entry; if a refetch already removed it, re-add.
		setComments(c => {
			const had = c.some(x => x.id === tempId)
			return had ? c.map(x => (x.id === tempId ? saved : x)) : [...c, saved]
		})
	}

	async function refresh() {
		log.emit('action', 'refresh', 'current')
		const list = await mockFetch({
			log,
			knob: refreshKnob,
			generation: 'current',
			produce: (): Comment[] => SERVER_LIST.map(c => ({ ...c })),
		})
		setComments(list)
	}

	const scenario = (
		<div class="scenario">
			<div class="btn-row">
				<button attr:data-testid="add" on:click={addComment}>
					add comment
				</button>
				<button attr:data-testid="refresh" on:click={refresh}>
					refresh
				</button>
			</div>
			<ul class="list-card" attr:data-testid="comments">
				<For each={() => comments()}>
					{c => (
						<li attr:data-gen={c.optimistic ? 'stale' : 'current'} attr:data-comment-id={c.id}>
							{c.text}
						</li>
					)}
				</For>
			</ul>
		</div>
	)

	return (
		<TabFrame
			title="E3 · Optimistic value clobbered by refetch"
			quality="An optimistic write must survive a refetch of the underlying data — the refetch sets committed truth; the optimistic entry stays on top until its own request settles."
			actual="Fails. Optimistic overlay and committed truth share one signal cell, so a refetch that lands first overwrites the list and the optimistic comment vanishes."
			scenario={scenario}
			controls={<LatencyControls knobs={[addKnob, refreshKnob]} />}
			timeline={<EventTimeline log={log} />}
		/>
	)
}
```

- [ ] **Step 2: Create `tests/optimistic-clobbered.spec.ts`**

```ts
import { expect, test } from '@playwright/test'

test.describe('E3 — optimistic value clobbered by refetch', () => {
	test('an optimistic comment survives a refetch that lands before its save', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-testid="tab-optimistic-clobbered"]').click()

		await expect(page.locator('[data-testid="comments"] li')).toHaveCount(2)

		// Add a comment (add latency 1200ms), then refresh (300ms) so the refresh
		// lands first. The optimistic comment must stay visible the whole time.
		await page.locator('[data-testid="add"]').click()
		await expect(page.locator('[data-testid="comments"] li')).toHaveCount(3)
		await page.locator('[data-testid="refresh"]').click()

		// Poll: the list must never drop below 3 items (the optimistic comment
		// must never vanish). Red until pulse has a scoped/overlay write.
		const vanished = await page.evaluate(async () => {
			let gone = false
			const deadline = performance.now() + 1800
			while (performance.now() < deadline) {
				if (document.querySelectorAll('[data-testid="comments"] li').length < 3) gone = true
				await new Promise(r => setTimeout(r, 8))
			}
			return gone
		})
		expect(vanished).toBe(false)
	})
})
```

- [ ] **Step 3: Typecheck and run the spec**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit` — expect no errors.
Run: `pnpm exec playwright test optimistic-clobbered` — record the FULL output.
Expected: **FAIL** at `expect(vanished).toBe(false)` — the refresh (300ms) overwrites `comments` before the add (1200ms) settles, so the count drops to 2. Intended red state. A failure of an earlier assertion or the tab not rendering is a real bug — fix only that.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/src/tabs/optimistic-clobbered.tsx examples/transitions/tests/optimistic-clobbered.spec.ts
git commit -m "feat(examples): transitions E3 — optimistic clobbered tab and spec"
```

---

## Task 6: E4 — entanglement tab and spec

**Files:**

- Modify: `examples/transitions/src/tabs/entanglement.tsx` (full rewrite)
- Create: `examples/transitions/tests/entanglement.spec.ts`

**This spec is expected RED** — Action A's captured input goes stale when Action B writes it mid-flight.

- [ ] **Step 1: Rewrite `src/tabs/entanglement.tsx`**

```tsx
import { signal } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function Entanglement() {
	const log = createEventLog()
	const bioKnob = latencyKnob('update-bio', 1000)
	const renameKnob = latencyKnob('rename', 300)
	const [displayName, setDisplayName] = signal('alice')
	const [bio, setBio] = signal('bio for alice')
	let renameSeq = 0

	async function updateBio() {
		const captured = displayName()
		log.emit('action', `update-bio reads name "${captured}"`, captured)
		await mockFetch({ log, knob: bioKnob, generation: captured, produce: () => null })
		setBio(`bio for ${captured}`)
		log.emit('action', `update-bio wrote bio for "${captured}"`, captured)
	}

	async function rename() {
		const next = `user-${++renameSeq}`
		log.emit('action', `rename → "${next}"`, next)
		await mockFetch({ log, knob: renameKnob, generation: next, produce: () => null })
		setDisplayName(next)
		log.emit('action', `rename committed "${next}"`, next)
	}

	const scenario = (
		<div class="scenario">
			<div class="btn-row">
				<button attr:data-testid="update-bio" on:click={updateBio}>
					update bio
				</button>
				<button attr:data-testid="rename" on:click={rename}>
					rename
				</button>
			</div>
			<div class="pane" attr:data-testid="display-name" attr:data-gen="current">
				name: {() => displayName()}
			</div>
			<div class="pane" attr:data-testid="bio" attr:data-gen="stale">
				{() => bio()}
			</div>
		</div>
	)

	return (
		<TabFrame
			title="E4 · Entanglement"
			quality="If an in-flight action read a value another action then changed, the committed result must stay coherent — the reader should re-run, block, or be flagged."
			actual="Fails. update-bio captures displayName, awaits, then writes a bio embedding the stale name — a concurrent rename leaves bio referencing the old name."
			scenario={scenario}
			controls={<LatencyControls knobs={[bioKnob, renameKnob]} />}
			timeline={<EventTimeline log={log} />}
		/>
	)
}
```

- [ ] **Step 2: Create `tests/entanglement.spec.ts`**

```ts
import { expect, test } from '@playwright/test'

test.describe('E4 — entanglement', () => {
	test('a concurrent rename does not leave bio referencing a stale name', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-testid="tab-entanglement"]').click()

		await expect(page.locator('[data-testid="display-name"]')).toContainText('alice')
		await expect(page.locator('[data-testid="bio"]')).toContainText('alice')

		// update-bio (1000ms) captures 'alice'. rename (300ms) mid-flight changes
		// the name. When update-bio commits, bio must reference the CURRENT name.
		await page.locator('[data-testid="update-bio"]').click()
		await page.locator('[data-testid="rename"]').click()

		// Wait for both to settle (rename at ~300ms, update-bio at ~1000ms).
		await expect(page.locator('[data-testid="display-name"]')).not.toContainText('alice', {
			timeout: 4000,
		})
		await page.waitForTimeout(1200)

		// The committed bio must reference whatever displayName now is.
		const nameText = (await page.locator('[data-testid="display-name"]').textContent()) ?? ''
		const bioText = (await page.locator('[data-testid="bio"]').textContent()) ?? ''
		const currentName = nameText.replace('name:', '').trim()
		expect(bioText).toContain(currentName)
	})
})
```

- [ ] **Step 3: Typecheck and run the spec**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit` — expect no errors.
Run: `pnpm exec playwright test entanglement` — record the FULL output.
Expected: **FAIL** at `expect(bioText).toContain(currentName)` — `bio` is `"bio for alice"` while `displayName` is `"user-1"`. Intended red state. A failure of an earlier assertion or the tab not rendering is a real bug — fix only that.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/src/tabs/entanglement.tsx examples/transitions/tests/entanglement.spec.ts
git commit -m "feat(examples): transitions E4 — entanglement tab and spec"
```

---

## Task 7: README update and full verification

**Files:**

- Modify: `examples/transitions/README.md` (full rewrite)

- [ ] **Step 1: Rewrite `examples/transitions/README.md`**

```markdown
# transitions — failure modes & edge cases

An interactive example demonstrating async-transition behavior in pulse. Each
tab is a small scenario built with **idiomatic pulse**; it shows pulse's
_actual_ behavior today. Each tab's Playwright spec asserts the _correct_
behavior — the spec is the oracle.

## The four failure modes

- **FM1 · torn state** — handled. The `<Loading>` gather commits the fetches
  atomically. **Test green.**
- **FM2 · spinner flash** — fails on a boundary remount (`hasEverLoaded` is
  per-boundary). **Test red.**
- **FM3 · lost interactivity** — handled in this scenario. **Test green.**
- **FM4 · uncommittable speculation** — handled in this scenario (superseded
  values discarded by promise identity). **Test green.**

## Edge cases — where it falls short

Scenarios that use pulse correctly and still expose a genuine gap:

- **E1 · stale side effects** — does a superseded `computed` run cancel its
  in-flight work? Wires an `AbortController` + `onCleanup`. **Oracle** — green
  iff pulse fires `onCleanup` on computed re-run.
- **E2 · torn across boundaries** — two sibling `<Loading>` boundaries each
  gather correctly but commit independently, so one logical change tears across
  them. The gather is per-boundary, not per-change. **Test red.**
- **E3 · optimistic clobbered** — an optimistic insert and committed truth share
  one signal cell, so a refetch overwrites the optimistic entry. No
  scoped/overlay write. **Test red.**
- **E4 · entanglement** — an action captures a value, awaits, and writes a
  result derived from it; a concurrent action changes that value mid-flight, so
  the result is committed stale. No entanglement / conflict detection (Dim 4).
  **Test red.**

Each tab has live latency sliders and an event timeline so the timing-sensitive
behavior is observable and reproducible.

## Run

    pnpm dev      # http://localhost:5182
    pnpm test     # Playwright

The red specs (FM2, E2, E3, E4) are a **living regression spec** — they turn
green when pulse gains the corresponding transition capability. E1 is an oracle:
its result depends on pulse's cleanup lifecycle. See
`docs/async/pulse-design-direction.md` for the unbuilt transition
surface these edge cases probe.
```

- [ ] **Step 2: Run the full suite**

Run (from `examples/transitions`): `pnpm test` — record the FULL output.
Expected: **FM1, FM3, FM4 pass; FM2, E2, E3, E4 fail; E1 is an oracle** (pass or fail). So either 3 passed / 5 failed (E1 red) or 4 passed / 4 failed (E1 green). Any _other_ shape — e.g. FM1/FM3/FM4 changing, or E2/E3/E4 passing — is a regression: report DONE_WITH_CONCERNS with the full output; do not "fix" it.

- [ ] **Step 3: Verify typecheck**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit` — expect no errors.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/README.md
git commit -m "docs(examples): transitions README — add the edge-case tabs"
```

---

## Self-review notes

- **Spec coverage:** kernel `AbortSignal` (Task 1) ✓; grouped tab bar + 4 stubs (Task 2) ✓; E1 stale-side-effects with `onCleanup`/`AbortController` oracle (Task 3) ✓; E2 torn-across-boundaries, two `<Loading>` boundaries (Task 4) ✓; E3 optimistic-clobbered, S7 refetch-clobbers (Task 5) ✓; E4 entanglement, S5 captured-stale-input (Task 6) ✓; README + verification (Task 7) ✓.
- **Type consistency:** `mockFetch` `MockFetchOptions` gains `signal?: AbortSignal` (Task 1) and is used with `signal:` only in Task 3; the `computed<Promise<T>>` form is used in Tasks 3–4; `TabId` / `TabGroup` in Task 2 cover all eight tabs.
- **Empirical tabs:** E1 is an oracle (outcome recorded, not pre-asserted); E2/E3/E4 assert correct behavior and are expected red. A red spec is the intended deliverable for those — implementers must not weaken tests or change pulse.
