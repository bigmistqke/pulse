# `examples/transitions` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `examples/transitions`, a tabbed interactive example that visualizes the four async-transition failure modes (torn state, spinner flash, lost interactivity, uncommittable speculation) using pulse idiomatically.

**Architecture:** A new pnpm-workspace example (`examples/transitions`, Vite + Playwright, `pulse` aliased to `../../src`). Four self-contained tab components over a thin shared kernel: `mock-async` (configurable-latency async sources), `event-log` (timeline store + component), `latency-controls` (sliders), `tab-frame` (shared chrome). Each tab uses idiomatic pulse and shows pulse's *actual* behavior; one Playwright spec per tab asserts the *correct* transition behavior — FM1 passes today, FM2–FM4 are red until pulse gains transition support.

**Tech Stack:** TypeScript, pulse (local `../../src`), Vite 6, Playwright, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-05-20-transitions-example-design.md`.

**Reference example:** `examples/pokemon` — copy its config conventions exactly (JSX via `jsxImportSource: pulse`, `vite.config.ts` aliases, `playwright.config.ts` webServer pattern).

**Notes for the implementer:**
- pulse JSX uses `on:click` / `on:input`, `class:name={accessor}`, `attr:foo`, `prop:foo`, and function children `{() => …}` for reactive regions. See `examples/pokemon/src/main.tsx`.
- An async derivation is `computed(() => promiseReturningExpr())`, read with `use(x)`; `use` throws inside a binding until resolved and is caught by the nearest `<Loading>`.
- pulse's exact behavior for FM3/FM4 is **not pre-known**. Build the scenario faithfully; the Playwright spec is the oracle. If a spec for FM2/FM3/FM4 is red, that is the expected, documented outcome — do not "fix" pulse.
- Run commands from `examples/transitions/` unless stated otherwise.

---

## Task 1: Scaffold the example project

**Files:**
- Create: `examples/transitions/package.json`
- Create: `examples/transitions/tsconfig.json`
- Create: `examples/transitions/vite.config.ts`
- Create: `examples/transitions/playwright.config.ts`
- Create: `examples/transitions/index.html`
- Create: `examples/transitions/src/style.css`
- Create: `examples/transitions/src/main.tsx`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@pulse-examples/transitions",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.60.0",
    "typescript": "^5.8.3",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "jsxImportSource": "pulse",
    "paths": {
      "pulse/jsx-runtime": ["../../src/jsx-runtime.ts"],
      "pulse": ["../../src/index.ts"]
    }
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 3: Create `vite.config.ts`**

```ts
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'pulse/jsx-runtime': resolve(here, '../../src/jsx-runtime.ts'),
      'pulse/jsx-dev-runtime': resolve(here, '../../src/jsx-runtime.ts'),
      'pulse': resolve(here, '../../src/index.ts'),
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'pulse',
  },
})
```

- [ ] **Step 4: Create `playwright.config.ts`** (port 5182 — pokemon uses 5181)

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5182',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite --port 5182',
    url: 'http://localhost:5182',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
```

- [ ] **Step 5: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>pulse — transitions</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `src/style.css`**

