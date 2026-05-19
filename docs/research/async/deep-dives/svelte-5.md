# Svelte 5 — async derivations and the minimum-transitional-behavior bet

**Type:** primary
**Date:** 2026-05-19
**Session:** 12
**Scope note:** Maps Svelte 5's `await` inside `$derived`, `{#await}` blocks, `<svelte:boundary>`, and the post-5.42 `fork()` API against the four branching dimensions of transitions (cross-cutting framing in [LOG.md](../LOG.md)). Hypothesis under test: "Svelte handles Dim 1 (commit-together) but punts Dims 2/3/4." **Spoiler — partially false.** Svelte handles Dim 2 (concurrent transitions, by *merging*) with substantial machinery; explicitly punts Dim 3 (no priority/cancellation on input arrival); handles Dim 4 by source-set intersection and rebasing rather than union-find lane merge. Conducted using the parallel-passes-then-merge methodology (sixth dive on the pattern). The merged document below uses the fresh pass as its spine; main-session contributions are flagged at points of merge.

## Sources

Read directly from `github.com/sveltejs/svelte@main`:

- `packages/svelte/src/internal/client/reactivity/async.js` (URL: <https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/reactivity/async.js>) — `flatten`, `capture`, `save`, `run`, `increment_pending`. The compile target for `await` expressions.
- `packages/svelte/src/internal/client/reactivity/deriveds.js` (URL: <https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/reactivity/deriveds.js>) — `derived`, `async_derived`, `update_derived`. Contains the core async-derived state machine including the `OBSOLETE` symbol and the `deferreds` set.
- `packages/svelte/src/internal/client/reactivity/batch.js` (URL: <https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/reactivity/batch.js>) — the `Batch` class (linked list, `#commit`, `#merge`, `#find_earlier_batch`, `apply()`, `batch_values` for time-travel), `flushSync`, `fork`.
- `packages/svelte/src/internal/client/dom/blocks/boundary.js` (URL: <https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/dom/blocks/boundary.js>) — `<svelte:boundary>` runtime, `is_rendered`, pending/offscreen fragment swap.
- `packages/svelte/src/index-client.js` — re-exports for `fork`, `flushSync`, `tick`, `settled`.
- Docs (canonical, `svelte.dev`):
  - `documentation/docs/02-runes/03-$derived.md` (handles `await` directly: "if an expression contains an `await`, Svelte transforms it such that any state _after_ the `await` is also tracked")
  - `documentation/docs/02-runes/04-$effect.md` (`$effect.pending()` semantics)
  - `documentation/docs/03-template-syntax/05-await.md` (`{#await}` template block)
  - `documentation/docs/03-template-syntax/19-await-expressions.md` (the "experimental.async" feature; `fork`, `settled`, synchronized updates, concurrency, SSR)
- Re-exports / public API: `flushSync`, `fork` from `'svelte'`; `tick`, `untrack`, `settled` from runtime. `fork` is documented in the API since `5.42`.

Not consulted as authoritative: I deliberately avoided community blogs. I did not find a single Rich-Harris-bylined essay specifically on async derivations; what canonical material exists lives in the docs file `19-await-expressions.md` and the in-source comments quoted below. (Open question: there may be a SvelteSummit 2024/2025 talk and Discord transcripts; not searched here.) The lack of a single flagship blog post for this feature is itself notable — see *Notes*.

## Svelte 5 architecture in brief

Svelte 5 is signals-shaped under the hood but presented through "runes" — `$state`, `$derived`, `$effect`, `$props`, `$bindable`, `$inspect`, `$host`. The compiler reads these as pseudo-keywords and lowers them into calls into `packages/svelte/src/internal/client/reactivity/*`.

The reactive substrate (`reactivity/types.d.ts`, `runtime.js`):

- **`Source`** — a writable signal cell. Carries `v` (value), `wv` (write version, monotonic uint), `reactions` (downstream), and flag bits.
- **`Derived`** — a pull-style memoised computation. Has `deps`, `fn`, `v`, `equals`. Flag bits include `DERIVED | DIRTY | ASYNC | WAS_MARKED | ERROR_VALUE`.
- **`Effect`** — push side. Re-runs when dirty. Effects carry a parent pointer (`parent`), a boundary pointer (`b`), an `AbortController` (`ac`), and the `BLOCK_EFFECT | BRANCH_EFFECT | ROOT_EFFECT | ASYNC | EFFECT_PRESERVED | INERT | DESTROYED` flag set.
- **Update propagation** is described as "push-pull" in the docs (`$derived.md`): writes immediately mark downstream as dirty; reads on derived values do the actual recomputation.

