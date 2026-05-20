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

Each edge-case tab uses pulse **correctly** (not naive throwaway code) and
exercises a genuine limitation — it probes pulse's machinery, not our own mock or
our own naive code. Each ships a Playwright spec asserting the correct behavior;
E2/E3/E4 are expected **red** — living regression specs that turn green when
pulse gains the corresponding capability — and E1 is an oracle whose outcome
probes whether pulse cancels superseded work.

## Scope decisions

Settled during brainstorming:

- **Four edge cases**, one tab each: E1 superseded-work cancellation, E2 torn
  across boundaries, E3 optimistic value clobbered by refetch, E4 entanglement.
- **Input-arrival priority (Dim 3) is out of scope** — it is uniquely React's;
  Solid and Svelte both punt on it (per the research), so it is not a meaningful
  "pulse falls short" demonstration.
- **Four new dedicated tabs**, alongside FM1–FM4. The tab bar splits into two
  labelled groups: "the four failure modes" and "edge cases — where it falls
  short". 8 tabs total. The existing FM tabs are untouched.
- **Idiomatic pulse; Playwright tests as the oracle** — each edge-case tab uses
  pulse the recommended way; its spec asserts the correct behavior. E2/E3/E4 are
  expected red; E1 is a genuine oracle (its outcome depends on whether pulse
  cancels superseded work, which is not known up front).
- The approach reuses Approach A of the original example — the shared kernel and
  the `TabFrame` pattern — with one small kernel addition. No new architecture.

## Structure

Four new tab files in `examples/transitions/src/tabs/`:

- `stale-side-effects.tsx` (E1)
- `torn-across-boundaries.tsx` (E2)
- `optimistic-clobbered.tsx` (E3)
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

One addition to `src/kernel/mock-async.ts`: `MockFetchOptions` gains an optional
`signal?: AbortSignal`. When the signal aborts before the latency timer fires,
`mockFetch` skips `produce()`, emits a `resolve` event labelled `"<name>
(cancelled)"`, and rejects with an abort reason (`produce` must not run). This
lets E1 test whether superseded work can be cancelled. `event-log.tsx`,
`latency-controls.tsx`, and `tab-frame.tsx` are reused unchanged.

## The four edge-case tabs

### E1 — Stale side effects (`stale-side-effects.tsx`)

A "save" scenario that genuinely probes pulse: when a computed run is superseded,
can it cancel its in-flight work?

The `save` derivation is `computed(() => { … })` keyed on a `version` signal.
Inside the computed body it creates an `AbortController`, registers
`onCleanup(() => controller.abort())`, and calls `mockFetch({ signal:
controller.signal, … })`. `mockFetch`'s `produce()` increments a
`sideEffectsRan` counter — the observable side effect — but runs only if the
signal has not aborted.

The user clicks "save" twice in quick succession; the second bumps `version`, so
the computed re-runs. **The open question is whether pulse runs the previous
run's `onCleanup` when the computed re-runs** (superseding it), or only on owner
disposal (unmount). If `onCleanup` fires on re-run, the first `AbortController`
aborts, `produce()` is skipped, and `sideEffectsRan` stays at 1. If it fires only
on unmount, the superseded fetch runs to completion and the counter reaches 2.
The tab displays the committed result and the side-effect counter.

This probes pulse's machinery — not the mock. The earlier-rejected version of
this tab merely counted how often our own `mockFetch` called `produce()`, which
is guaranteed by the mock; this version asks a real, unknown question about
pulse's cleanup lifecycle.

- **Quality:** when a computed run is superseded, its in-flight work should be
  cancellable — `onCleanup` should fire on re-run so a wired `AbortController`
  can abort it.
- **Test (oracle):** trigger a save, supersede it, assert `sideEffectsRan === 1`.
  Whether pulse passes depends on whether `onCleanup` fires on computed re-run —
  genuinely unknown up front; the test is the oracle.

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

### E3 — Optimistic value clobbered by refetch (`optimistic-clobbered.tsx`)

A comment list. A `comments` signal holds the committed list. A "refresh" button
re-fetches the canonical list from the server (`mockFetch`). An "add comment"
button performs an optimistic insert: it writes the new comment into `comments`
immediately, then awaits the server and replaces the optimistic entry with the
saved one.

