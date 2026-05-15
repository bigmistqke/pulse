# r3 exports `unwatched` as pulse's disposal primitive

pulse needs to dispose effects when their owning scope is cleaned up. r3's
existing automatic disposal — `unwatched`, fired internally when a computed
loses its last sub — does the right work (unlink from deps, run `onCleanup`,
remove from dirty heap), but it never fires for effects, because effects are
leaves with no subs by construction.

r3 will **export `unwatched`** (a one-keyword change to r3: `function` →
`export function`). pulse's `dispose(node)` is then a thin re-export. pulse
calls it on each owned r3 node when an `Owner` is disposed.

### Considered alternatives

- **"Killed flag" hack in pulse.** Each pulse-created r3 node carries a
  `disposed` boolean; the wrapper r3 fn no-ops if set. Rejected: the r3 node
  stays in r3's graph forever (memory leak — the node remains subscribed to
  its deps, runs on every dep change just to no-op, never GC'd). Functionally
  disposable but not actually freed.
- **pulse re-implements `unwatched` against r3's internal data structures.**
  Rejected: pulse manipulating `subs` / `deps` / `nextDep` directly couples
  pulse to r3 internals far more tightly than one named export does. r3
  internals shift → pulse breaks silently.
- **r3 grows an `Owner` / `createRoot` concept of its own** that pulse builds
  on. Rejected for scope: that is a much larger r3 API surface change for one
  feature pulse needs. Keeping ownership in pulse, with r3 providing only the
  disposal primitive, is a clean layering.

### Consequences

- r3's public surface gains one function. It is already in good company —
  r3 exports several "implementation-y" things (`ReactiveFlags`,
  `increaseHeapSize`, `getContext`, `Link`). `unwatched` may be marked in its
  JSDoc as "framework-author API, not for application code" to make the
  intended audience explicit.
- pulse documents one caveat: **don't dispose a node whose downstream subs
  aren't also being disposed.** Calling `unwatched(node)` while another (live)
  consumer holds `node` in its `deps` list leaves that consumer with a
  dangling reference to a non-recomputing node — stale reads. This is user
  discipline; pulse's `Owner` design avoids the issue by default (an owner
  disposes its own tree top-down/bottom-up coherently).
- The name "unwatched" reads as a past-tense state rather than an imperative
  verb. pulse re-exports it internally as `dispose` for clarity; r3's name
  stays as-is.

### Relationship to ADR 0003

ADR 0003 chose per-stage r3 computeds (and effects-as-leaf-computeds) as
pulse's wrapper architecture. That choice creates the disposal need: a leaf
effect with no subs is exactly the case r3's automatic `unwatched` cannot
handle on its own. This ADR records the matching r3 change that lets the
ADR 0003 architecture clean up after itself.