Two batching primitives sit above this:

1. **`Batch` (`batch.js`)** — a linked list of all in-flight batches, threaded via `#prev`/`#next`, with a globally-tracked `first_batch`, `last_batch`, `current_batch`. Each batch owns `current: Map<Value, [any, boolean]>` (its proposed values), `previous: Map<Value, any>` (the snapshot before), `async_deriveds: Map<Effect, Deferred>`, plus dirty/maybe-dirty/skipped-branches sets and commit callbacks. Multiple batches coexist; the comment on `apply()` calls this "time travelling".
2. **`Boundary` (`dom/blocks/boundary.js`)** — the `<svelte:boundary>` block. Hosts `pending` / `failed` snippets and tracks `#pending_count`. When pending > 0 and the boundary has never been rendered, content is rendered into an *offscreen `DocumentFragment`*, and only swapped into the document when pending hits 0.

Async support is gated behind a compiler flag — `experimental.async` (introduced 5.36, per `19-await-expressions.md`: "This feature is currently experimental, and you must opt in… The experimental flag will be removed in Svelte 6"). The `async_mode_flag` symbol in `flags/index.js` (referenced throughout `batch.js`) selects between sync and async semantics — for example in `batch.js` `#process`:

```js
if (async_mode_flag && !this.linked) {
  this.#commit();
}
```

— meaning that the elaborate time-travel/rebase machinery described below only runs in async mode. In sync mode Svelte 5 still works like Svelte 5 pre-5.36: one immediate batch per microtask.

## `$derived(async)` semantics

The compiler lowers a `$derived` whose expression contains `await` into a call to `async_derived(fn)` (deriveds.js:97). The returned object is, surprisingly, **not** a `Derived` — it's a regular **`Source`** that gets *written to* every time the async fn resolves. `async_derived` itself returns a `Promise<Source<V>>`, but the compiler-emitted code only awaits that promise at the boundary level — once the source exists, reads go through normal signal `get()`.

The core machine (`deriveds.js:97–256`):

```js
export function async_derived(fn, label, location) {
  let parent = active_effect;
  if (parent === null) e.async_derived_orphan();

  var promise;
  var signal = source(UNINITIALIZED);
  var should_suspend = !active_reaction;
  var deferreds = new Set();

  async_effect(() => {
    var effect = active_effect;
    var d = deferred();
    promise = d.promise;

    Promise.resolve(fn())
      .then(d.resolve, (e) => {
        if (e !== STALE_REACTION) d.reject(e);
      })
      .finally(unset_context);

    var batch = current_batch;

    if (should_suspend) {
      if ((effect.f & REACTION_RAN) !== 0) {
        var decrement_pending = increment_pending();
      }

      if (parent.b.is_rendered()) {
        batch.async_deriveds.get(effect)?.reject(OBSOLETE);
      } else {
        for (const d of deferreds.values()) d.reject(OBSOLETE);
      }

      deferreds.add(d);
      batch.async_deriveds.set(effect, d);
    }

    const handler = (value, error = undefined) => {
      decrement_pending?.();
      deferreds.delete(d);
      if (error === OBSOLETE) return;
      batch.activate();
      // ... write to signal
      internal_set(signal, value);
      batch.deactivate();
    };

    d.promise.then(handler, (e) => handler(null, e || 'unknown'));
  });
}
```

Observed semantics:

