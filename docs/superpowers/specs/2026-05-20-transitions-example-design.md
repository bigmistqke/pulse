# Design — `examples/transitions`: visualizing the qualities of async transitions

**Status:** approved design, ready for implementation planning.
**Date:** 2026-05-20.

## Purpose

Build an interactive example, `examples/transitions/`, that visualizes the four
failure modes a transition mechanism exists to prevent. Pulse handles Dim 1 (the
`<Loading>` gather) but lacks the rest of proper transition support, so the
example is expected to _exhibit most of the failures_ today — FM1 already works;
FM2–FM4 do not. It is a living demonstration of the problem space and, via its
tests, a living regression spec that turns fully green once transitions land.

The four failure modes are defined in
[`docs/async/transitions-problem-space.md`](../../async/transitions-problem-space.md)
and the lexicon
[`docs/async/CONTEXT.md`](../../async/CONTEXT.md):

- **FM1 — torn state.** A frame mixes old and new data.
- **FM2 — spinner flash.** A loading fallback appears and vanishes within a few frames.
- **FM3 — lost interactivity.** The committed-but-stale UI strobes or loses input focus.
- **FM4 — uncommittable speculation.** A superseded in-flight change corrupts committed state.

## Scope decisions

Settled during brainstorming:

- **All four failure modes** (FM1–FM4), one per tab.
- **Tabbed / routed layout** — four isolated views so timing-sensitive scenarios
  do not interfere.
- **Fake async with live latency controls** — in-memory mock resources with
  per-resource latency sliders; resolve order is a consequence of the latency
  values. Deterministic and explorable.
- **Color-coded scenario + event timeline** — each tab makes its fleeting
  failure observable through generation color-coding and a timestamped event log.
- **Idiomatic pulse; Playwright tests as the oracle** — each tab uses pulse the
  recommended way and shows pulse's _actual_ behavior. Tests assert the
  _correct_ transition behavior. FM1 passes today (pulse already gathers via
  `<Loading>`); FM2–FM4 are expected red until transitions land. The test
  results, not prose, are the source of truth for what currently fails.

## Architecture & file layout

A new example under `examples/transitions/`, structured like `examples/pokemon`
and `examples/todo` (own Vite + Playwright setup, `pulse` aliased to `../../src`
via `vite.config.ts`).

```
examples/transitions/
  package.json, index.html, vite.config.ts, tsconfig.json, playwright.config.ts
  src/
    main.tsx            — app shell: signal-based active-tab, tab bar
    style.css
    kernel/
      mock-async.ts       — configurable async sources (reactive latency, lifecycle events)
      event-log.ts        — per-tab event store + <EventTimeline>
      latency-controls.ts — <LatencyControls> sliders
      tab-frame.tsx       — shared per-tab chrome
    tabs/
      torn-state.tsx                — FM1
      spinner-flash.tsx             — FM2
      lost-interactivity.tsx        — FM3
      uncommittable-speculation.tsx — FM4
  tests/
    torn-state.spec.ts
    spinner-flash.spec.ts
    lost-interactivity.spec.ts
    uncommittable-speculation.spec.ts
```

`package.json` mirrors the other examples (`@pulse-examples/transitions`,
`dev`/`build`/`preview`/`test` scripts, `vite` + `@playwright/test` dev deps).

Tab routing is a plain `signal` holding the active tab id; the tab bar in
`main.tsx` sets it. Switching tabs remounts the tab — resetting its scenario
state and clearing its event log. No router library.

## The shared kernel

The architecture chosen (over a generic data-driven driver, and over no shared
layer) is **four self-contained tabs over a thin shared kernel**: the four
scenarios are structurally different and should stay independent, but they all
need identical timing and instrumentation primitives.

### `kernel/mock-async.ts`

An async data source whose latency is a **signal**, so the latency sliders drive
it live. Calling a source (e.g. `fetchProfile('bob')`):

1. emits a `request` event to the event log (resource name, generation, latency),
2. waits `latency()` ms,
3. emits a `resolve` event,
4. returns the value.

Resolve _order_ is therefore purely a consequence of the latency values — no
separate resolve-order control is needed. Sources are read into pulse via the
existing async-computed pattern (`computed(() => fetchX(arg()))`, read with
`use()`), exactly as `examples/pokemon` does.

### `kernel/event-log.ts`

A per-tab ordered event store with an `emit(event)` function and an
`<EventTimeline>` component (timestamped vertical list, newest at bottom). Four
event kinds:

- `action` — the user did something (emitted by tab code).
- `request` — async work started (emitted by `mock-async`).
- `resolve` — async work finished (emitted by `mock-async`).
- `commit` — a displayed value changed (emitted by a small per-pane `effect` in
  tab code that logs when its rendered value changes).

Events are color-coded by **generation** (e.g. alice vs bob, query-N) so
interleaving is visible after the transient frame has passed. The log is the
primary tool for studying a failure that flashed by too fast to see.

### `kernel/latency-controls.ts`

`<LatencyControls>` renders one slider per latency signal a tab registers.

### `kernel/tab-frame.tsx`

