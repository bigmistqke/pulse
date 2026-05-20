# Design — `examples/transitions` edge-case showcase

**Status:** approved design, ready for implementation planning.
**Date:** 2026-05-20.

## Purpose

Extend the `examples/transitions` example with four **edge-case tabs** — scenarios
where pulse's current async machinery genuinely falls short. The original four
tabs (FM1–FM4) showed that pulse, used idiomatically, handles the *narrow*
single-derivation versions of three of the four failure modes (FM1/FM3/FM4 green,
FM2 red). That undersells the problem space: it leaves the impression pulse has
few gaps. The edge-case tabs correct this by demonstrating the genuine
limitations — the unbuilt transition surface described in
[`docs/research/async/pulse-design-direction.md`](../../research/async/pulse-design-direction.md).

Each edge-case tab uses pulse **correctly** (not naive throwaway code) and still
fails, because pulse lacks a specific primitive. Each ships a Playwright spec
asserting the correct behavior; all four are expected **red** — living regression
specs that turn green when pulse gains the corresponding capability.

## Scope decisions

Settled during brainstorming:

- **Four edge cases**, one tab each: E1 stale side effects, E2 torn across
  boundaries, E3 optimistic update + rollback, E4 entanglement.
- **Input-arrival priority (Dim 3) is out of scope** — it is uniquely React's;
  Solid and Svelte both punt on it (per the research), so it is not a meaningful
  "pulse falls short" demonstration.
- **Four new dedicated tabs**, alongside FM1–FM4. The tab bar splits into two
  labelled groups: "the four failure modes" and "edge cases — where it falls
  short". 8 tabs total. The existing FM tabs are untouched.
- **Idiomatic pulse; Playwright tests as the oracle** — each edge-case tab uses
  pulse the recommended way; its spec asserts the correct behavior; all four are
  expected red.
- The approach reuses Approach A of the original example — the shared kernel and
  the `TabFrame` pattern — with one small kernel addition. No new architecture.

## Structure

Four new tab files in `examples/transitions/src/tabs/`:

- `stale-side-effects.tsx` (E1)
- `torn-across-boundaries.tsx` (E2)
- `optimistic-rollback.tsx` (E3)
- `entanglement.tsx` (E4)

Each follows the established tab pattern: a `createEventLog()`, one or more
`latencyKnob`s, `mockFetch` for async work, and a returned `<TabFrame>` carrying
`title` / `quality` / `actual` prose, the scenario JSX, a `<LatencyControls>`,
and an `<EventTimeline>`. The `[data-gen]` colour-coding scheme (stale/superseded
vs fresh/committed) is kept.

### `src/main.tsx` changes

Each `TABS` entry gains a `group: 'failure-mode' | 'edge-case'` field. The tab
bar renders two labelled groups in order — "the four failure modes" (FM1–FM4)
then "edge cases — where it falls short" (E1–E4). Four new `<Show>` blocks route
the new tabs, exactly as the existing four do (each tab remounts on switch).

### Kernel change

One small addition to `src/kernel/mock-async.ts`: `MockFetchOptions` gains an
optional `fail?: boolean`. When `fail` is true, `mockFetch` rejects (after the
latency delay) instead of resolving — E3 needs a failing server. The `resolve`
event emitted on settle should indicate the rejection (e.g. label `"<name>
(rejected)"`). `event-log.tsx`, `latency-controls.tsx`, and `tab-frame.tsx` are
reused unchanged.

## The four edge-case tabs

### E1 — Stale side effects (`stale-side-effects.tsx`)

A "save" scenario. A `sideEffectsRan` counter signal. The async work's `produce()`
callback increments that counter — its side effect. A `version` signal keys the
`save` derivation. The user clicks "save" twice in quick succession; the second
supersedes the first.

pulse discards the first result's *value* (the `suspendedOn !== p` guard in
`computed.ts`), but **both `produce()` callbacks run to completion** — the
superseded fetch is never cancelled — so `sideEffectsRan` ends at 2. The tab
displays the committed result and the "side effects executed" counter; the
discrepancy (1 committed, 2 executed) is the visualization.

- **Quality:** a superseded in-flight change should be cancellable — its work,
  and any side effects, should not land.
- **Fails:** the spec triggers a save, supersedes it, and asserts
  `sideEffectsRan === 1`. It is 2 — pulse has no cancellation.

### E2 — Torn across boundaries (`torn-across-boundaries.tsx`)

A realistic two-region layout: a **header** `<Loading>` boundary and a **body**
`<Loading>` boundary — both idiomatic, each correctly gathering its own
async-computeds (header: one derivation; body: two). A single `navigate()`
(alice → bob) drives async work in both boundaries. Header latency is set lower
than body latency.