1. **The "value" is just a source.** Before resolution the signal sits at the sentinel `UNINITIALIZED`. Any code that reads a `$derived(async ...)` *before* the first resolution is suspended at the boundary level (see next section) — it never sees `undefined` at the user level.
2. **`OBSOLETE` is the cancellation signal.** When dependencies change while an async-derived is still pending, a new run starts; older in-flight deferreds are explicitly rejected with `OBSOLETE`. Two branches:
   - If the boundary *has* been rendered already (`parent.b.is_rendered()`), only the *single most-recent* in-flight run per effect is tracked (`batch.async_deriveds.get(effect)?.reject(OBSOLETE)`), so updates can overlap. The docs spell this out: "Updates can overlap — a fast update will be reflected in the UI while an earlier slow update is still ongoing."
   - If the boundary is still showing pending (initial render), *all* prior in-flight runs are cancelled (`for (const d of deferreds.values()) d.reject(OBSOLETE)`). The in-source comment reads: "While the boundary is still showing pending, a new run supersedes all older in-flight runs for this async expression. Cancel eagerly so resolution cannot commit stale values."
3. **`STALE_REACTION` is a separate mechanism.** From `async.js#run`, a thrown `STALE_REACTION` is what `aborted(active)` produces — used when the parent effect has been aborted (e.g. via `getAbortSignal` exposed on `$state` reads). The body promise rejecting with `STALE_REACTION` is *swallowed*; no `d.reject` is called, so the next resolution still has a chance to commit.
4. **Errors funnel to the source via `ERROR_VALUE` flag.** `signal.f |= ERROR_VALUE` and `internal_set(signal, error)`. When `get()` later reads a source with the error flag set, runtime.js throws — and that throw propagates to the nearest `<svelte:boundary>` with a `failed` snippet (or up the boundary chain).
5. **The "track-state-after-await" property** advertised in `$derived.md` is implemented by `capture()` and `save()` in `async.js`. The compiler transforms `await a + b` into roughly `(await $.save(a))() + b` (verbatim source comment in `async.js`). `save` snapshots `active_effect, active_reaction, component_context, current_batch` *before* the await suspends and restores them on resume — so reads after the await still register as dependencies of the same reaction.

The crucial design choice: **async deriveds do not have their own "pending" / "ready" state surface to user code**. User code that depends on a pending async derived simply blocks at the boundary level. There is no `derived.state === "pending"` API analogous to React's `use()` throw-suspension or Solid's `resource.loading`. The signal is either uninitialized (gated by the boundary) or has a value.

## `{#await}` blocks

`{#await promise then value catch error}` is the older Svelte 3/4 templating-side async (`05-await.md`). Three render branches over a Promise's three states. Three properties of note relative to the runes story:

- The implementation is anomalous enough that a TODO in `async.js#capture` says: *"we only need optional chaining here because `{#await ...}` blocks are anomalous. Once we retire them we can get rid of it"* — suggesting `{#await}` predates the unified machinery and may be deprecated when async-mode stabilizes.
- During SSR, only the pending branch renders (`05-await.md`). Compare to `<svelte:boundary>` in async mode, where SSR awaits and renders the resolved content (`19-await-expressions.md`).
- `{#await}` does not participate in `$effect.pending()` accounting; only `await` expressions and async deriveds increment the boundary's pending count via `increment_pending()` (async.js:309–325).

The likely direction is `{#await}` continues to exist as a way to inspect an arbitrary Promise without making the whole subtree async, while `<svelte:boundary> { #snippet pending }… { /snippet } </svelte:boundary>` becomes the canonical loading-state mechanism.

## Transitional commit behavior

This is the heart of the dive. The hypothesis: "Svelte commits async derivations together in some way." Verified — but the mechanism is more interesting than a single `Promise.all`.

### Layer 1: the boundary holds initial render

When a `<svelte:boundary>` first renders, `Boundary.#render` (boundary.js:209–230) runs the children effect synchronously, which calls `increment_pending()` for each `await` it discovers. If `#pending_count > 0` after that synchronous pass:

```js
this.#main_effect = branch(() => { this.#children(this.#anchor); });

if (this.#pending_count > 0) {
  var fragment = (this.#offscreen_fragment = document.createDocumentFragment());
  move_effect(this.#main_effect, fragment);
  const pending = this.#props.pending;
  this.#pending_effect = branch(() => pending(this.#anchor));
} else {
  this.#resolve(current_batch);
}
```

The actual content effect is moved into an off-document `DocumentFragment` (so DOM nodes exist and effects keep running) while `pending` renders into the document. When `#pending_count` drops to 0, `#anchor.before(fragment)` swaps it in, the pending snippet is paused, and `#resolve()` is called — which transfers any deferred effects to the batch (`boundary.js#transfer_effects` -> `batch.transfer_effects`).

