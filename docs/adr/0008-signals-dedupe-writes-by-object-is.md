# Signals dedupe writes by Object.is

A write whose new value is `Object.is`-equal to the signal's current value is
a no-op: no propagation to consumers, no `writeSet` entry inside an action, no
version bump. Overridable per-signal via `signal(value, { equals })` — a custom
`(a, b) => boolean`, or `equals: false` to always notify. This matches the
fine-grained-reactive convention; Solid, Vue, Preact, and MobX all dedupe at
the signal boundary.

`Object.is` rather than raw `===` is deliberate. `===` treats `NaN !== NaN`,
so a `NaN`-valued signal re-written to `NaN` would fire on every write — and
under `onConflict: 'reject'` (Q15) it would bump the node's version and raise a
spurious conflict forever. `Object.is(NaN, NaN)` is `true`, so it is deduped;
`Object.is` also distinguishes `-0` from `+0`. Vue and MobX default to
`Object.is` for exactly this reason.

`Object.is` applies to objects too, rather than Svelte's `safe_not_equal`
stance of always firing for objects and functions. The reason is uniformity:
one rule — dedupe iff `Object.is` — for every value type, rather than a
type-dependent asymmetry ("primitives dedupe, objects don't") that is itself
surprising and cuts against pulse's "everything is the same primitive" framing.

## Consequences

- **In-place object mutation with the same reference is deduped and will not
  update.** pulse expects immutable updates (a new reference when the value
  changes); `equals: false` is the per-signal escape hatch for deliberate
  mutate-in-place signals. This is the well-known Solid/React footgun, kept
  because the immutable-update convention is standard in this ecosystem and the
  escape hatch is clean.
- **`onConflict: 'reject'` conflict detection inherits change-detection for
  free.** The per-node version counter bumps only on *accepted* writes, so a
  no-op write cannot cause a spurious conflict. "Reject on write-race" thereby
  means "reject on a change under the signal's own equality" — no separate
  equality is defined for conflict detection. See
  [`../pulse/concurrent-divergence.md`](../pulse/concurrent-divergence.md) and
  the [D1 trace](../pulse/scenario-traces.md#d1--read-dependent-write-under-reject).
