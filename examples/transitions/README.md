# transitions — visualizing the four failure modes

An interactive example that demonstrates the four async-transition failure
modes from `docs/research/async/transitions-problem-space.md`. Each tab is a
small scenario built with **idiomatic pulse**; it shows pulse's *actual*
behavior today. Each tab's Playwright spec asserts the *correct* transition
behavior — the spec is the oracle for what pulse does.

- **FM1 · torn state** — handled. The `<Loading>` gather commits the three
  fetches atomically; the card never shows mixed generations. **Test green.**
- **FM2 · spinner flash** — fails. `<Loading>`'s "has ever loaded" state is
  per-boundary, so a boundary remounted while its data is in flight wrongly
  flashes the fallback. **Test red** — the one genuine failure.
- **FM3 · lost interactivity** — handled in this scenario. With the input kept
  outside the boundary and pulse discarding stale async results by promise
  identity, the typeahead stays focused and never shows a stale query.
  **Test green.**
- **FM4 · uncommittable speculation** — handled in this scenario. A superseded
  fetch's value is discarded by promise identity, so a rapid toggle never
  commits the abandoned generation. **Test green.** Note: pulse discards the
  superseded *value* only — it does not cancel the in-flight work or its side
  effects, and has no scoped multi-signal commit; see
  `docs/research/async/pulse-design-direction.md`.

Each tab has live latency sliders and an event timeline so the timing-sensitive
behavior is observable and reproducible.

## Run

    pnpm dev      # http://localhost:5182
    pnpm test     # Playwright — FM1/FM3/FM4 green, FM2 red (intentional)

FM2 is a **living regression spec**: it turns green when pulse fixes the
per-boundary `hasEverLoaded` bug. FM1/FM3/FM4 passing reflects what pulse's
current `<Loading>` + async-computed machinery already handles for these
single-derivation scenarios.