**This is the "gather-on-boundary" pattern, structurally identical to React `<Suspense>`** at the user-facing level. The boundary is a barrier; nothing inside it commits to the DOM until everything inside has resolved at least once.

### Layer 2: batches gather subsequent updates

After the initial render, the boundary is *rendered* (`is_rendered() === true`); further updates go through the `Batch` machinery rather than the boundary's offscreen fragment.

The pattern (batch.js `#process`):

1. A `Batch` is created lazily on the first state write (`Batch.ensure()`); a microtask is queued for `batch.flush()`.
2. `#process` traverses the effect tree and either runs effects or stashes them in `#dirty_effects`/`#maybe_dirty_effects` if the batch is "deferred" (i.e., still has pending async work). The check is `#is_deferred()`:

   ```js
   #is_deferred() {
     if (this.is_fork) return true;
     for (const effect of this.#blocking_pending.keys()) {
       // walk parent chain; if all ancestors are in #skipped_branches, it's not blocking
       // otherwise the batch is deferred
     }
   }
   ```

3. If `#is_deferred()`, the batch defers all dirty effects via `#defer_effects` and returns. Async work continues in the background; when its `decrement_pending()` fires and the count hits zero, the deferred microtask in `decrement()` calls `flush()` and `#process` runs again.
4. If not deferred (all async work has settled), the batch commits: `#commit_callbacks` run (these are what attach/detach DOM branches from `{#if}`, `{#each}`, etc.), then `flush_queued_effects(render_effects)` and `flush_queued_effects(effects)` run the actual DOM updates.

The user-visible promise of this is in `19-await-expressions.md`:

> When an `await` expression depends on a particular piece of state, changes to that state will not be reflected in the UI until the asynchronous work has completed, so that the UI is not left in an inconsistent state.

Verified — this is enforced by deferring *all* DOM-affecting effects in the batch until the blockers settle, then committing them together. This is genuinely a transitional commit: DOM goes from old-coherent to new-coherent with no inconsistent intermediate.

### Layer 3: multiple concurrent batches

This is where Svelte differs from React's lane model and Solid 2.x's union-find merge. Multiple `Batch` objects can exist simultaneously (they live in a doubly-linked list `first_batch ↔ … ↔ last_batch`). Each new top-level write starts a new batch *if the previous one is still in flight*. This is the docs claim "updates can overlap" — concretely, batch B can be flushed and committed while batch A is still waiting on a slow `await`.

The coordination is in `Batch#apply()` (batch.js:851–897), introduced with the comment *"if there are multiple batches, we are 'time travelling' — we need to override values with the ones in this batch"*. It builds `batch_values: Map<Value, any>` such that, while this batch is active:

- All sources updated in *this* batch are overridden with its values.
- For every *other* unfinished batch, *its* previous values are reapplied unless this batch already touches that source.