`<TabFrame>` gives every tab identical chrome: the failure-mode title, an
**Expected (the quality)** line and an **Actual (current pulse)** line, then
slots for the scenario pane, the latency sliders, and the event timeline. The
four tab files then contain only their scenario logic.

### Color-coding

The core visualization mechanism, used by every tab. Each _generation_ of a
transition gets a color; stale data renders in the old generation's color, fresh
data in the new one. A torn frame is then literally a multi-colored pane.

## The four tabs

### FM1 — Torn state (`tabs/torn-state.tsx`)

Profile page: a `userId` signal feeding three async derivations — `profile`
(header), `followers` (count), `posts` (list), all inside one `<Loading>`
boundary. A "Navigate alice → bob" button sets `userId`. Each of the three panes
is tinted by which generation's data it currently shows. Three latency sliders.

This is the tab that demonstrates the quality pulse **already has**: the
`<Loading>` boundary gathers the three pending fetches and commits them
together. The page holds one generation's color, then flips to the other
atomically — never multi-colored.

- **Quality shown:** coherent atomic commit (Dim 1). Pulse passes this — the
  test is green today.
- **Without the gather:** the panes would flip independently and the page would
  be multi-colored for a window; the tab's prose notes this is what `<Loading>`
  prevents.

### FM2 — Spinner flash (`tabs/spinner-flash.tsx`)

A `<Loading>`-wrapped pane fed by one async source, with a "Refetch" button, a
latency slider, and a **"Remount boundary"** button.

The genuine current pulse failure is the late-mounted boundary: `<Loading>`'s
`hasEverLoaded` is per-boundary closure state (`src/dom/loading.ts:142`), so a
refetch after the boundary is remounted is wrongly treated as a first load and
shows the fallback instead of holding prior — the spinner flashes when it should
not. (A plain refetch without remount holds prior correctly, and first load
showing `initial` is also correct; the remount is what exposes the bug.)

The timeline logs fallback shown/hidden with its duration.

- **Quality shown:** hold-prior across refetches, independent of boundary mount
  timing. Pulse fails the remount case — test red today.
- **Expected:** hold-prior survives a boundary remount.

### FM3 — Lost interactivity (`tabs/lost-interactivity.tsx`)

Typeahead: a `query` signal, a `results` async derivation, a text input and a
results list inside one `<Loading>`. Results are tinted by the query generation
that produced them; a latency slider controls fetch time.

- **Failure:** the results list strobes as the user types, and the input loses
  focus when the boundary drops to its fallback.
- **Expected:** the input stays mounted, focused, and responsive; prior results
  stay visible while the next query loads.

### FM4 — Uncommittable speculation (`tabs/uncommittable-speculation.tsx`)

A list with a "Show archived" toggle; toggling refetches the list. The user
toggles rapidly (on → off → on) with latency set high. Committed vs in-flight
generation are color-coded.

- **Failure:** a superseded toggle's fetch lands late and commits, contradicting
  the current toggle state.
- **Expected:** a superseded transition is discarded silently; committed state
  always matches the current toggle.

The doc's preview / what-if flavor of FM4 is **out of scope** — the toggle
scenario already exercises Dim 2 (concurrent) and Dim 4 (state-overlap).

## Tests & the living-spec framing

One Playwright spec per tab, each asserting the **correct** transition behavior.
The tests are the oracle for what pulse currently does:

- `torn-state.spec.ts` — during the transition, the DOM never has a frame with
  mixed-generation panes. **Green today** — pulse's `<Loading>` gather handles it.
- `spinner-flash.spec.ts` — hold-prior survives a boundary remount (no fallback
  flash). **Red today** — the `hasEverLoaded` fragility.
- `lost-interactivity.spec.ts` — the input keeps focus and prior results stay
  visible while a query is pending. **Red today** (expected) — no Dim 3 support.
- `uncommittable-speculation.spec.ts` — a superseded toggle never commits stale
  data. **Red today** (expected) — no Dim 2/4 support.

`package.json`'s `test` script runs all four; FM2–FM4 are intentionally red
until transitions land. The example README and this spec record that this is by
design. Each tab's `<TabFrame>` states the quality and pulse's actual behavior
in prose, so the example self-documents regardless of test state.

## Out of scope

- Pulse's actual transition implementation — this example only _visualizes_ the
  problem; it does not fix it.
- FM4's preview / what-if scenario.
- Pause/step scheduler controls (considered for observability; the event timeline
  was chosen instead).
- A router library; a generic data-driven scenario engine.

## References

- [`docs/async/transitions-problem-space.md`](../../async/transitions-problem-space.md)
  — the four failure modes, worked through with examples.
- [`docs/async/CONTEXT.md`](../../async/CONTEXT.md) — the
  lexicon: the four dimensions, the four failure modes.
- `src/dom/loading.ts` — pulse's current `<Loading>` gather; the `hasEverLoaded`
  fragility FM2 exercises is at line 142.
- `examples/pokemon/` — the reference for the async example pattern
  (`<Loading>`, `use()`, `useLoading()`, artificial fetch delay).