The scenario runs `concurrent-flows.md` S7: the user adds a comment (the
optimistic entry is now in `comments`), and *before the add's server response
arrives* a refresh lands. The refresh's result is the canonical server list —
which does not contain the not-yet-saved optimistic entry — so it overwrites
`comments` and the optimistic comment **vanishes**, then reappears when the add's
server response arrives. A visible flicker.

This is a genuine capability gap, not an ergonomics one: the optimistic overlay
and the committed truth share **one signal cell**. The refresh is a legitimate
write of canonical data; no functional updater can fix it, because the refresh
genuinely does not know an optimistic overlay exists. Distinguishing the two
requires a scoped / overlay write, which pulse does not have.

- **Quality:** an optimistic write must survive a refetch of the underlying data
  — the refetch sets committed truth; the optimistic entry stays as an overlay on
  top until its own request settles.
- **Fails:** the spec adds a comment, triggers a refresh while the add is in
  flight, and asserts the optimistic comment stays visible throughout. It
  vanishes when the refresh commits.

### E4 — Entanglement (`entanglement.tsx`)

Two profile fields: a `displayName` signal and a `bio` signal. Two actions:

- **Action A — "update bio":** reads `displayName` *now*, captures it, awaits a
  server round-trip, then writes `bio` to a value derived from the captured name
  (e.g. `"bio for " + capturedName`).
- **Action B — "rename":** awaits a server round-trip, then writes `displayName`
  to a new value.

The scenario runs `concurrent-flows.md` S5: the user triggers Action A, then
triggers Action B while A is still in flight. A captured the old `displayName`;
B commits the new `displayName`; A then commits a `bio` that embeds the **old**
name. Final committed state: a new display name with a bio that references the
previous one — incoherent.

This is the genuine entanglement gap, and no functional updater fixes it: the
staleness is baked into A's *captured async input*, not its write. The only
remedies are entanglement (A re-runs, or blocks, when `displayName` — which it
read — is changed by B) or conflict detection at commit. pulse has neither
(Dim 4).

- **Quality:** if one in-flight action read a value that another action then
  changed, the committed result must stay coherent — the reader should re-run,
  block, or be flagged.
- **Fails:** the spec triggers A, then B mid-flight, and asserts the final `bio`
  references the current `displayName`. It references the stale one.

## Tests & the living-spec framing

One Playwright spec per new tab, each asserting the **correct** behavior — all
four expected red:

- `stale-side-effects.spec.ts` — after a superseded save, the side-effect counter
  is `1` (the superseded fetch was cancelled). **Oracle** — passes only if pulse
  fires `onCleanup` on computed re-run.
- `torn-across-boundaries.spec.ts` — during `navigate()`, the header and body
  boundaries never show different generations simultaneously.
- `optimistic-clobbered.spec.ts` — an optimistic comment stays visible when a
  refetch of the list lands before the add's server response.
- `entanglement.spec.ts` — after Action A then Action B mid-flight, the final
  `bio` references the current `displayName`.

Full-suite outcome is expected to be **3 green / 5 red** — FM1/FM3/FM4 green;
FM2 + E2/E3/E4 red. E1 is an oracle: if pulse fires `onCleanup` on computed
re-run it lands green (making the suite 4 green / 4 red). The existing
`playwright.config.ts` (`workers: 1`, serial) already covers 8 specs.

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
- **New kernel modules.** Only the one `signal?: AbortSignal` option on
  `mockFetch`.

## References

- [`docs/superpowers/specs/2026-05-20-transitions-example-design.md`](./2026-05-20-transitions-example-design.md)
  — the original four-tab example this extends.
- [`docs/research/async/transitions-problem-space.md`](../../research/async/transitions-problem-space.md)
  — the four failure modes.
- [`docs/research/async/pulse-design-direction.md`](../../research/async/pulse-design-direction.md)
  — the unbuilt transition surface the edge cases demonstrate.
- [`docs/scenarios/concurrent-flows.md`](../../scenarios/concurrent-flows.md) —
  scenarios S7 (E3) and S5 (E4).
- `src/computed.ts` — the `suspendedOn !== p` stale-discard guard E1 exercises.