The `runtime.js#get` path then consults `batch_values` (via the `update_derived` codepath at deriveds.js:386–408, which writes to `batch_values` instead of `derived.v` when there's an active batch). Each batch sees a *consistent snapshot* — its own writes layered on top, with other batches' writes hidden.

### Layer 4: commit-time rebase and merge

When a batch commits (`#commit`, batch.js:626–741):

1. The committing batch's writes are applied to underlying sources (`source.v = value`, source.js).
2. The committing batch walks *all other* live batches:
   - For sources touched by both, if the other batch is *earlier*, its `current` is updated to match (the comment: *"bring the value up to date"*). If later, the later batch's more-recent value wins.
   - For each other batch, "Re-run async/block effects that depend on distinct values changed in both batches" — async work in batch B that depended on a source committed by batch A is rescheduled with A's value in scope. This is the **rebase**.
   - Async-derived deferreds in the committing batch can be linked to the other batch's deferreds (`deferred.promise.then(d.resolve)`) so the same underlying promise resolves both — duplicate work is avoided.
3. If an earlier batch's writes are entirely subsumed by this committing batch (`others.length === 0` after filtering), it's discarded.

The merge path (`#merge`, batch.js:484–533) handles the case where two batches collide on the *same source*. The earlier (still in-flight) batch absorbs the later one's writes and async-deriveds, the later batch is discarded, and the merged earlier batch re-processes:

```js
this.oncommit(() => batch.discard());
batch.#unlink();
current_batch = this;
this.#process();
```

So Svelte's answer to *"two transitions touched the same state — what happens?"* is: they collapse into a single transition. This is **not** Solid's union-find merge (which is about *lanes* — a per-write speculative copy that joins when sources overlap). Svelte's batches are per-microtask-of-writes, not per-transition; the merge is between adjacent batches in the linked list.

### Layer 5: `fork()` as opt-in speculation

`fork(fn)` (batch.js:1358–1424, since 5.42) is the closest thing Svelte has to a user-level `startTransition`. It creates a `Batch` with `is_fork = true`, runs the synchronous `fn` (which mutates state), then *reverts the underlying sources* and keeps the mutations in the batch's `current` map only:

```js
if (!this.is_fork) {
  source.v = value;  // capture(), batch.js:573
}
```

For a fork, `source.v` is *not* written; the fork accumulates speculative state in `current` and is permanently `#is_deferred() === true` until `.commit()` or `.discard()` is called by user code. Async work kicked off by the fork (e.g. an async-derived recomputing because a source it depends on was forked) runs to completion in the background; on commit, the data is already warm.

The docs example is preloading on hover/focus before a navigation. This is dim-3-shaped behavior (speculation under uncertainty about whether the input will commit) but exposed as an explicit user API — Svelte does not infer it.

## The four branching dimensions

### Dim 1 — Internal branching (tree of dependent async work)

**Handled.** A single transition (one batch) holds the whole tree until everything settles. Two mechanisms collaborate:

- `boundary.#pending_count` for first-render gathering. Every `await` in the subtree calls `increment_pending`, decremented when its promise resolves; only at zero does the offscreen fragment swap in.
- `batch.#blocking_pending` for subsequent updates. `#is_deferred()` returns true if any blocking-pending effect exists outside skipped branches; the whole batch stays deferred until they all decrement.

Dependent work — e.g. `let user = $derived(await fetchUser(id)); let posts = $derived(await fetchPosts(user.id))` — is naturally serial because the second derived's expression awaits a value derived from the first. Each settling resumes the next via standard JS promise chaining; the boundary or batch counter rises and falls as work cascades. The docs example "let a = $derived(await one(x)); let b = $derived(await two(y))" with the `await_waterfall` warning shows Svelte is aware of accidental serialization and warns the user.

### Dim 2 — Concurrent branching (multiple transitions in flight)

**Handled, by linked-list batches + time-travel + merge on overlap.** This is more than the hypothesis allowed for. Specifically:

- Two non-overlapping batches commit independently in the order their async work settles.
- Two overlapping batches (touching same source) merge into the earlier one (`#merge`).
- `batch_values` provides per-batch snapshot isolation while in flight, so the async work in batch A reads a consistent A-world even after batch B writes its sources.
- On commit, the rebase loop re-runs async effects in other batches that depended on the just-committed sources.

This is not lane-based (no priority levels). It's "as many concurrent transitions as the user starts, all racing to commit, with rebase-on-commit if they collide on state". Pulse should note: Svelte 5 *does* run concurrent transitions; the engine has a fixed-cardinality versioned-engine flavor (write-version `wv` on every source plus `batch_values` snapshot map).

### Dim 3 — Input-arrival branching (input arrives during transition)

**Mostly punted.** There is no lane-priority system, no "cancel transition on new input" semantics, no "merge new input into in-flight transition" beyond the same-source merge above. The two relevant mechanisms:

- **`OBSOLETE` cancellation within an async-derived.** When the same async derived's expression re-runs because its sync deps changed, the previous run's deferred is rejected with `OBSOLETE`. This is per-derived, not per-transition. It does *not* abort the underlying fetch — only the deferred is rejected, the promise from `fn()` is allowed to continue and is simply ignored (the `handler` early-returns on `error === OBSOLETE`).
- **`getAbortSignal` + `STALE_REACTION`** (referenced from runtime.js — I didn't read this file, but it's how user code can opt into abort). The user's async function can pull an `AbortSignal` that aborts when the reaction becomes stale; if the user code rejects via that signal, the promise rejects with `STALE_REACTION`, which is swallowed.

So Svelte has *cancellation* (Dim 3a — by-derived OBSOLETE, by-effect STALE_REACTION) but no *prioritization* and no *merging of incoming inputs into a still-pending transition* beyond the batch-merge above.

`fork()` adds an explicit-user-controlled variant: start a speculative batch on intent (hover), commit on confirmation (click), discard on retraction (pointer-leave). But the framework does not start or cancel forks automatically.

### Dim 4 — State-overlap branching (two transitions touching shared state)

**Handled by batch merge, not by lane-style entanglement.** When two batches' `current` maps share a non-derived source key (`#find_earlier_batch`, batch.js:467–483), the later batch on commit triggers `#merge`, which folds it into the earlier in-flight batch. Async-deriveds across the merge are linked deferred-to-deferred so duplicate work is avoided.

The granularity is *whole-batch*. Solid's union-find lanes are *finer* — they entangle per-write across lanes. Svelte's coarse-grained merge is simpler to reason about and probably easier to implement; the trade-off is that two truly-independent transitions that happen to share a single source get unified rather than continuing in parallel. The async docs implicitly accept this: "Updates can overlap" applies to independent state, and the merge logic kicks in when they aren't.

## Taxonomy cells

| Axis | Svelte 5 cell | Evidence |
|---|---|---|
| 1. Where async state lives | In a regular `Source` (signal cell) populated by an effect resolved deferred, gated by a `<svelte:boundary>` or by the `Batch`. No separate "async resource" type. | `async_derived` (deriveds.js:97) creates `var signal = source(UNINITIALIZED)` and writes via `internal_set` from a `handler` callback. |
| 2. Conflict-handling policy | Per-async-derived: cancel-previous-on-rerun (boundary still pending → cancel all in-flight; rendered → cancel only the prior single run, allow overlap). Per-batch: same-source overlap triggers whole-batch merge into earlier. | `deferreds.set` / `OBSOLETE` reject loops in `async_derived`; `#find_earlier_batch` + `#merge` in batch.js. |
| 3. Cancellation discipline | Two channels: `OBSOLETE` (rejection of the deferred, swallowed by handler) and `STALE_REACTION` (when the effect itself is aborted). User code can opt into `getAbortSignal` for cooperative cancellation. No automatic fetch abort otherwise. | `OBSOLETE` symbol, deriveds.js:96; `STALE_REACTION` constant; `aborted(active)` in async.js#run. |
| 4. Async representation | Plain `Promise<V>` returned from the derived expression; awaited internally inside an `async_effect`. No `Resource<T>`, no observable, no `Effect`. | `Promise.resolve(fn()).then(d.resolve, …)` (deriveds.js:128). |
| 5. Isolation level | Per-batch via `batch_values` snapshot + per-batch `current`/`previous` maps. Forks are deeper-isolated (`source.v` not written). | `Batch#apply()` (batch.js:851); fork branch in `capture()` (batch.js:573). |
| 6. Atomicity granularity | Per-`<svelte:boundary>` for first render; per-`Batch` for subsequent updates. Fork is per-explicit-fork. No sub-batch atomic units, no per-derived overlay independent of batches. | `Boundary.#render` offscreen-fragment swap; `Batch.#process` deferral loop; `fork()`. |
| 7. Discipline location | Framework / compiler. The user writes `await` and gets coherence for free; the compiler emits `async_derived`/`flatten`/`save` calls. The only user-visible control is `<svelte:boundary>`, `$effect.pending()`, `settled()`, `fork()`. | `19-await-expressions.md`: "experimental.async" compiler flag; `flatten` in async.js wraps every `await`-containing expression. |
| 8. Reactive integration | Native. `await` participates in dep-tracking via `capture`/`save` (compiler-emitted). Async-derived signal is a normal `Source`; downstream reads use the same `get()` path as sync state. | `save()` in async.js (lines ~118–135); docs explicitly call out post-await dep tracking. |
| 9. Speculative-state isolation | **Versioned engine, fixed cardinality** — and somewhat *unbounded* (any number of concurrent batches in the linked list, each with its own `current`/`previous`/`batch_values` snapshot). Forks are a flagged subtype of the same machinery. Not per-write, not union-find. | `first_batch`/`last_batch` linked list; `batch_values` per-batch; `wv` write-version on every source. |
| 10. Dependent-dispatch capability | **Await-only with implicit ordering.** Two sequential `$derived` declarations each with `await` will be created in source order on first run (`let a = $derived(await one(x)); let b = $derived(await two(y))` — the docs warn this is a waterfall). Independent `await` expressions in markup *do* run concurrently — "both functions will run at the same time, as they are independent expressions". No generator batching, no pipelining. The framework will warn on accidental waterfalls (`await_waterfall`). | `19-await-expressions.md` concurrency section; `recent_async_deriveds` + `await_waterfall` warning in deriveds.js:201–209. |

## Comparison to frameworks studied

**Solid 2.x.** Both are signals-shaped and compile away. Both have an async-derived concept. Differences:
- Solid uses *union-find lanes* for state-overlap (`solid-2x.md` cell on Dim 4). Svelte uses *whole-batch merge* when source-sets intersect. Solid's mechanism is per-write; Svelte's is per-batch.
- Solid exposes `createResource` with explicit `.loading`/`.error`/`.latest`. Svelte deliberately hides this — the only signals user code sees are the resolved value or a thrown error caught by `<svelte:boundary>`. Less power, simpler mental model.
- Both allow concurrent transitions; Svelte's linked-list of batches is essentially equivalent in expressiveness to Solid's lane set, but bookkeeping is coarser.

**React modern.** Both rely on a barrier component (`<Suspense>` / `<svelte:boundary>`) and gather-then-swap rendering. React reconciles via re-execution of components; Svelte never re-executes a component — only re-runs effects/deriveds. React has *priority lanes* (Dim 3); Svelte does not.
React's `useTransition` is closer to Svelte's `fork()` than to its automatic batches. Notably Svelte's automatic batching is *always on* in async mode — every microtask of writes is a transition, whereas React asks the user to opt in via `startTransition`. (This means Svelte's "transition" is just "an update with async work in it", not a user-marked update.)

