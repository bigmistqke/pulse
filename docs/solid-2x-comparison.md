# Pulse vs Solid 2.x — A Comparative Analysis

> For an overview of pulse and how to use it, see the [top-level README](../README.md). For the language of pulse and its conceptual model, see [`CANON.md`](../CANON.md).

This analysis compares pulse at commit `408da57` (2026-08-22) with Solid 2.0.0-rc.13, published 2026-09-30. On the Solid side, it draws on these sources:

- The design documents in [`documentation/solid-2.0/`](https://github.com/solidjs/solid/tree/309b0873/documentation/solid-2.0) on the `next` branch at commit `309b0873`.
- The async semantics specification, [`packages/signals/docs/SPEC-ASYNC-SEMANTICS.md`](https://github.com/solidjs/solid/blob/309b0873/packages/signals/docs/SPEC-ASYNC-SEMANTICS.md).
- The `@solidjs/signals` changelog for the release candidates.
- Ryan Carniato's three-part series on async in Solid 2.0: [Fetch High, Block Low](https://www.solidjs.com/blog/async-solid-fetch-high-block-low), [Write Sync, Run Async](https://www.solidjs.com/blog/async-solid-write-sync-run-async) and [One Graph, Two Machines](https://www.solidjs.com/blog/async-solid-one-graph-two-machines).

Solid 2.0 entered release candidate on 2026-08-12. The `latest` tag on npm is still 1.9.x, and 2.0 ships under the `next` tag. APIs may still change before the stable release.

The previous version of this document was written against the 2.0 beta and an older pulse. Both sides have moved since. Pulse gained `action`, `optimistic`, `committed`, `onSettled`, `<Errored>`, and the `peek` / `latest` split. Solid gained `until`, an awaitable `refresh`, question-scoped `isPending`, a reworked `<Loading on>`, and a written specification of its async semantics.

## 1. Shared foundation

Both libraries share more than is obvious on the surface.

- Both compile JSX into direct DOM operations with no virtual DOM. Reactive expressions become per-binding holes.
- Components run once in both. Reactivity lives in the holes, not in re-running the component function, so local state created in the body is created once.
- Both keep an owner tree that scopes reactive nodes and their cleanups. Disposing an owner disposes its descendants.
- Both batch writes on a microtask by default and expose `flush()` to drain synchronously.
- Async is a property of a computation in both, not a separate primitive. A memo or computed body can return a Promise, and neither has `createResource`.
- Both signal "not ready" by throwing a sentinel error: `NotReadyError` in Solid, `NotReadyYet` in pulse. A boundary or effect catches it.
- Both name the suspension boundary `<Loading>` and the error boundary `<Errored>`. Both hold previously displayed content during a refetch instead of returning to the fallback.
- Both expose `isPending` and `latest`. The names match, but the meanings differ in ways described in section 3.
- Both ship `action` for mutations and an optimistic primitive whose predictions expire when the action closes.
- Both use generators to keep an action's context across asynchronous steps. JavaScript loses ambient context after an `await`, and a generator lets the library resume the body inside that context.

Some names collide with different meanings. Keep these in mind when reading code from either side.

| Name | Solid 2.x | Pulse |
|---|---|---|
| `latest(x)` | The value the graph is working toward. For a held write, that is the new value before it is revealed. | The last resolved value, plus ambient reporting of loading and error state to boundaries. |
| `onSettled(fn)` | A lifecycle hook that replaces 1.x's `onMount`. | A callback that fires when the enclosing action commits or is discarded. |
| `isPending(x)` | True while a changed question for `x` has not been answered, or while `affects()` marks it. | True while `x` or anything upstream of it has an unsettled promise. |

## 2. The central difference: where a pending value is held

This is the difference that most of the others follow from.

In Solid 2.x, a write that makes async work pending is held for every reader. The write itself does not become visible until everything it caused has landed. Solid calls this "API-less transitions": there is no `startTransition`, because every write already behaves like one.

In pulse, a write lands at once. Each reader decides what to do with a pending value by the verb it reads with. `use(x)` throws and suspends the binding. `latest(x)` returns the last resolved value and reports the loading state to the nearest boundary. `peek(x)` returns the last resolved value and reports nothing.

Take a story list where clicking a story selects it and a detail pane fetches it. In both libraries, `selectedId` is a signal and `story` is an async derivation of it.

In Solid:

```tsx
const [selectedId, setSelectedId] = createSignal(1)
const story = createMemo(() => fetchStory(selectedId()))

<StoryList selectedId={selectedId()} onSelect={setSelectedId} />
<Loading fallback={<Skeleton />}>
  <h1>{story().title}</h1>
</Loading>
```

Clicking story 2 writes `selectedId`. The fetch for story 2 starts. The list's highlight and the heading both keep showing story 1 until the fetch lands, then both switch together. `isPending(selectedId)` is true during the wait, because the write to `selectedId` is being held. To move the highlight at once, the list reads `latest(selectedId)` instead of `selectedId()`.

In pulse:

```tsx
const [selectedId, setSelectedId] = signal(1)
const story = computed(() => fetchStory(selectedId()))

<StoryList selectedId={selectedId()} onSelect={setSelectedId} />
<Loading initial={<Skeleton />}>
  {() => <h1>{use(story).title}</h1>}
</Loading>
```

Clicking story 2 writes `selectedId`, and the list's highlight moves at once. The heading's binding throws on `use(story)`, so the heading keeps showing story 1 until the fetch lands. During the wait, the screen shows the new selection beside the old story. `isPending(selectedId)` is false throughout, because a plain signal is never pending.

To make the highlight wait in pulse, the highlight's binding moves inside the same `<Loading>` and reads `use(selectedId)`. That call never throws, because `selectedId` is not pending. It enrols the binding in the boundary's commit gate, so the highlight's commit waits until the heading's commit is ready.

So the two defaults are mirror images. Solid holds by default and offers `latest` to show a write early. Pulse shows by default and offers `use` inside a `<Loading>` to make a binding wait. Solid's position is argued in [Fetch High, Block Low](https://www.solidjs.com/blog/async-solid-fetch-high-block-low). Pulse's position is recorded in [ADR 0015](adr/0015-peek-latest-split-ambient-loading-participation.md) and [ADR 0017](adr/0017-decompose-loading-into-placeholder-gate-and-pending-set.md): the read verb decides what a binding renders and whether it waits, and everything else is reported ambiently.

The Solid default has a cost of its own. A reader that should move at once must opt out with `latest`, per read site. Solid's documentation also notes that routing several rendered async computations through the same `latest(x)` makes them reveal together, when the slowest one settles. Pulse's cost is the inverse. A binding that should wait must opt in with `use` and must sit inside the right `<Loading>`, or the screen tears.

## 3. Reading async values

### 3.1 Reads during a refetch

Both libraries keep showing the previous value while a new one is fetched.

In Solid, a reader of a pending value holds the write that made it pending. The reader keeps the frame it last displayed until the data lands. Only a first load, with no previous value, throws `NotReadyError` to the nearest `<Loading>`.

In pulse, every async stage of a `computed` publishes stale-while-revalidate. Calling `c()` during a refetch returns the previous resolved value. `use(c)` throws on every pending episode, including refetches. `use.latest(c)` throws only until the first value exists and returns the stale value afterwards ([ADR 0014](adr/0014-use-latest-composed-on-latest.md)).

### 3.2 `latest`

Solid's `latest(x)` reads the value the graph is working toward. For a held signal, that is the new value before the hold releases. For an async memo whose next answer has not arrived, it falls back to the stale value.

Pulse's `latest(x)` returns the last resolved value, or `undefined` before the first one. It never throws. It reports three facts to the surrounding boundaries: a background refresh, a first load, and an error state. `peek(x)` returns the same value and reports nothing.

On an async memo during a refetch, both return the stale value. They differ on writes, because only Solid holds writes. A pulse signal is never held, so reading it plainly already gives the new value.

### 3.3 `isPending`

Solid ruled in July 2026 that pending is scoped to the question being asked ([A24 in the specification](https://github.com/solidjs/solid/blob/309b0873/packages/signals/docs/SPEC-ASYNC-SEMANTICS.md)). `isPending(x)` is true in two cases:

1. A tracked input of `x` changed, and the new answer has not landed.
2. In-flight work declared that it will change `x`, by calling `affects(x)`.

A re-ask of the same question is silent. That covers a bare `refresh()`, polling, and a confirming refetch after a mutation. To make a reload show as pending, an action calls `affects(x)` and then `refresh(x)`. A computation created with `loadingValue` also has a quiet first flight: it renders the declared placeholder value, and `isPending` stays false until the first real answer lands.

Pulse's `isPending(x)` walks the pending registry in `src/pending.ts`. It is true when `x` or anything upstream of it holds an unsettled promise. It follows both the static pipeline chain and the sources a recipe read dynamically. Pulse has no `refresh`, so the difference between a changed question and a re-ask does not arise yet. A retry from an `<Errored>` boundary or an action handle re-runs the work, and that run shows as pending.

In Solid, `isPending` performs the read passed to it. Where it is placed therefore matters, because the read can take part in a `<Loading>` boundary. In pulse, `isPending` takes an accessor and consults the registry without subscribing a boundary to anything.

### 3.4 Waiting for a value outside the graph

Solid has three imperative bridges, and they read different views of the state:

- `resolve(fn)` resolves with the first settled value of `fn`. Inside an action, it sees that action's own view, optimistic overrides included.
- `until(fn)` resolves the first time `fn` settles to a truthy value. Inside an action, it reads the authoritative view: the action's own optimistic overrides are invisible to it. It exists for live sources such as sockets and subscriptions, where a write is confirmed on the data channel and not by the mutation's response. It takes `timeout` and `signal` options.
- `refresh(x)` returns a promise for the next quiescent state of `x`. If another refresh replaces it mid-flight, the promise waits for whatever finally lands.

Pulse's waiting happens inside generators. `yield* from(p)` suspends on one value. `yield* settled([a, b])` suspends until every input has settled, awaiting the in-flight value of any input that is refetching, and returns the fresh values together. Pulse has no equivalent of `until` or an awaitable refresh.

### 3.5 Pipelines and generator stages

Pulse's `computed(s0, s1, s2)` is a variadic pipeline. Each stage consumes the previous stage's resolved value. A stage can be sync, async, or a generator that uses `yield* from(x)` for per-step type inference. A generator stage resumes at its pause point and replays the dependencies it recorded before the pause ([ADR 0013](adr/0013-generator-stages-resume-with-dependency-replay.md)).

A Solid memo is one function. Async composition happens with `async` / `await` inside it, or by chaining memos. A read after an `await` is not tracked. The release candidates added a development warning, `UNTRACKED_READ_AFTER_AWAIT`, for exactly that mistake. Pulse's generator stages avoid it by construction, because every read goes through a resumption that pulse drives.

## 4. Boundaries

### 4.1 `<Loading>` in Solid

Solid's `<Loading fallback>` shows its fallback on first load. On a later refetch it keeps its content, because its readers hold the write.

The `on` prop was reworked during the release candidates. It is a dependency list: a tracked expression whose value is never compared. When anything it reads changes, the boundary stops holding its old content and shows its fallback, if something under it is still pending. The fallback appears in the same frame as the change that caused it.

Solid's documentation walks through a product page to show what that means. The page shell reads `product(id)` outside a `<Loading on={id()}>`, and the content inside reads `comments(id)`. Navigating from product A to product B produces these frames:

```
no on:            [A]  →  [B + comments]
on={id()}:        [A]  →  [B + spinner]  →  [B + comments]
on={latest(id)}:  [A]  →  [A + spinner]  →  [B + spinner]  →  [B + comments]
```

If the data the boundary waits on is also read outside it, the fallback can never appear. A development diagnostic, `LOADING_ON_OUTSIDE_HOLD`, reports that case.

Two more pieces sit beside `<Loading>`:

- `loadingValue` on a memo, or `seedLoadingValue` on a derived store, declares a placeholder value for the first paint. The node renders it through the real components and never trips a boundary.
- `<Reveal order="sequential | together | natural" collapsed>` coordinates when sibling boundaries reveal. Its primitive form is `createRevealOrder`. Group membership is direct children only: any nested boundary cuts reveal coordination for its own subtree.

### 4.2 `<Loading>` in pulse

Pulse's `<Loading>` does three jobs in one component:

1. It is a commit gate. Bindings that called `use` land in one pass once nothing inside is pending.
2. It swaps the display. `initial` shows on first load. `fallback` shows on later refetches if given; otherwise the boundary holds its previous content.
3. It aggregates loading state, which `isLoading()` and `useLoading()` read.

[ADR 0017](adr/0017-decompose-loading-into-placeholder-gate-and-pending-set.md) records a plan to split these three jobs. The display swap would become a placeholder component. The gate would be kept only if a scenario needs it. The aggregate would become `pendingGroup()`, a named set of pending sources that `isPending(group)` can read from anywhere. Most of this plan is not implemented.

The plan answers some of the questions `<Loading on>` and `<Reveal>` answer, from a different starting point:

- Solid's `on` makes one boundary drop its hold when named inputs change. Pulse keeps holding as a property of the read verb, and a placeholder decides only what is displayed.
- Solid's `<Reveal>` finds its members through the owner tree and orders them by render order. ADR 0017 argues that ordering should name groups instead of containing them, and that `together` falls out of several placeholders sharing one group.
- Solid's `collapsed` option names a third state for a region: ready but not yet permitted to show. ADR 0017 records that a placeholder under an ordering policy needs the same state.

A known gap remains in pulse's gate. `<Show>` and `<For>` mount and unmount their structure at once, even inside a pending `<Loading>`, and only content holes are deferred. See [`follow-ups.md`](./follow-ups.md).

### 4.3 Errors

Solid has `<Errored>` and its primitive form `createErrorBoundary`. The release candidates added a production hook for errors a boundary caught. The hook is `configureClientErrors({ onError })`, or an `onError` option on `render`. It reports where an error was thrown and which boundary met it. An error that escapes every boundary halts the reactive system and goes to the platform's `reportError`.

Pulse has `<Errored>` with a fallback, `<Errored.Error>` for rendering the error, and `isErrored()` / `useErrored()` for reading boundary state. The boundary state includes `retry()`, which retries every failed report the boundary collected. `catchError(fn, handler)` remains as the owner-level primitive. A failed action registers with the nearest `<Errored>` automatically, and the boundary's `retry` re-runs the action. A tolerant `latest` read of a source in an error state also reports to the nearest `<Errored>`.

## 5. Writes: actions, speculation and optimistic values

### 5.1 Actions

Both libraries wrap a mutation in `action`. Writes inside it are not visible until it commits, and a failure throws them away.

Solid's `action` takes a generator or an async generator. `yield` hands the runtime a promise to wait on and resumes the body inside the action's transaction. The transaction stays open until the body finishes and everything it caused has landed. That includes a `refresh()` the action issued: the refetched data lands into the open transaction and commits with it. `until` extends the hold further, until a live source confirms the write.

Pulse's `action` accepts three body shapes:

1. A sync body commits on return and discards on throw.
2. An async body is scoped only for its synchronous prefix. A write after the first `await` lands in committed state at once.
3. A generator body is scoped throughout. Pulse re-enters the speculation on every resume, so a write after `yield* from(p)` is still speculative.

The action returns an `ActionHandle` with `settled`, a reactive `error`, and `retry()`.

The difference that matters most is what the action waits for. A pulse action commits when its body completes. It does not wait for asynchronous work its writes cause afterwards, such as a derivation refetching because its input changed. ADR 0017 records this explicitly and lists making actions wait as an open feature, not a reinterpretation. Solid's transaction does wait, and its RC documentation calls `yield refresh(x)` "the mutate-then-refetch sequencing primitive".

### 5.2 Concurrent actions

Solid entangles concurrent transactions through the graph. When two transactions reach a shared node, their lanes settle as one reveal ([A15](https://github.com/solidjs/solid/blob/309b0873/packages/signals/docs/SPEC-ASYNC-SEMANTICS.md)). A write to a node another transaction holds is a proposal, and it joins that hold ([A34](https://github.com/solidjs/solid/blob/309b0873/packages/signals/docs/SPEC-ASYNC-SEMANTICS.md)). A memo created while a transaction holds a value it reads is born inside that transaction ([A29](https://github.com/solidjs/solid/blob/309b0873/packages/signals/docs/SPEC-ASYNC-SEMANTICS.md)).

Pulse isolates concurrent speculations by default ([ADR 0009](adr/0009-isolate-speculations-by-default.md)). Each action writes into its own scope-tagged slot. A sibling action does not see another's uncommitted writes, and overlapping writes resolve last-commit-wins. Coupling two actions is explicit: nest one inside the other. ADR 0009 also describes an opt-in `onConflict: 'reject'` for writes whose premise went stale. That option is not implemented yet.

This is a deliberate split. Solid's model fits an app built around overlapping async flows that should resolve as one. Pulse judges that shape rare, and avoids coupling unrelated flows just because they share a downstream node.

### 5.3 Optimistic values

Solid has `createOptimistic(value)`, with the same surface as `createSignal`, and `createOptimisticStore(fn, seed)`. A write through either creates an override that is visible at once and reverts when the transaction settles. The underlying source reconciles against the confirmed truth. Only properties that differ trigger updates, so a correct prediction costs nothing extra.

Pulse's `optimistic(...stages)` builds the same pipeline as `computed` and returns `[value, setValue, isOptimistic]` ([ADR 0016](adr/0016-optimistic-as-a-signal-variant.md)). Its setter writes a layer in front of the derivation, keyed by the writing action. Pulse's rules for layers:

- A reader outside every action sees the top layer, so the prediction shows at once.
- A reader inside an action sees the nearest layer up its own scope chain, never another action's prediction.
- Each action's layer drops when that action closes, whichever way it closes.

The two differ in three places:

- Pulse keeps one layer per action and displays last-write-wins. An early-closing action cannot remove a later action's live prediction. Solid spent much of the release-candidate period on the equivalent cases. Its changelog lists fixes for overrides leaking into a later action and for superseded overrides.
- While any pulse layer is live, the node reports neither pending nor failed. Solid's optimistic overrides are "verdict-inert": they do not pend their own slot, and they do not silence a real pending state either ([A12, A24](https://github.com/solidjs/solid/blob/309b0873/packages/signals/docs/SPEC-ASYNC-SEMANTICS.md)).
- Solid's `until` deliberately cannot see the caller's own override, so a prediction cannot confirm itself. Pulse's closest tool is `committed(x)`, which reads the committed value from anywhere. Pulse has no primitive that waits for a condition.

Solid recommends co-writing an optimistic flag for "saving…" affordances, instead of reading pending state. Pulse's layers support the same pattern.

### 5.4 Stores

Solid has a store layer: `createStore`, `createProjection`, `createOptimisticStore`, `reconcile`, `snapshot`, `deep`, and draft-first setters. During the release candidates, a projection's draft became writable until the next run or disposal. That turns an external subscription into a plain derive function. A store setter callback that returns a Promise now throws in development.

Pulse has plain signals only. An optimistic store is on the roadmap in `CONTEXT.md`.

## 6. Effects, guards and tooling

Solid splits effects into a tracked compute phase and an untracked apply phase: `createEffect(compute, apply)`. All compute phases in a flush run before any apply phase. `createTrackedEffect` and the lifecycle hook `onSettled` complete the set. Cleanups now run in reverse registration order.

Pulse's `effect(fn)` is single-phase. The staged form `effect([...stages], commit)` separates reads from the side effect at the call site, and its `commit` joins `<Loading>`'s gate.

Solid guards against common mistakes in development:

- Writing a signal inside a reactive scope throws unless the signal was created with `ownedWrite: true`.
- A top-level reactive read in a component body warns (`STRICT_READ_UNTRACKED`).
- The release candidates added a catalogue of named diagnostics, such as `FALLBACK_FLASH`, `ABANDONED_FLIGHTS`, `OPTIMISTIC_REVERTED` and `WASTED_RECOMPUTE`.
- An observability layer (`OBSERVE.records`, an attribution engine, and Chrome Performance panel tracks) explains why a node re-ran or a boundary held.

Pulse has none of these guards or tools.

## 7. Runtime architecture and its cost

Solid's `@solidjs/signals` integrates async, transactions, lanes, optimistic overrides and boundaries into one runtime. Pulse keeps r3 as a plain dependency for committed state. It adds speculation as an overlay above r3, with per-scope slots, and the two meet only at commit ([ADR 0010](adr/0010-speculation-overlay-above-r3.md)).

The earlier version of this document estimated what pulse would need to match Solid's lane capabilities. Pulse has since built most of it:

| Capability | Solid 2.x | Pulse |
|---|---|---|
| Speculative writes invisible outside the action | Yes, through transactions and lanes | Yes, through per-scope slots |
| Atomic commit of an action's writes | Yes | Yes |
| Discard on failure | Yes | Yes |
| Optimistic predictions that expire with the action | Yes, overrides | Yes, layers keyed by action |
| Entangling concurrent actions that share state | Automatic, through the graph | Deliberately not; nesting couples actions explicitly |
| Holding a write until the async it caused lands | Yes, the default for every write | No |
| Boundaries aware of held writes | Yes | No; `<Loading>` sees committed state only |
| Effects inside a speculation | Held with the transaction | Forbidden inside a speculation |

The release candidates show what the integrated approach costs to get right. The `@solidjs/signals` changelog has about 300 entries across rc.1 to rc.13. About half of them mention holds, lanes, transactions, landings or optimistic overrides. In September 2026, Solid added a written specification of its async semantics: 34 numbered rulings (A1 to A34), a log of re-rulings, and a list of open rulings. Examples of the rulings:

- A28: a write becomes visible at flush, on every channel at once, including `latest` and `isPending`.
- A29: a tracked read served a transaction's staged value enters that transaction.
- A33: async work that is only visible behind a `<Loading>` fallback holds no transaction.
- A34: a write to a held node is a proposal, and joins the hold.

This is useful input for pulse in two ways. The rulings are a catalogue of edge cases any model of held writes must answer. They also support ADR 0009's bet that isolation is the cheaper default. Many of Solid's fixes concern interactions between transactions that pulse's isolation rules out by construction.

## 8. Outside pulse's scope

The Solid release candidate also covers ground pulse does not attempt:

- A Rust compiler built on OXC, now the default in `@solidjs/vite-plugin`.
- A "start mode" in the Vite plugin, which replaces SolidStart.
- Server functions (`"use server"`), streaming SSR and hydration with a per-computation `ssrSource` policy, and experimental server components.
- A `dynamic()` factory that replaces the `<Dynamic>` component, which is now deprecated.

## 9. Summary table

| Concern | Solid 2.x (rc.13) | Pulse |
|---|---|---|
| Reactive core | Own integrated runtime (`@solidjs/signals`) | r3, with speculation as an overlay above it |
| Async data primitive | `createMemo(async () => …)` | `computed(...stages)`, a pipeline of sync, async and generator stages |
| A write that causes async | Held for every reader until the async lands | Lands at once |
| Suspending a read | Implicit on first load; readers hold on refetch | Explicit: `use(x)` throws, `use.latest(x)` throws only on first load |
| Showing a value early | `latest(x)` reads the value in flight | The default; `latest(x)` / `peek(x)` read the last resolved value |
| Pending query | `isPending(fn)`, question-scoped, `affects()` to declare | `isPending(x)`, registry walk over the pipeline and recipe reads |
| Re-fetching the same question | `refresh(x)`, quiet by default, awaitable | None; retry through `<Errored>` or `ActionHandle` |
| Boundary | `<Loading fallback on>` | `<Loading initial fallback>`, with a planned split ([ADR 0017](adr/0017-decompose-loading-into-placeholder-gate-and-pending-set.md)) |
| Declared first paint | `loadingValue` / `seedLoadingValue` | `signal(fn, default)` seeds what to display |
| Cross-boundary reveal | `<Reveal>` / `createRevealOrder` | None; ADR 0017 argues for named groups |
| Mutations | `action(function* …)`; the transaction holds caused async | `action(...)` with sync, async or generator bodies; commits when the body completes |
| Concurrent mutations | Entangled through the graph | Isolated; coupled only by nesting ([ADR 0009](adr/0009-isolate-speculations-by-default.md)) |
| Optimistic values | `createOptimistic`, `createOptimisticStore` | `optimistic(...stages)`, per-action layers ([ADR 0016](adr/0016-optimistic-as-a-signal-variant.md)) |
| Waiting for values | `until(fn)` for a condition, `resolve(fn)` for a value | `yield* from(x)` and `yield* settled([...])` inside generators; no condition form |
| Reading committed state | Inside `until` | `committed(x)` anywhere |
| Stores | Full store and projection layer | None |
| Effects | Split: `createEffect(compute, apply)` | `effect(fn)` and staged `effect([...stages], commit)` |
| Error boundary | `<Errored>`, `createErrorBoundary`, `configureClientErrors` | `<Errored>`, `<Errored.Error>`, `useErrored`, `catchError`; actions register automatically |
| Development guards | Writes under scope, strict reads, named diagnostics, observability | None |
| Lists | `<For keyed>`, `<Repeat>` | `<For>` |
| Dynamic components | `dynamic()` factory | None |

## 10. Conceptual posture

Solid 2.x's bet is that holding is the default. Every write that causes async work waits until that work lands, so the screen never combines stale and fresh values. Readers that want to show a change early say so with `latest`. Coordination belongs to the runtime, and the release candidates show the runtime taking on a long tail of edge cases to make that guarantee hold.

Pulse's bet is that the read site decides. A write lands at once. Each binding chooses by its verb whether it suspends, waits for its neighbours, or shows what it has. Actions isolate their writes and commit when their body finishes. Coupling is explicit, whether between bindings (a shared `<Loading>`) or between actions (nesting).

Both designs arrive at a screen that does not tear, by opposite routes. Solid's route asks less of the author and more of the runtime. Pulse's route asks the author to mark every place that should wait. In return it keeps each coordination decision visible at its call site and keeps unrelated flows uncoupled.

### Questions the release candidates raise for pulse

These are open questions, not decisions.

- Should pulse distinguish a changed question from a re-ask of the same question? Solid concluded that `isPending` should stay quiet on a re-ask. Pulse has no re-ask primitive yet, and adding `refresh` would force the question.
- Should an action wait for the async work it caused? ADR 0017 leaves this open. Solid's answer is yes, and its `until` extends the wait to confirmations that arrive on a live source.
- Does the placeholder in ADR 0017 need something like `on`? Solid's walkthrough shows that "drop the hold when this input changes" is a real design choice, separate from first load.
- Solid's rulings A28 to A34 are a list of situations any model with held or speculative writes has to answer. Walking them against pulse's speculation model would show which ones isolation makes moot and which ones pulse still has to decide.

## 11. Maturity

Pulse is younger and less tested. Known issues and their workarounds are tracked in [`follow-ups.md`](./follow-ups.md).

Solid 2.0 is in release candidate. The release candidates mostly fixed edge cases in holds, lanes and optimistic overrides, added diagnostics, and wrote down the semantics as a specification.
