# transitions — failure modes & edge cases

An interactive example demonstrating async-transition behavior in pulse. Each
tab is a small scenario built with **idiomatic pulse**; it shows pulse's
*actual* behavior today. Each tab's Playwright spec asserts the *correct*
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

Scenarios that use pulse correctly and probe a genuine gap:

- **E1 · stale side effects** — does a superseded `computed` run cancel its
  in-flight work? Wires an `AbortController` + `onCleanup`. **Test green** —
  pulse fires `onCleanup` when a computed re-runs, so the superseded fetch is
  aborted.
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
    pnpm test     # Playwright — 4 green, 4 red

The red specs (FM2, E2, E3, E4) are a **living regression spec** — they turn
green when pulse gains the corresponding transition capability. See
`docs/research/async/pulse-design-direction.md` for the unbuilt transition
surface these edge cases probe.