**xilem_web.** Generation-counter approach. Svelte's `wv` per source is a write-version (similar to a per-source generation), but the gathering is structural (via `Batch`), not by generation counter on the render tree. Different abstraction; comparable expressiveness for non-overlapping concurrent updates.

**pulse.** The closest analog from pulse to `<svelte:boundary>` is `Loading`/`use()` as composed primitives. Pulse is closer to Solid in surfacing the loading state to user code; Svelte is the *opposite* design — refuse to give user code the loading state at all, force them through a boundary. Pulse's "transitions via yield-based read brand-check" (recent ADR pivot) is much closer to React's lane model than Svelte's batch model.

## What pulse can learn

1. **The minimum-transitional-behavior bet is real and works.** Svelte demonstrates that you can ship a coherent transitional UI with only three user-facing primitives: `<boundary>` (atomicity unit), `pending` snippet (loading view), and `$effect.pending()` (was-it-coherent-now indicator). Everything else — cancellation, snapshot isolation, rebase, merge — is hidden in the engine. The cost: users cannot ask "is *this specific value* loading?" That trade-off has not led to a major outcry in Svelte's community as far as I can tell.

2. **Concurrent transitions are not free even with simple primitives.** Svelte needs ~800 lines of `batch.js` to make concurrent transitions coherent (linked-list, time-travel, rebase, merge). The "minimum" in *minimum-transitional-behavior* applies to the user-facing API, not the implementation. Pulse should not assume that exposing `Loading` as a primitive automatically gives concurrent transitions cheaply.