```css
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #e7e7ea;
  background: #16161a;
}
.app-head { padding: 16px 20px 0; }
.app-head h1 { font-size: 18px; margin: 0 0 12px; }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.tabs button {
  background: #232329; color: #9a9aa6; border: 1px solid #34343d;
  padding: 6px 12px; cursor: pointer; font: inherit; border-radius: 6px 6px 0 0;
}
.tabs button.active { background: #2f2f3a; color: #fff; border-bottom-color: #2f2f3a; }
.tab-host { padding: 16px 20px; }

.tab-frame { border: 1px solid #34343d; border-radius: 0 8px 8px 8px; padding: 16px; }
.tab-head h2 { margin: 0 0 8px; font-size: 16px; }
.tab-head p { margin: 2px 0; color: #b6b6c0; }
.tab-head .actual { color: #e0b86b; }
.tab-body { display: flex; gap: 16px; margin-top: 14px; flex-wrap: wrap; }
.scenario-pane { flex: 1 1 360px; }
.tab-side { flex: 1 1 280px; display: flex; flex-direction: column; gap: 12px; }

.scenario button {
  background: #3a3a82; color: #fff; border: 0; padding: 8px 14px;
  cursor: pointer; font: inherit; border-radius: 6px; margin-bottom: 12px;
}
.btn-row { display: flex; gap: 8px; }

/* generation color-coding — torn state is a literally multi-coloured card */
.pane, .list-card, .payload { padding: 8px 10px; border-radius: 6px; margin: 4px 0; }
[data-gen='alice'], [data-gen='active'], [data-gen='current'] { background: #1d3a52; }
[data-gen='bob'], [data-gen='archived'], [data-gen='superseded'] { background: #1d5238; }
[data-gen='stale'] { background: #52331d; }
.profile-card, .list-card { border: 1px solid #34343d; border-radius: 8px; padding: 8px; }
.payload.is-fallback { background: #52331d; color: #e0b86b; }

.latency-controls { border: 1px solid #34343d; border-radius: 8px; padding: 10px; }
.latency-controls h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; color: #9a9aa6; }
.knob { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.knob-name { width: 72px; color: #b6b6c0; }
.knob-value { width: 56px; text-align: right; color: #9a9aa6; }

.timeline { list-style: none; margin: 0; padding: 8px; max-height: 260px; overflow: auto;
  border: 1px solid #34343d; border-radius: 8px; font-size: 12px; }
.evt { display: flex; gap: 8px; padding: 1px 0; }
.evt-t { width: 56px; color: #6f6f7c; text-align: right; }
.evt-kind { width: 64px; }
.evt-action .evt-kind { color: #c98bdb; }
.evt-request .evt-kind { color: #e0b86b; }
.evt-resolve .evt-kind { color: #6bd49a; }
.evt-label { color: #d6d6dd; }
```

- [ ] **Step 7: Create `src/main.tsx` (placeholder that renders, replaced in Task 4)**

```tsx
import { render } from 'pulse'
import './style.css'

function App() {
  return <div class="app">transitions example — scaffolding</div>
}

render(() => <App />, document.getElementById('app')!)
```

- [ ] **Step 8: Install workspace deps**

Run (from repo root): `pnpm install`
Expected: completes; `examples/transitions` linked into the workspace.

- [ ] **Step 9: Verify the dev server renders**

Run (from `examples/transitions`): `pnpm exec vite --port 5182` then open `http://localhost:5182`.
Expected: page shows "transitions example — scaffolding". Stop the server (Ctrl-C).

- [ ] **Step 10: Verify typecheck passes**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add examples/transitions/package.json examples/transitions/tsconfig.json examples/transitions/vite.config.ts examples/transitions/playwright.config.ts examples/transitions/index.html examples/transitions/src/style.css examples/transitions/src/main.tsx pnpm-lock.yaml
git commit -m "feat(examples): scaffold transitions example"
```

---

## Task 2: Kernel — event log and mock async

**Files:**
- Create: `examples/transitions/src/kernel/event-log.tsx`
- Create: `examples/transitions/src/kernel/mock-async.ts`

- [ ] **Step 1: Create `src/kernel/event-log.tsx`**

The event log is a per-tab ordered store. Event kinds: `action` (user did something), `request` (async work started), `resolve` (async work finished). `<EventTimeline>` renders it.

```tsx
import { For, signal, type Accessor } from 'pulse'

export type EventKind = 'action' | 'request' | 'resolve'

export interface LogEvent {
  seq: number
  t: number
  kind: EventKind
  label: string
  generation: string
}

export interface EventLog {
  events: Accessor<LogEvent[]>
  emit: (kind: EventKind, label: string, generation?: string) => void
  reset: () => void
}

export function createEventLog(): EventLog {
  const [events, setEvents] = signal<LogEvent[]>([])
  let seq = 0
  let start = performance.now()
  return {
    events,
    emit(kind, label, generation = '') {
      const t = Math.round(performance.now() - start)
      setEvents((prev) => [...prev, { seq: seq++, t, kind, label, generation }])
    },
    reset() {
      seq = 0
      start = performance.now()
      setEvents([])
    },
  }
}

