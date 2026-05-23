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

## Edge cases

Scenarios that use pulse correctly. E1 and E4 are handled; E2 and E3 probe a gap:

- **E1 · stale side effects** — does a superseded `computed` run cancel its
  in-flight work? Wires an `AbortController` + `onCleanup`. **Test green** —
  pulse fires `onCleanup` when a computed re-runs, so the superseded fetch is
  aborted.
- **E2 · torn across boundaries** — two sibling `<Loading>` boundaries each
  gather correctly but commit independently, so one logical change tears across
  them. The gather is per-boundary, not per-change. **Test red.**
- **E3 · optimistic clobbered** — an optimistic insert and committed truth share
  one signal cell, so a refetch overwrites the optimistic entry. Solvable today
  in userland — hold the overlay in its own signal and merge it with committed
  truth via a `computed`; the gap is an _ergonomic_ optimistic primitive, not a
  missing capability. **Test red** (the naive single-cell version shown here).
- **E4 · entanglement** — an action that embeds another value into its result
  reads that value at write time (after the await), not at capture time — so a
  concurrent rename mid-flight is reflected in the committed bio, not lost.
  **Test green.**

Each tab has live latency sliders and an event timeline so the timing-sensitive
behavior is observable and reproducible.

## Run

    pnpm dev      # http://localhost:5182
    pnpm test     # Playwright — 5 green, 3 red

The red specs are a **living regression spec**. FM2 and E2 are genuine
capability gaps — they turn green when pulse gains the corresponding transition
machinery (per-instance hold-prior; a commit boundary that spans the whole
transition, not a single `<Loading>`). E3 is an _ergonomic_ gap — solvable in
userland today, awaiting a first-class optimistic primitive. See
`docs/async/pulse-design-direction.md` for the unbuilt transition
surface these probe.

## Idiom note

Handlers derive the next value with a functional updater — `setX(x => …)` —
never `setX(x() + 1)`. A write that feeds an async `computed` is part of a
transition; reading the signal back before that transition commits would return
the pre-transition value. The functional updater always sees the latest. This
is what the Solid port of this example surfaced: read-modify-write handlers
broke under real transition semantics.