3. **OBSOLETE / STALE_REACTION as a two-channel cancellation model is composable.** Pulse's brand-aware read can do something similar: distinguish between "this read is from a stale lane" (silently abandon) and "this lane was explicitly aborted" (propagate). Svelte's split is *per-derived re-run* vs *per-effect abort*; pulse's brand-check is closer to per-effect, but a second channel for "this derived's previous in-flight run is now obsolete" might be worth modelling.

4. **A `fork()` primitive is a sensible escape hatch.** It's the smallest possible "speculatively run this" API: synchronous fn that mutates state, returned object with `commit()` and `discard()`. Async work inside the fork warms up automatically because the engine is already doing the snapshot-isolation work. Pulse could expose an analogous primitive on top of its lane machinery.

5. **The boundary as atomicity unit is more useful than per-derived suspension.** A boundary lets the user *choose* the granularity (component-level, route-level, app-level). Pulse already has Loading; the question is whether Loading composes the same way (does a parent Loading swallow a child's pending state?). Svelte's `is_rendered()` walks the boundary chain, and `$effect.pending()` is per-boundary not global — this lets nested boundaries operate independently. Pulse should make sure its `Loading` composition follows the same shape.

6. **Deliberately *not* having a `.loading` getter is a feature.** It forces all loading UI to be expressed via the boundary, which has the right composition semantics. If pulse wants the same, it should resist letting users introspect "is this lane pending?" at the read site and push them toward the boundary primitive.

7. **The "no waterfall" detection is valuable.** The `await_waterfall` warning fires when an async-derived isn't read by another reaction immediately after it updates — i.e. when the dependent derived starts only *after* the first finishes. Pulse could emit a similar warning when sequential awaits in different deriveds depend on each other's results in a way that could have been parallel.

## Open questions

- **Where exactly is `getAbortSignal` defined?** It is referenced in `async_derived` comments and the docs imply user code can call it on a `$state` value to get a cancellation handle, but I did not open `runtime.js` to verify the signature. Unverified.
- **Does Svelte have explicit priority levels?** I found no `priority` / `lane` symbol in `batch.js`. Confidence high that the answer is no — but I did not search across the whole `internal/client/` tree exhaustively.
- **SSR streaming.** Docs say *"In the future, we plan to add a streaming implementation"* — not in current main. Worth a follow-up dive when that lands; it would change Dim 1 atomicity considerations.
- **`{#await}` deprecation path.** The TODO comment in `async.js#capture` suggests `{#await}` may be retired. Not confirmed anywhere I can cite.
- **Why no flagship Rich Harris essay on the async story?** Searching the documentation/blog directory listing did not turn one up. The canonical material is `19-await-expressions.md` itself. There may be a SvelteSummit talk recording I didn't search; the doc page reads like the considered design statement either way.
- **Memory bound of the batch linked list.** With many in-flight transitions, the linked list grows. The merge-on-overlap collapses them but only if they touch shared sources. I did not find an upper bound; presumably real apps don't hit pathological cases, but it's a theoretical concern worth verifying with a stress test.

## Notes / aside

- The phrase *"transitional commit"* used in the brief does not appear in Svelte's source or docs; the closest in-source terminology is "batch", "deferred effects", and the user-facing docs say *"synchronized updates"* and *"globally coordinated"*. The `commit` verb appears in `#commit` on the `Batch` class and in `fork().commit()`. Pulse using the term is reasonable as a cross-framework framing, but be aware Svelte does not market this concept under that name.
- Svelte's design *commits to* (pun intended) a single mode of coherence: a `Batch` is either deferred or it's not; there's no intermediate "partial commit" state. This is the source of its conceptual simplicity and the reason the `apply()`/`#commit` rebase logic has to be careful — there's no way to give user code a half-applied batch, so the engine has to bend over backwards.
- The `flatten` function in `async.js` is the compiler's entry point for any `await`-containing expression at the markup level; it accepts pre-classified `blockers` (existing pending Promises in scope), `sync` (sync dep functions), and `async` (async-derived constructors). This is how a single `<p>{await one(x)} + {await two(y)}</p>` parallelises — both go into the `async` array and are `Promise.all`-ed.
- One small surprise: `async_derived` returns `Promise<Source<V>>` and the compiler awaits the *outer* promise to get the source, then reads it via `get()`. This means the *creation* of an async derived is itself an async operation, gated by the first resolution. Likely why "we only suspend in async deriveds created on initialisation" (`should_suspend = !active_reaction`) is the rule — to avoid recursive suspension when the same derived is re-evaluated from inside another reaction.
- The codebase reads like it's in active flux. Multiple TODOs reference "when we get rid of legacy mode", "when we retire `{#await}`", "fix the underlying cause". The async story is mature enough to ship behind a flag but the implementers are clearly still adjusting the structure. Citing line numbers in this doc is therefore risky; I cited filenames and function names, and quoted in-source comments verbatim where the structure matters.