export function EventTimeline(props: { log: EventLog }) {
  return (
    <ol class="timeline" attr:data-testid="timeline">
      <For each={() => props.log.events()}>
        {(e) => (
          <li class={`evt evt-${e.kind}`} attr:data-generation={e.generation}>
            <span class="evt-t">{`${e.t}ms`}</span>
            <span class="evt-kind">{e.kind}</span>
            <span class="evt-label">{e.label}</span>
          </li>
        )}
      </For>
    </ol>
  )
}
```

- [ ] **Step 2: Create `src/kernel/mock-async.ts`**

A configurable async source. `latencyKnob` is a named, reactive latency value driven by the sliders. `mockFetch` emits `request`, waits `knob.ms()`, emits `resolve`, returns `produce()`.

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
}

/** Emit `request`, wait `knob.ms()` (sampled now), emit `resolve`, return `produce()`. */
export function mockFetch<T>(options: MockFetchOptions<T>): Promise<T> {
  const { log, knob, generation, produce } = options
  const ms = knob.ms()
  log.emit('request', `${knob.name} (${ms}ms)`, generation)
  return new Promise<T>((resolve) => {
    setTimeout(() => {
      log.emit('resolve', `${knob.name}`, generation)
      resolve(produce())
    }, ms)
  })
}
```

- [ ] **Step 3: Verify typecheck**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/src/kernel/event-log.tsx examples/transitions/src/kernel/mock-async.ts
git commit -m "feat(examples): transitions kernel — event log and mock async"
```

---

## Task 3: Kernel — latency controls and tab frame

**Files:**
- Create: `examples/transitions/src/kernel/latency-controls.tsx`
- Create: `examples/transitions/src/kernel/tab-frame.tsx`

- [ ] **Step 1: Create `src/kernel/latency-controls.tsx`**

```tsx
import { For } from 'pulse'
import type { LatencyKnob } from './mock-async'