Each boundary commits atomically *on its own* — FM1's guarantee holds inside
each — but the two boundaries commit **independently of each other**: the header
flips to bob while the body still holds alice. The page is torn *across* the
boundaries.

- **Quality:** one logical change spanning multiple boundaries should commit as a
  whole — the header and body should never show different generations at once.
- **Fails:** the spec runs `navigate()` and polls; the header boundary and body
  boundary show different generations during the window. The gather is
  per-*boundary*, not per-*change* — pulse has no sibling-boundary coordination
  (the `<Reveal>` problem space). Contrasts FM1 (one boundary → atomic) with a
  *correct-usage* scenario that still tears.

### E3 — Optimistic update + rollback (`optimistic-rollback.tsx`)

A like button. A `liked` signal. Clicking optimistically writes `setLiked(want)`,
then `await mockFetch({ fail })`; on rejection it reverts (`setLiked(!want)`). A
"server fails" switch controls `fail`.

The scenario runs the `concurrent-flows.md` S1 race: with the server failing, the
user clicks like, then unlike, while both requests are in flight. The two reverts
interleave and restore stale values, leaving `liked` contradicting the user's
last click.

- **Quality:** committed state must always reflect the user's latest intent;
  optimistic writes and their reverts must not corrupt each other.
- **Fails:** the spec runs the like/unlike race against a failing server and
  asserts the final committed `liked` matches the last click. pulse has no
  scoped-write / overlay primitive, so the rollback is hand-rolled and races.

### E4 — Entanglement (`entanglement.tsx`)

A shared record signal `{ a, b }`. Two buttons: "Action A" sets field `a` after
an await; "Action B" sets field `b` after an await. Each action reads the current
record at resolve time and writes back a spread (`{ ...current, a: newA }`).

Triggered concurrently, both actions capture the same base record; the
later-resolving write clobbers the earlier one, so one field's update is **lost**
(a lost update).

- **Quality:** two concurrent changes to disjoint fields of shared state must
  both survive — the engine should detect the overlap (entanglement) or otherwise
  prevent the lost update.
- **Fails:** the spec triggers A and B concurrently and asserts the final record
  carries *both* updates. One is lost — pulse has strict last-write-wins on
  shared state, no entanglement (Dim 4).

## Tests & the living-spec framing

One Playwright spec per new tab, each asserting the **correct** behavior — all
four expected red:

- `stale-side-effects.spec.ts` — after a superseded save, the side-effect counter
  is `1`, not `2`.
- `torn-across-boundaries.spec.ts` — during `navigate()`, the header and body
  boundaries never show different generations simultaneously.
- `optimistic-rollback.spec.ts` — after the like/unlike race against a failing
  server, committed `liked` matches the last click.
- `entanglement.spec.ts` — after concurrent Action A + Action B, the final record
  carries both updates.

Full-suite outcome becomes **3 green / 5 red** — FM1/FM3/FM4 green; FM2 + E1–E4
red. The existing `playwright.config.ts` (`workers: 1`, serial) already covers 8
specs.

`README.md` gains an **"edge cases"** section listing E1–E4 (each: the quality,
and what pulse does today) and the run note updates to the new 3-green/5-red
tally. The framing: the failure-mode tabs show pulse mostly holds up for
single-derivation scenarios; the edge-case tabs show where it genuinely falls
short — the unbuilt transition surface from `pulse-design-direction.md`.

## Out of scope

- **Input-arrival priority (Dim 3).** React-only; not a meaningful pulse gap.
- **Fixing any of the gaps in pulse itself.** This is a demonstration; the red
  specs are living regression specs.
- **Changes to the existing FM1–FM4 tabs.** They stay as built.
- **New kernel modules.** Only the one `fail?: boolean` option on `mockFetch`.

## References

- [`docs/superpowers/specs/2026-05-20-transitions-example-design.md`](./2026-05-20-transitions-example-design.md)
  — the original four-tab example this extends.
- [`docs/research/async/transitions-problem-space.md`](../../research/async/transitions-problem-space.md)
  — the four failure modes.
- [`docs/research/async/pulse-design-direction.md`](../../research/async/pulse-design-direction.md)
  — the unbuilt transition surface the edge cases demonstrate.
- [`docs/scenarios/concurrent-flows.md`](../../scenarios/concurrent-flows.md) —
  scenarios S1 (E3) and S5 (E4).
- `src/computed.ts` — the `suspendedOn !== p` stale-discard guard E1 exercises.