export function LatencyControls(props: { knobs: LatencyKnob[] }) {
  return (
    <div class="latency-controls">
      <h3>latency</h3>
      <For each={() => props.knobs}>
        {(knob) => (
          <label class="knob">
            <span class="knob-name">{knob.name}</span>
            <input
              attr:type="range"
              attr:min="0"
              attr:max="2000"
              attr:step="50"
              attr:data-testid={`latency-${knob.name}`}
              prop:value={() => knob.ms()}
              on:input={(e: Event) =>
                knob.setMs(Number((e.currentTarget as HTMLInputElement).value))
              }
            />
            <span class="knob-value">{() => `${knob.ms()}ms`}</span>
          </label>
        )}
      </For>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/kernel/tab-frame.tsx`**

```tsx
export interface TabFrameProps {
  title: string
  quality: string
  actual: string
  scenario: unknown
  controls: unknown
  timeline: unknown
}

export function TabFrame(props: TabFrameProps) {
  return (
    <section class="tab-frame">
      <header class="tab-head">
        <h2>{props.title}</h2>
        <p class="quality"><strong>Quality:</strong> {props.quality}</p>
        <p class="actual"><strong>Pulse today:</strong> {props.actual}</p>
      </header>
      <div class="tab-body">
        <div class="scenario-pane">{props.scenario}</div>
        <aside class="tab-side">
          <div class="controls-pane">{props.controls}</div>
          {props.timeline}
        </aside>
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Verify typecheck**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/src/kernel/latency-controls.tsx examples/transitions/src/kernel/tab-frame.tsx
git commit -m "feat(examples): transitions kernel — latency controls and tab frame"
```

---

## Task 4: App shell and stub tabs

**Files:**
- Create: `examples/transitions/src/tabs/torn-state.tsx`
- Create: `examples/transitions/src/tabs/spinner-flash.tsx`
- Create: `examples/transitions/src/tabs/lost-interactivity.tsx`
- Create: `examples/transitions/src/tabs/uncommittable-speculation.tsx`
- Modify: `examples/transitions/src/main.tsx` (full rewrite)

- [ ] **Step 1: Create the four stub tab files**

Each is a placeholder, replaced fully in Tasks 5–8. Create all four with this shape (change the export name and text per file):

`src/tabs/torn-state.tsx`:
```tsx
export function TornState() {
  return <div attr:data-testid="tab-body">FM1 — torn state (stub)</div>
}
```

`src/tabs/spinner-flash.tsx`:
```tsx
export function SpinnerFlash() {
  return <div attr:data-testid="tab-body">FM2 — spinner flash (stub)</div>
}
```

`src/tabs/lost-interactivity.tsx`:
```tsx
export function LostInteractivity() {
  return <div attr:data-testid="tab-body">FM3 — lost interactivity (stub)</div>
}
```

`src/tabs/uncommittable-speculation.tsx`:
```tsx
export function UncommittableSpeculation() {
  return <div attr:data-testid="tab-body">FM4 — uncommittable speculation (stub)</div>
}
```

- [ ] **Step 2: Rewrite `src/main.tsx` with tab routing**

Each tab is wrapped in its own `<Show>`. Switching tabs unmounts the old tab and mounts the new one fresh — a real remount, which Task 6 (FM2) relies on.

```tsx
import { render, Show, signal } from 'pulse'
import { LostInteractivity } from './tabs/lost-interactivity'
import { SpinnerFlash } from './tabs/spinner-flash'
import { TornState } from './tabs/torn-state'
import { UncommittableSpeculation } from './tabs/uncommittable-speculation'
import './style.css'

type TabId = 'torn-state' | 'spinner-flash' | 'lost-interactivity' | 'uncommittable'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'torn-state', label: 'FM1 · torn state' },
  { id: 'spinner-flash', label: 'FM2 · spinner flash' },
  { id: 'lost-interactivity', label: 'FM3 · lost interactivity' },
  { id: 'uncommittable', label: 'FM4 · uncommittable speculation' },
]

const [active, setActive] = signal<TabId>('torn-state')

function App() {
  return (
    <div class="app">
      <header class="app-head">
        <h1>transitions — the four failure modes</h1>
        <nav class="tabs">
          {TABS.map((tab) => (
            <button
              class:active={() => active() === tab.id}
              attr:data-testid={`tab-${tab.id}`}
              on:click={() => setActive(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main class="tab-host">
        <Show when={() => active() === 'torn-state'}>{() => <TornState />}</Show>
        <Show when={() => active() === 'spinner-flash'}>{() => <SpinnerFlash />}</Show>
        <Show when={() => active() === 'lost-interactivity'}>{() => <LostInteractivity />}</Show>
        <Show when={() => active() === 'uncommittable'}>{() => <UncommittableSpeculation />}</Show>
      </main>
    </div>
  )
}

render(() => <App />, document.getElementById('app')!)
```

- [ ] **Step 3: Verify the shell runs and tabs switch**

Run (from `examples/transitions`): `pnpm exec vite --port 5182`, open `http://localhost:5182`.
Expected: four tab buttons; clicking each shows that tab's stub text; the active button is highlighted. Stop the server.

- [ ] **Step 4: Verify typecheck**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add examples/transitions/src/main.tsx examples/transitions/src/tabs
git commit -m "feat(examples): transitions app shell and stub tabs"
```

---

## Task 5: FM1 — torn state tab and spec

**Files:**
- Modify: `examples/transitions/src/tabs/torn-state.tsx` (full rewrite)
- Create: `examples/transitions/tests/torn-state.spec.ts`

- [ ] **Step 1: Rewrite `src/tabs/torn-state.tsx`**

A profile page: `userId` feeds three async derivations, all inside one `<Loading>`. Each pane carries `data-gen` = the user whose data it shows. Pulse's gather commits the three together, so the card never shows mixed `data-gen`.

```tsx
import { computed, For, Loading, signal, use } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

type UserId = 'alice' | 'bob'

const DATA: Record<UserId, { name: string; count: number; titles: string[] }> = {
  alice: { name: 'Alice Alpha', count: 128, titles: ['alice: hello world', 'alice: on signals'] },
  bob: { name: 'Bob Beta', count: 57, titles: ['bob: first post', 'bob: async woes', 'bob: redux rant'] },
}

export function TornState() {
  const log = createEventLog()
  const profileKnob = latencyKnob('profile', 200)
  const followersKnob = latencyKnob('followers', 600)
  const postsKnob = latencyKnob('posts', 1200)

  const [userId, setUserId] = signal<UserId>('alice')

  const profile = computed<{ user: UserId; name: string }>(() => {
    const u = userId()
    return mockFetch({ log, knob: profileKnob, generation: u, produce: () => ({ user: u, name: DATA[u].name }) })
  })
  const followers = computed<{ user: UserId; count: number }>(() => {
    const u = userId()
    return mockFetch({ log, knob: followersKnob, generation: u, produce: () => ({ user: u, count: DATA[u].count }) })
  })
  const posts = computed<{ user: UserId; titles: string[] }>(() => {
    const u = userId()
    return mockFetch({ log, knob: postsKnob, generation: u, produce: () => ({ user: u, titles: DATA[u].titles }) })
  })

  function navigate() {
    const next: UserId = userId() === 'alice' ? 'bob' : 'alice'
    log.emit('action', `navigate → ${next}`, next)
    setUserId(next)
  }

  const scenario = (
    <div class="scenario">
      <button attr:data-testid="navigate" on:click={navigate}>navigate alice ⇄ bob</button>
      <Loading initial={<div class="profile-card">loading…</div>}>
        {() => (
          <div class="profile-card" attr:data-testid="profile-card">
            <div class="pane pane-header" attr:data-gen={() => use(profile).user}>
              {() => use(profile).name}
            </div>
            <div class="pane pane-followers" attr:data-gen={() => use(followers).user}>
              {() => `${use(followers).count} followers`}
            </div>
            <ul class="pane pane-posts" attr:data-gen={() => use(posts).user}>
              <For each={() => use(posts).titles}>{(title) => <li>{title}</li>}</For>
            </ul>
          </div>
        )}
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="FM1 · Torn state"
      quality="One logical change fans out into several fetches; the page must move from one coherent state to the next, never a frame that mixes them."
      actual="Handled. The <Loading> boundary gathers all three fetches and commits them together — the card never shows mixed-generation panes."
      scenario={scenario}
      controls={<LatencyControls knobs={[profileKnob, followersKnob, postsKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
```

- [ ] **Step 2: Create `tests/torn-state.spec.ts`**

```ts
import { expect, test } from '@playwright/test'

test.describe('FM1 — torn state', () => {
  test('the three panes never show mixed generations during a transition', async ({ page }) => {
    await page.goto('/')
    // FM1 is the default tab.
    const panes = page.locator('[data-testid="profile-card"] .pane')
    await expect(panes).toHaveCount(3)
    for (let i = 0; i < 3; i++) {
      await expect(panes.nth(i)).toHaveAttribute('data-gen', 'alice')
    }

    await page.locator('[data-testid="navigate"]').click()

    // Poll the DOM through the whole transition: the set of data-gen values
    // must never contain more than one generation.
    const sawTorn = await page.evaluate(async () => {
      let torn = false
      const deadline = performance.now() + 2500
      while (performance.now() < deadline) {
        const gens = [...document.querySelectorAll('[data-testid="profile-card"] .pane')]
          .map((el) => el.getAttribute('data-gen'))
          .filter((g): g is string => g !== null)
        if (new Set(gens).size > 1) torn = true
        await new Promise((r) => setTimeout(r, 8))
      }
      return torn
    })
    expect(sawTorn).toBe(false)

    for (let i = 0; i < 3; i++) {
      await expect(panes.nth(i)).toHaveAttribute('data-gen', 'bob')
    }
  })
})
```

- [ ] **Step 3: Run the spec**

Run (from `examples/transitions`): `pnpm exec playwright test torn-state`
Expected: **PASS** — pulse's `<Loading>` gather commits the three panes together.
If it fails, the gather is not behaving as the research describes — stop and report; do not change pulse.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/src/tabs/torn-state.tsx examples/transitions/tests/torn-state.spec.ts
git commit -m "feat(examples): transitions FM1 — torn state tab and spec"
```

---

## Task 6: FM2 — spinner flash tab and spec

**Files:**
- Modify: `examples/transitions/src/tabs/spinner-flash.tsx` (full rewrite)
- Create: `examples/transitions/tests/spinner-flash.spec.ts`

- [ ] **Step 1: Rewrite `src/tabs/spinner-flash.tsx`**

One async source behind a `<Loading>` that has `initial` only (no `fallback`) — so a normal refetch holds prior, and the `initial` element should appear only on a genuine first load. A "Remount boundary" button toggles a `<Show>`, unmounting and remounting the `<Loading>`; after a remount the boundary's `hasEverLoaded` is reset and the next refetch wrongly shows `initial` (the bug).

```tsx
import { computed, Loading, Show, signal, use } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function SpinnerFlash() {
  const log = createEventLog()
  const knob = latencyKnob('data', 400)
  const [version, setVersion] = signal(0)
  const [mounted, setMounted] = signal(true)

  const data = computed<{ version: number; text: string }>(() => {
    const v = version()
    return mockFetch({
      log, knob, generation: `v${v}`,
      produce: () => ({ version: v, text: `payload #${v}` }),
    })
  })

  function refetch() {
    const next = version() + 1
    log.emit('action', `refetch → v${next}`, `v${next}`)
    setVersion(next)
  }
  function remount() {
    log.emit('action', 'remount boundary')
    setMounted(false)
    setMounted(true)
  }

  const boundary = () => (
    <Loading initial={<div class="payload is-fallback" attr:data-testid="fallback">loading…</div>}>
      {() => (
        <div class="payload" attr:data-testid="payload" attr:data-gen="current">
          {() => use(data).text}
        </div>
      )}
    </Loading>
  )

  const scenario = (
    <div class="scenario">
      <div class="btn-row">
        <button attr:data-testid="refetch" on:click={refetch}>refetch</button>
        <button attr:data-testid="remount" on:click={remount}>remount boundary</button>
      </div>
      <Show when={mounted}>{boundary}</Show>
    </div>
  )

  return (
    <TabFrame
      title="FM2 · Spinner flash"
      quality="A boundary should hold prior content across a refetch — no fallback flash for content already shown — regardless of when the boundary was mounted."
      actual="Fails on remount. <Loading> tracks 'has ever loaded' per-boundary, so a boundary mounted after its data resolved treats the next refetch as a first load and flashes the fallback."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
```

- [ ] **Step 2: Create `tests/spinner-flash.spec.ts`**

```ts
import { expect, test } from '@playwright/test'

test.describe('FM2 — spinner flash', () => {
  test('hold-prior survives a boundary remount (no fallback flash)', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-spinner-flash"]').click()

    // First load completes.
    await expect(page.locator('[data-testid="payload"]')).toBeVisible()

    // A plain refetch holds prior: the fallback must not appear.
    await page.locator('[data-testid="refetch"]').click()
    await expect(page.locator('[data-testid="fallback"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="payload"]')).toContainText('payload #1')

    // Remount the boundary, then refetch. Correct behavior: still hold-prior,
    // no fallback. This is the FM2 failure — red until transitions land.
    await page.locator('[data-testid="remount"]').click()
    await page.locator('[data-testid="refetch"]').click()
    await expect(page.locator('[data-testid="fallback"]')).toHaveCount(0)
  })
})
```

- [ ] **Step 3: Run the spec**

Run (from `examples/transitions`): `pnpm exec playwright test spinner-flash`
Expected: **FAIL** at the post-remount assertion — the fallback appears because `hasEverLoaded` reset. This is the documented, intended red state. Record the actual result.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/src/tabs/spinner-flash.tsx examples/transitions/tests/spinner-flash.spec.ts
git commit -m "feat(examples): transitions FM2 — spinner flash tab and spec"
```

---

## Task 7: FM3 — lost interactivity tab and spec

**Files:**
- Modify: `examples/transitions/src/tabs/lost-interactivity.tsx` (full rewrite)
- Create: `examples/transitions/tests/lost-interactivity.spec.ts`

- [ ] **Step 1: Rewrite `src/tabs/lost-interactivity.tsx`**

A typeahead. The input is **outside** the `<Loading>` so it always stays in the DOM; the results list is **inside** one `<Loading>`. Each results item carries `data-gen` = the query that produced it, so a stale result landing after a newer query is visible as a color mismatch with the input.

```tsx
import { computed, For, Loading, signal, use } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

function resultsFor(query: string): string[] {
  if (query === '') return []
  return [1, 2, 3].map((n) => `${query} — result ${n}`)
}

export function LostInteractivity() {
  const log = createEventLog()
  const knob = latencyKnob('search', 500)
  const [query, setQuery] = signal('')

  const results = computed<{ query: string; items: string[] }>(() => {
    const q = query()
    return mockFetch({
      log, knob, generation: q || '(empty)',
      produce: () => ({ query: q, items: resultsFor(q) }),
    })
  })

  function onInput(e: Event) {
    const q = (e.currentTarget as HTMLInputElement).value
    log.emit('action', `type → "${q}"`, q || '(empty)')
    setQuery(q)
  }

  const scenario = (
    <div class="scenario">
      <input
        class="search-input"
        attr:data-testid="search"
        attr:placeholder="type a query…"
        on:input={onInput}
      />
      <Loading initial={<div class="list-card">type to search…</div>}>
        {() => (
          <ul
            class="list-card"
            attr:data-testid="results"
            attr:data-result-query={() => use(results).query}
          >
            <For each={() => use(results).items}>{(item) => <li>{item}</li>}</For>
          </ul>
        )}
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="FM3 · Lost interactivity"
      quality="While async work is in flight the committed UI must stay live — the input stays focused, prior results stay visible, and a stale query's results never replace a newer query's."
      actual="Observe: type quickly and watch whether focus survives, whether results strobe, and whether an earlier query's results ever land after a later one. The spec is the oracle."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
```

- [ ] **Step 2: Create `tests/lost-interactivity.spec.ts`**

```ts
import { expect, test } from '@playwright/test'

test.describe('FM3 — lost interactivity', () => {
  test('input keeps focus and stale results never replace newer ones', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-lost-interactivity"]').click()

    const search = page.locator('[data-testid="search"]')
    await search.click()

    // Type a sequence of queries quickly (each keystroke is a new query).
    for (const q of ['r', 're', 'rea', 'reac', 'react']) {
      await search.fill(q)
      await page.waitForTimeout(60)
    }

    // The input must still hold focus.
    await expect(search).toBeFocused()

    // Once everything settles, the results must reflect the LAST query and
    // never a stale earlier one.
    const results = page.locator('[data-testid="results"]')
    await expect(results).toHaveAttribute('data-result-query', 'react')
    await page.waitForTimeout(800)
    await expect(results).toHaveAttribute('data-result-query', 'react')
    await expect(results.locator('li').first()).toContainText('react')
  })
})
```

- [ ] **Step 3: Run the spec**

Run (from `examples/transitions`): `pnpm exec playwright test lost-interactivity`
Expected: **records pulse's actual behavior** — expected red (no Dim 3 support) but pulse's exact handling of stale results is empirical. Whatever the result, record it; do not change pulse.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/src/tabs/lost-interactivity.tsx examples/transitions/tests/lost-interactivity.spec.ts
git commit -m "feat(examples): transitions FM3 — lost interactivity tab and spec"
```

---

## Task 8: FM4 — uncommittable speculation tab and spec

**Files:**
- Modify: `examples/transitions/src/tabs/uncommittable-speculation.tsx` (full rewrite)
- Create: `examples/transitions/tests/uncommittable-speculation.spec.ts`

- [ ] **Step 1: Rewrite `src/tabs/uncommittable-speculation.tsx`**

A list with a "Show archived" toggle; toggling refetches. Rapid toggling puts two fetches in flight; the list carries `data-gen` = the toggle state its data reflects, so a superseded commit shows as a color mismatch with the toggle.

```tsx
import { computed, For, Loading, signal, use } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

const ACTIVE = ['active: draft a', 'active: draft b']
const ARCHIVED = ['archived: old one', 'archived: old two', 'archived: old three']

export function UncommittableSpeculation() {
  const log = createEventLog()
  const knob = latencyKnob('list', 800)
  const [archived, setArchived] = signal(false)

  const list = computed<{ archived: boolean; items: string[] }>(() => {
    const a = archived()
    return mockFetch({
      log, knob, generation: a ? 'archived' : 'active',
      produce: () => ({ archived: a, items: a ? ARCHIVED : ACTIVE }),
    })
  })

  function toggle() {
    const next = !archived()
    log.emit('action', `toggle → ${next ? 'archived' : 'active'}`, next ? 'archived' : 'active')
    setArchived(next)
  }

  const scenario = (
    <div class="scenario">
      <button attr:data-testid="toggle" on:click={toggle}>
        {() => `showing: ${archived() ? 'archived' : 'active'}`}
      </button>
      <Loading initial={<div class="list-card">loading…</div>}>
        {() => (
          <ul
            class="list-card"
            attr:data-testid="list"
            attr:data-gen={() => (use(list).archived ? 'archived' : 'active')}
          >
            <For each={() => use(list).items}>{(item) => <li>{item}</li>}</For>
          </ul>
        )}
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="FM4 · Uncommittable speculation"
      quality="A superseded in-flight change must be discardable — when the user toggles again before the first fetch lands, the committed list must match the latest toggle, never the abandoned one."
      actual="Observe: toggle rapidly and watch whether a superseded fetch commits and briefly contradicts the toggle. The spec is the oracle."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
```

- [ ] **Step 2: Create `tests/uncommittable-speculation.spec.ts`**

```ts
import { expect, test } from '@playwright/test'

test.describe('FM4 — uncommittable speculation', () => {
  test('a superseded toggle never leaves the committed list contradicting the toggle', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-uncommittable"]').click()

    const list = page.locator('[data-testid="list"]')
    await expect(list).toBeVisible()
    await expect(list).toHaveAttribute('data-gen', 'active')

    // Toggle to archived, then immediately back to active — the archived
    // fetch is now superseded.
    const toggle = page.locator('[data-testid="toggle"]')
    await toggle.click()
    await page.waitForTimeout(80)
    await toggle.click()

    // Through the rest of both fetches the committed list must never show the
    // superseded 'archived' generation.
    const sawSuperseded = await page.evaluate(async () => {
      let bad = false
      const deadline = performance.now() + 2500
      while (performance.now() < deadline) {
        const gen = document.querySelector('[data-testid="list"]')?.getAttribute('data-gen')
        if (gen === 'archived') bad = true
        await new Promise((r) => setTimeout(r, 8))
      }
      return bad
    })
    expect(sawSuperseded).toBe(false)
    await expect(list).toHaveAttribute('data-gen', 'active')
  })
})
```

- [ ] **Step 3: Run the spec**

Run (from `examples/transitions`): `pnpm exec playwright test uncommittable-speculation`
Expected: **records pulse's actual behavior** — expected red (no Dim 2/4 support); pulse's exact stale-commit handling is empirical. Record the result; do not change pulse.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/src/tabs/uncommittable-speculation.tsx examples/transitions/tests/uncommittable-speculation.spec.ts
git commit -m "feat(examples): transitions FM4 — uncommittable speculation tab and spec"
```

---

## Task 9: README and full verification

**Files:**
- Create: `examples/transitions/README.md`

- [ ] **Step 1: Create `examples/transitions/README.md`**

```markdown
# transitions — visualizing the four failure modes

An interactive example that demonstrates the four async-transition failure
modes from `docs/research/async/transitions-problem-space.md`. Each tab is a
small scenario built with **idiomatic pulse**; it shows pulse's *actual*
behavior today.

- **FM1 · torn state** — pulse handles this (the `<Loading>` gather). Test green.
- **FM2 · spinner flash** — fails on a boundary remount (`hasEverLoaded` is
  per-boundary). Test red.
- **FM3 · lost interactivity** — no input-arrival priority. Test red.
- **FM4 · uncommittable speculation** — no scoped-discard for superseded work.
  Test red.

Each tab has live latency sliders and an event timeline so the timing-sensitive
failures are observable and reproducible.

## Run

    pnpm dev      # http://localhost:5182
    pnpm test     # Playwright — FM2/FM3/FM4 are intentionally red until
                  # pulse gains transition support; FM1 is green.

The red tests are a **living regression spec**: they turn green when pulse
implements proper transitions.
```

- [ ] **Step 2: Run the full test suite**

Run (from `examples/transitions`): `pnpm test`
Expected: `torn-state` PASS; `spinner-flash`, `lost-interactivity`, `uncommittable-speculation` per the results recorded in Tasks 6–8 (expected red). This is the intended state.

- [ ] **Step 3: Verify typecheck and dev server one final time**

Run (from `examples/transitions`): `pnpm exec tsc --noEmit`
Expected: no errors.
Run: `pnpm exec vite --port 5182`, open `http://localhost:5182`, click through all four tabs, drag a latency slider, trigger each scenario, confirm the event timeline logs `action`/`request`/`resolve` and the color-coding renders. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add examples/transitions/README.md
git commit -m "docs(examples): transitions example README"
```

---

## Self-review notes

- **Spec coverage:** scaffold (Task 1) ✓; kernel — mock-async, event-log, latency-controls, tab-frame (Tasks 2–3) ✓; tabbed app shell (Task 4) ✓; four tabs FM1–FM4 (Tasks 5–8) ✓; four Playwright specs (Tasks 5–8) ✓; living-spec framing in README (Task 9) ✓.
- **Simplification vs spec:** the spec's event log listed a `commit` kind; this plan uses three kinds (`action`/`request`/`resolve`) — `request`/`resolve` already show the interleaving that produces or avoids a torn frame, and dropping `commit` removes fragile `<Loading>`-internal instrumentation. This is a deliberate YAGNI trim within the approved design.
- **Empirical tabs:** FM3 and FM4 assert the *correct* behavior; pulse's exact current behavior there is to be observed from the test runs, per the approved "idiomatic pulse; tests are the oracle" decision.
