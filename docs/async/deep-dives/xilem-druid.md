# Xilem + Druid — async coordination in Linebender's Rust UI lineage

**Type:** primary (combined Xilem + Druid)
**Date:** 2026-05-19
**Session:** 11
**Scope note:** This dive focuses specifically on async coordination, not general UI framework architecture. Xilem and Druid are covered together because Xilem inherits and then diverges from Druid's async choices — the contrast is the dive's payload. Druid is mature but de-prioritised; Xilem is "experimental" (per its own README and the `xilem` subcrate `lib.rs` header: *"Xilem can currently be considered to be in an alpha state"*). Conducted using the parallel-passes-then-merge methodology established sessions 7–8 and now defaulted for primary dives: a background agent did the systematic source-reading from `linebender/xilem` and `linebender/druid` repos plus Raph Levien's essays; main session contributed Rust-vs-JS framing, taxonomy cross-references, and (in this case) a wrong prediction the merge had to correct. The merged document below uses the fresh pass as its spine.

---

## Sources

Primary (fetched and quoted):

1. [`linebender/xilem` — `ARCHITECTURE.md`](https://github.com/linebender/xilem/blob/main/ARCHITECTURE.md) — top-level workspace map; identifies `xilem_core`, `xilem_masonry`, `xilem_web`, Masonry split.
2. [`linebender/xilem` — `xilem/ARCHITECTURE.md`](https://github.com/linebender/xilem/blob/main/xilem/ARCHITECTURE.md) — declares Xilem a "reactive architecture" with view-tree-diffed-against-previous-view-tree; "strongly inspired by React, Elm and SwiftUI".
3. [`linebender/xilem` — `xilem_masonry/src/view/task.rs`](https://github.com/linebender/xilem/blob/main/xilem_masonry/src/view/task.rs) — the canonical async view: `task(init_future, on_event)`. Stores a `tokio::task::JoinHandle<()>` as `ViewState`; `teardown` calls `join_handle.abort()`.
4. [`linebender/xilem` — `xilem_masonry/src/view/worker.rs`](https://github.com/linebender/xilem/blob/main/xilem_masonry/src/view/worker.rs) — sibling of `task` that gives the app a back-channel `UnboundedSender<V>` for sending input *into* the running future.
5. [`linebender/xilem` — `xilem_core/src/message_proxy.rs`](https://github.com/linebender/xilem/blob/main/xilem_core/src/message_proxy.rs) — `RawProxy` / `MessageProxy<M>` / `ProxyError`. The `RawProxy` doc says: *"In the Xilem crate, this will wrap an `EventLoopProxy` from Winit."*
6. [`linebender/xilem` — `xilem_core/src/message.rs`](https://github.com/linebender/xilem/blob/main/xilem_core/src/message.rs) — `MessageResult` enum with `Action`, `RequestRebuild`, `Nop`, `Stale`.
7. [`linebender/xilem` — `xilem_core/src/view.rs`](https://github.com/linebender/xilem/blob/main/xilem_core/src/view.rs) — `View` trait with `build`/`rebuild`/`teardown`/`message`. Doc on `teardown`: *"The main use-cases of this method are to: Cancel any async tasks; Clean up any book-keeping…"*
8. [`linebender/xilem` — `xilem/examples/http_cats.rs`](https://github.com/linebender/xilem/blob/main/xilem/examples/http_cats.rs) — canonical reqwest fetch example; demonstrates the `ImageState { NotRequested, Pending, Available(ImageData) }` pattern and `fork(visible_tree, worker(...))`.
9. [`linebender/xilem` — `xilem_web/src/concurrent/memoized_await.rs`](https://github.com/linebender/xilem/blob/main/xilem_web/src/concurrent/memoized_await.rs) — the only "await-shaped" view in the codebase; uses a `generation: u64` counter to discard stale results.
10. [`linebender/xilem` — `xilem_core/src/views/fork.rs`](https://github.com/linebender/xilem/blob/main/xilem_core/src/views/fork.rs) — *"Create a view which acts as `active_view`, whilst also running `alongside_view`, without inserting it into the tree."* The async-mounting primitive.
11. [`linebender/xilem` — `docs/history.md`](https://github.com/linebender/xilem/blob/main/docs/history.md) — explicit pointer to Raph's IC video and the canonical Xilem essay.
12. [`linebender/druid` — `druid/src/ext_event.rs`](https://github.com/linebender/druid/blob/master/druid/src/ext_event.rs) — `ExtEventSink` definition.
13. [`linebender/druid` — `druid/examples/blocking_function.rs`](https://github.com/linebender/druid/blob/master/druid/examples/blocking_function.rs) — canonical Druid async pattern (`thread::spawn` + `sink.submit_command`).
14. [Raph Levien — *Xilem: an architecture for UI in Rust* (2022)](https://raphlinus.github.io/rust/gui/2022/05/07/ui-architecture.html) — the architecture essay; contains the explicit IC framing.
15. [Raph Levien — *Towards principled reactive UI* (2020)](https://raphlinus.github.io/rust/druid/2020/09/25/principled-reactive-ui.html) — predecessor essay; notes Druid struggles with async.

Notes on sourcing:

- The Raph essays were fetched via `WebFetch` and summarised; quoted strings below are model-extracted from the post text. They are quoted as Raph's *position*, not as text I have inspected character-by-character — I have noted where this matters with `[via WebFetch]`.
- No community-blog quotes are included; everything load-bearing is from Linebender repos or Raph's own site.

---

## What Xilem and Druid are (architecture in brief)

### Xilem

Xilem is a reactive view-tree framework, expressed verbatim in `xilem/ARCHITECTURE.md`:

> After every change, user-provided functions are called to generate a **view tree**, a lightweight representation of the app's UI. The new view tree is compared against the previous view tree. Based on the differences, the back-end creates an updates a retained **element tree**.

The element tree is the Masonry widget tree (native) or the DOM (`xilem_web`). The view tree is "transitory and is retained only long enough to dispatch messages and then serve as a reference for diffing for the next view tree" (`xilem_core/src/view.rs`).

The `View` trait has four methods (`xilem_core/src/view.rs:55-`):

- `build(&self, ctx, app_state) -> (Element, ViewState)` — first construction.
- `rebuild(&self, prev, view_state, ctx, element, app_state)` — diff against previous view.
- `teardown(&self, view_state, ctx, element)` — *"Cancel any async tasks; Clean up any book-keeping…"*
- `message(&self, view_state, message, element, app_state) -> MessageResult<Action>` — receive messages routed by id-path.

`MessageResult<Action>` has four variants (`xilem_core/src/message.rs`):

```rust
pub enum MessageResult<Action> {
    Action(Action),
    RequestRebuild,
    Nop,
    Stale,  // "The view this message was being routed to no longer exists."
}
```

The `Stale` variant is the load-bearing piece for async race handling — see below.

The IC connection is explicit in Raph's essay (verbatim, via WebFetch):

> Ron Minsky has stated 'hidden inside of every UI framework is some kind of incrementalization framework.' Xilem unapologetically contains at its core a lightweight change propagation engine.

But Raph also makes a *negative* claim in the 2020 essay [via WebFetch]: *"Doing a full-scale incremental computation engine, of similar scope as Adapton or Incremental, is a serious additional burden."* Xilem chose a lightweight, *typed*-diff-based propagation rather than building on top of a full SAC engine. **Observed:** there is no Adapton/Incremental dependency in `Cargo.toml` (verified by listing the workspace; the relevant crate is `xilem_core` and it has no IC-library dep). **Inferred:** Xilem's "IC engine" is best characterised as *coarse-grained, statically-typed virtual-DOM diffing with id-path-based message routing*, not as a self-adjusting dataflow graph.

### Druid

Druid is the predecessor. It is *not* virtual-DOM-shaped: it has a retained widget tree directly, plus a data type that implements `Data` (cheap-clone + same-fn) and a *lens* pattern for projecting parts of the app state into widgets. The reactive layer is one-layer-shallower than Xilem's: widgets receive `update(&mut self, ctx, old_data, new_data, env)` and decide what to repaint. There is no separate view tree.

---

## Druid's async story

Druid's async surface is one type and one extension point. `druid/src/ext_event.rs`:

```rust
/// A thing that can move into other threads and be used to submit commands back
/// to the running application.
#[derive(Clone)]
pub struct ExtEventSink {
    queue: Arc<Mutex<VecDeque<ExtCommand>>>,
    handle: Arc<Mutex<Option<IdleHandle>>>,
}
```

A widget context exposes `ctx.get_external_handle() -> ExtEventSink`. The sink is `Clone + Send` and can be moved into a thread. The thread does its work, then calls `sink.submit_command(SELECTOR, payload, target)` to put a `Command` on the queue; the UI thread is woken via `IdleHandle::schedule_idle(EXT_EVENT_IDLE_TOKEN)`.

The canonical example is `druid/examples/blocking_function.rs`:

```rust
fn wrapped_slow_function(sink: ExtEventSink, number: u32) {
    thread::spawn(move || {
        let number = slow_function(number);
        sink.submit_command(FINISH_SLOW_FUNCTION, number, Target::Auto)
            .expect("command failed to submit");
    });
}
```

The "loading state" is **manually modelled in app state**:

```rust
#[derive(Clone, Default, Data, Lens)]
struct AppState { processing: bool, value: u32 }
```

And rendered using `Either`, a widget that conditionally renders one of two children:

```rust
let either = Either::new(|data, _env| data.processing, button_placeholder, button);
```

`button_placeholder` contains `Spinner::new()`. **There is no Suspense / Loading analog**: the user types `processing: bool`, sets it before spawning, and an `AppDelegate::command` handler clears it on receipt of the response command.

`ExtEventSink::add_idle_callback` is a more recent variant (per `CHANGELOG.md`, attributed to @Maan2003 in #1955): it lets the background thread provide a `FnOnce(&mut T)` that runs on the UI thread instead of going through a typed selector + delegate. This is closer in shape to "submit a state update from off-thread", but it is still manual.

**Cancellation is not modelled.** `ExtEventSink` is a one-way channel: the background `thread::spawn` runs to completion regardless of what the UI does. If a widget is removed while a request is in flight, the response command arrives at `AppDelegate::command` and is either dispatched to a target window/widget (and silently dropped if the target is gone) or, with `Target::Auto`/`Target::Global`, handled by the delegate. Nothing aborts the background work.

Async/futures are not first-class in Druid; the `ext_event` surface is `Send + Sync` and is designed around `std::thread`. Raph confirms in the 2022 essay [via WebFetch]: *"Integration with Rust's async ecosystem is a major feature for a UI toolkit, and something the existing Druid architecture struggles with."*

**Summary for Druid:** one `Send` queue; one wake token; manual loading-state; no cancellation; no future support.

---

## Xilem's async story

Xilem replaces `ExtEventSink` with a typed-message proxy and turns "the running async task" into a *view*. Three primitives matter: `MessageProxy<M>`, the `task` view, and the `worker` view. The `fork` view glues these into the visible tree.

### `MessageProxy<M>`

From `xilem_core/src/message_proxy.rs`:

```rust
pub trait RawProxy: Send + Sync + 'static {
    fn send_message(&self, path: Arc<[ViewId]>, message: SendMessage) -> Result<(), ProxyError>;
    fn dyn_debug(&self) -> &dyn Debug;
}

pub struct MessageProxy<M: AnyDebug + Send> {
    proxy: Arc<dyn RawProxy>,
    path: Arc<[ViewId]>,
    message: PhantomData<fn(M)>,
}
```

`MessageProxy` is **typed** (`M`) and **address-bearing** (`path: Arc<[ViewId]>`). The path is the analog of React's fibre key or Solid's owner — it identifies *which view node in the tree* this message is for. The `RawProxy` doc explains that it wraps Winit's `EventLoopProxy` in the native backend; in `xilem_web` it wraps `wasm_bindgen_futures::spawn_local`.

The `ProxyError::ViewExpired` variant exists for the case where the view at `path` is gone by the time the message arrives — *"the corresponding view is no longer present"*.

### The `task` view (`xilem_masonry/src/view/task.rs`)

```rust
pub fn task<M, F, H, State, Action, Fut>(init_future: F, on_event: H) -> Task<...>
where
    F: Fn(MessageProxy<M>, &mut State) -> Fut,
    Fut: Future<Output = ()> + Send + 'static,
    H: Fn(&mut State, M) -> Action + 'static,
    ...
```

`init_future` constructs a future that holds a `MessageProxy<M>`. The runtime spawns it on tokio:

```rust
type ViewState = JoinHandle<()>;

fn build(&self, ctx, state) -> (NoElement, JoinHandle<()>) {
    let path: Arc<[ViewId]> = ctx.view_path().into();
    let proxy = ctx.proxy();
    let handle = ctx.runtime().spawn((self.init_future)(MessageProxy::new(proxy, path), state));
    (NoElement, handle)
}
```

`teardown` aborts the JoinHandle:

```rust
fn teardown(&self, join_handle, _, _) { join_handle.abort(); }
```

**This is structural cancellation.** When the `task` view leaves the view tree — either because the surrounding tree no longer includes it on this rebuild, or because the app is shutting down — its `JoinHandle::abort()` is called. The tokio runtime then drops the future at its next yield point; Rust's destructor chain runs through pending borrows, dropping reqwest connections, file handles, etc. The cancellation is *deterministic from the view-tree shape*. There is no need for an `AbortController` to be threaded by the user.

There is one stark restriction:

```rust
const {
    assert!(
        size_of::<F>() == 0,
        "`task` will not be ran again when its captured variables are updated.\n\
        To ignore this warning, use `task_raw`."
    );
};
```

`task` accepts only zero-sized closures — that is, closures that capture nothing. `rebuild` is a no-op; on changed captures, the task is not restarted. `task_raw` opts out of this check at the user's risk. This is essentially the same constraint as React's `useEffect` "the function must capture nothing or you'll get stale closures", but enforced *at compile time via `size_of`*.

### The `worker` view (`xilem_masonry/src/view/worker.rs`)

`worker` is `task` plus an mpsc back-channel:

```rust
pub fn worker<F, H, M, S, V, State, Action, Fut>(
    init_future: F,
    store_sender: S,
    on_response: H,
) -> Worker<...>
where
    F: Fn(MessageProxy<M>, UnboundedReceiver<V>) -> Fut,
    S: Fn(&mut State, UnboundedSender<V>) + 'static,
    H: Fn(&mut State, M) -> Action + 'static,
    ...
```

On `build`, the framework creates `(tx, rx) = unbounded_channel()`, gives `tx` to the app state (via `store_sender`), and spawns the future with `rx`. The app pushes work items into `tx`; the worker drains `rx` and sends results back through `MessageProxy<M>`. `teardown` aborts the JoinHandle, which drops `rx`, which causes `tx.send` from the app side to return an error (cleanly observable).

### `fork` — mounting tasks alongside the visible tree

From `xilem_core/src/views/fork.rs`:

> Create a view which acts as `active_view`, whilst also running `alongside_view`, without inserting it into the tree.

`task` and `worker` both have `type Element = NoElement`. They are not widgets. `fork` lets you place them in the tree for lifecycle purposes (so they get `build`/`teardown`) without contributing to the rendered output. This is structurally analogous to React's `useEffect` being attached to a component without producing JSX — but here the "effect" is itself a view, with its own id-path and message routing.

### End-to-end: how an async fetch in Xilem actually works

Reading `xilem/examples/http_cats.rs`:

```rust
fn view(&mut self) -> impl WidgetView<Self> + use<> {
    // ... build the visible left/right columns ...

    fork(
        flex_col(( /* visible UI */ )),
        worker(
            |proxy, mut rx| async move {
                while let Some(code) = rx.recv().await {
                    let proxy = proxy.clone();
                    tokio::task::spawn(async move {
                        let url = format!("https://http.cat/{code}");
                        match image_from_url(&url).await {
                            Ok(image) => drop(proxy.message((code, image))),
                            Err(err) => tracing::warn!("..."),
                        }
                    });
                }
            },
            |state: &mut Self, sender| { state.download_sender = Some(sender); },
            |state: &mut Self, (code, image): (u32, ImageData)| {
                if let Some(status) = state.statuses.iter_mut().find(|it| it.code == code) {
                    status.image = ImageState::Available(image);
                }
            },
        ),
    )
}
```

The "loading state" is just an enum:

```rust
enum ImageState {
    NotRequested,
    Pending,
    Available(ImageData),
}
```

Rendering branches on it:

```rust
ImageState::Pending => OneOf3::B(spinner().dims(80.px())),
ImageState::Available(image_data) => OneOf3::C(zstack(...)),
```

Button click handler sets `status.image = ImageState::Pending` and pushes the code into the worker's mpsc. The worker fetches; on success, sends `(code, image)` back through `proxy.message(...)`; the `on_response` callback receives it on the UI thread and mutates `status.image = ImageState::Available(image_data)`. Next rebuild diffs `Pending`-spinner against `Available`-zstack and swaps the element.

**No framework-level Suspense. No automatic loading boundary.** The user enumerates the states.

### `xilem_web` — the one "await-shaped" view

`xilem_web/src/concurrent/memoized_await.rs` is the closest thing in the codebase to React's `use(promise)` / pulse's `await*`. Its async-race policy is the interesting bit:

```rust
pub struct MemoizedAwaitState {
    generation: u64,
    schedule_update: bool,
    schedule_update_fn: Option<Closure<dyn FnMut()>>,
    schedule_update_timeout_handle: Option<i32>,
    update: bool,
}
```

When `data` changes, `view_state.generation += 1` and a fresh future is spawned. When the *old* future eventually resolves, its message arrives tagged with the old generation:

```rust
if my_id.routing_id() == view_state.generation {
    // handle output
} else {
    MessageResult::Stale  // <-- discarded
}
```

This is a **generation-counter race policy**: last-write-wins by sender, but stale results from earlier generations are recognised at the receiver and discarded. It is the JS-side analog of what the native side gets implicitly via `JoinHandle::abort()` — except in `xilem_web` the wasm-bindgen `spawn_local` future has no abort mechanism, so the framework just lets the old future run and ignores its message. The same `Stale` discipline is also implemented across `view_sequences/impl_vec.rs` and `view_sequences/impl_option.rs`, where comments note: *"Would need async message sent…"* triggering a generation overflow to misroute.

There is also `debounce_ms` + `reset_debounce_on_update` controls — a debounce policy baked into the async-await view rather than left to the user.

### Druid → Xilem: the diff

| Aspect | Druid | Xilem |
| --- | --- | --- |
| Off-thread → UI handle | `ExtEventSink` (clone, send) | `MessageProxy<M>` (clone, send, *typed*, *path-addressed*) |
| Wake mechanism | `IdleHandle::schedule_idle(EXT_EVENT_IDLE_TOKEN)` | `EventLoopProxy::send_event` (winit) / `spawn_local` (web) |
| Future support | none (use `std::thread`) | first-class; `tokio::task::spawn` on native, `spawn_local` on web |
| Task lifetime | independent of UI; runs to completion | tied to view's tree presence; aborted in `teardown` |
| Loading state | manual `bool` + `Either` widget | manual enum + `OneOf*` view |
| Cancellation | none | structural (view leaves tree → `JoinHandle::abort`) |
| Stale-result handling | manual (delegate routes by selector + target) | id-path routing → `MessageResult::Stale` |

---

## IC connection to async

Two things to separate.

**(a) Does Xilem use an SAC-lineage substrate?** No, in the strict sense. There is no Adapton/Incremental crate dependency; there is no first-class read-tracking, no dynamic dependency graph, no demanded-computation dirty-flag propagation. The "incrementalization" is *typed virtual-DOM diff with id-paths* — closer to React-fibre-shape than to Bonsai/Incremental-shape (cf. `bonsai-incremental.md`, `self-adjusting-computation.md`).

**(b) Does the IC framing give async-specific affordances?** Yes — *but* it is the *id-path* concept, not the dependency graph, that does the work. Raph (via WebFetch from the architecture essay):

> the waker provided to the Future trait is a thin wrapper around an id path, as well as a callback to notify the platform that it should wake the UI thread

And:

> Each View node holding a future "calls `poll` on it itself; in some respects, a future-holding view is like a tiny executor of its own."

That is: the IC framing led Linebender to make every view node *addressable* (the id-path), and once you have address-by-id, you can build async on top trivially — the address *is* the waker. This is the same insight SAC-classical never used (per session 10): SAC had nodes-as-thunks but not nodes-as-message-targets, so async never had a natural home. Xilem keeps the IC-style typed change propagation but extends id-paths to be *Send addresses for typed messages*, which gives it the missing async hook.

**This is the most distinctive cross-axis pattern in the dive.** The IC influence does not give Xilem an "async-aware engine"; it gives it a *typed address space* which is what async coordination actually needs.

The 2020 essay also confirms the *negative* form: classical IC didn't pay off enough to be worth the cost (per Raph: *"Doing a full-scale incremental computation engine, of similar scope as Adapton or Incremental, is a serious additional burden."*), so Xilem doesn't use one. The IC literature inspired the framing, not the substrate.

**Direct connection to session 10 (added in merge).** The SAC dive flagged that classical SAC is silent on async because *"the node-as-thunk model doesn't carry an address for asynchronous wake-up."* Xilem's resolution is the cleanest answer this research has surfaced: keep IC-style typed change propagation; enrich every node with a Send-typed message address. Async then composes for free because *the address is the waker*. This validates session 10's framing — the missing ingredient in classical IC for async-friendliness is identity/address discipline — and gives the framing a production-grade datapoint. The Linebender team arrived at this independently from the SAC literature, by engineering pressure rather than theoretical derivation.

---

## Comparison to JS reactive frameworks studied

| Question | Xilem | React-modern | Solid 2.x | Bonsai | pulse |
| --- | --- | --- | --- | --- | --- |
| Re-execution or fine-grained reactions? | Re-execution of `view()`; element tree updated by structural diff | Re-execution per render | Fine-grained signals | Fine-grained `Bonsai.Var` | Fine-grained |
| Async first-class? | Yes (`task` / `worker` views with structural cancellation) | Yes (Suspense, transitions, `use(promise)`) | Yes (Suspense, transitions) | No native async layer; effect monad on top | Yes (`Loading`, `await*`) |
| Suspense analog? | **No.** Loading state is hand-written enum | Yes | Yes | n/a | Yes (`<Loading>`) |
| Transition analog? | **No.** No isPending; no overlay state | Yes (`useTransition`) | Yes | n/a | Yes (transitions snapshot) |
| Race-handling for stale async? | **JoinHandle abort** (native), **generation counter + `Stale`** (web/web-await) | Suspense fiber cancellation + lane re-render | Owner disposal + transition snapshot | n/a | Generation/lane + `Loading` boundary |
| Optimistic-update analog? | None observed | `useOptimistic` | yes (Solid 2 stores) | n/a | rough analog via writes |
| Cancellation discipline | **Structural** (view leaves tree → abort) | Reconciler-managed; Suspense throw + fiber discard | Owner disposal | Manual | Generation-tagged |

The big difference is direction (a): Xilem's view *is* the cancellation handle. In React/Solid the framework retains the suspense boundary and cancels fibres; in Xilem the user *places* the task in the tree, and removing it from the tree is the cancellation. This is structurally closer to **Bonsai's `Effect.start`/`stop` pattern** than to React's Suspense — but unlike Bonsai it ties task lifetime directly to a view's tree presence rather than to a separate effect handle.

Compared to pulse: pulse has explicit `<Loading>` boundaries that *catch* an async-throw upstream; Xilem has no such catching boundary. The closest is the `OneOf*` view, which is a manual pattern-match by the user on an enum.

---

## Taxonomy cells

Each cell is for **Xilem** specifically (Druid noted where it differs).

### 1. Where async state lives

**App state, by user convention.** The framework provides no async-state container. `HttpCats { statuses: Vec<Status>, download_sender: Option<UnboundedSender<u32>>, ... }` and each `Status` has an `ImageState` enum. The view does `match` on it. The `task`/`worker` view itself stores only a `JoinHandle<()>` as `ViewState` — no value, no result. Evidence: `xilem/examples/http_cats.rs:33-50`, `xilem_masonry/src/view/task.rs:105`.

Druid: same — user-defined `Data` types; framework gives an `ExtEventSink` only.

### 2. Conflict-handling policy

**Last-write-wins with stale-message discard.** When the same data field is mutated by both an async response and a user action, whichever arrives later in the message queue wins. Stale messages (i.e. messages for a view whose path is no longer valid or whose generation is stale) are returned as `MessageResult::Stale` and discarded.

- Evidence: `xilem_core/src/message.rs` (`Stale` variant; doc: *"The view this message was being routed to no longer exists."*).
- For the await-shaped view: `xilem_web/src/concurrent/memoized_await.rs:255-264` (generation check).
- For the spawn-shaped view: `JoinHandle::abort()` in `teardown`, so racing tasks from a previous tree shape simply don't deliver.

There is **no STM-retry, CRDT-merge, snapshot-iso, OT, or lane-merge**. The taxonomy slot is "last-write-wins with receiver-side staleness check".

### 3. Cancellation discipline

**Structural, via tokio `JoinHandle::abort()` on view `teardown`.**

- `xilem_masonry/src/view/task.rs:118-120`:
  ```rust
  fn teardown(&self, join_handle, _, _) { join_handle.abort(); }
  ```
- `xilem_masonry/src/view/worker.rs:204-206`: same.
- `View::teardown` doc (`xilem_core/src/view.rs:81-85`): *"Cancel any async tasks."*

The user does not allocate or thread an `AbortController`/`CancellationToken`. Cancellation is by *omission*: if `view()` does not include this `task`/`worker` on the next rebuild, the framework calls `teardown` and the task is aborted at its next `.await`.

On `xilem_web`, where wasm `spawn_local` has no cancel, the equivalent is the generation counter: a stale future's result is silently dropped on receipt.

Druid: **no cancellation**. Background threads run to completion; their `submit_command` may be a no-op if the app is gone.

### 4. Async representation

**Native: Rust `Future` + tokio.** `Fut: Future<Output = ()> + Send + 'static`. Spawned via `ctx.runtime().spawn(...)`. Communication out: `MessageProxy::message(M)` non-blocking send through `EventLoopProxy`. Communication in (worker only): `UnboundedReceiver<V>` from `tokio::sync::mpsc`.

**Web: same future shape, `spawn_local`.** No `Send` requirement for the future on web because the runtime is single-threaded.

Druid: **`std::thread::spawn` + `ExtEventSink::submit_command`.** No `Future` support.

### 5. Isolation level

**None / shared mutable.** The `on_event` and `on_response` handlers receive `&mut State` (the app state) directly. There is no isolation between an async response and a concurrent user input — they are serialised by the single-threaded event loop. Multiple in-flight async tasks each write to app state in arrival order. This is the same isolation level as React/Solid/pulse main-thread state.

The futures themselves are isolated from app state during execution (they hold only a `MessageProxy`, not a reference to state). Mutation crosses the boundary only at message receipt.

### 6. Atomicity granularity

**Per-message.** Each message's `on_event`/`on_response` callback executes to completion on the UI thread, holding `&mut State`. There is no transaction grouping multiple messages, no batched commit, no "all writes from this task happen atomically" — if a future delivers ten messages via `proxy.message(...)` they will be processed one at a time, with rebuilds potentially between them.

### 7. Discipline location

**Mostly user-side, with one framework-side affordance.** The user is responsible for:

- Declaring the loading-state enum.
- Branching the view on it.
- Setting `Pending` before kicking off work.
- Setting `Available` on response.

The framework is responsible for:

- Routing messages to the correct view via id-path.
- Returning `Stale` for vanished views (auto-handled).
- Aborting `JoinHandle`s in `teardown` (auto-handled).

This is markedly more user-side than React/Solid/pulse where the framework owns the loading-boundary primitive. It is roughly equivalent to "raw promises + manual state machine" in JS, with Rust's type system enforcing the state-machine shape.

### 8. Reactive integration

**Coarse-grained view diff, not fine-grained reaction.** When app state changes, the entire `view()` function runs; the resulting view tree is diffed against the previous one to compute element-tree updates. Async messages arriving on the UI thread mutate app state, then trigger a rebuild (this is what `RequestRebuild` exists for). There is no read-tracking, no signal subscription. `memoize` exists as a sub-tree pruning optimisation, not as a reactive primitive.

Async integrates with the reactive layer at *exactly one point*: the message-receipt callback mutating app state, which then triggers `view()` re-execution.

### 9. Speculative-state isolation

**None.** Xilem has no concept of an overlay state, a per-transition tree, or a speculative branch. There is no `useTransition` analog, no `useOptimistic` analog. The app has a single state; mutations land in place. Searched the codebase for `transition`, `optimistic`, `overlay`, `snapshot` — no async-coordination hits in xilem_core or xilem_masonry. (Druid likewise has none.)

This puts Xilem in the **"no speculative isolation"** cell, alongside Bonsai (effect-monad-on-top) and unlike React/Solid/pulse.

### 10. Dependent-dispatch capability

**Await-only.** Tasks are plain `async fn`s using `.await`. There is no pipelining, no typed-pipelined chains, no implicit dependency capture; the user composes futures with `.await`/`join!`/`select!` from tokio. The framework provides no batching layer above this.

(`memoized_await` is *single*-future per data-keyed instance, not chained.)

---

## What pulse can learn

### 1. Structural cancellation via owned-handle drop

The most striking pattern: `task` view holds `JoinHandle<()>` as its `ViewState`; when the view leaves the tree, `teardown` calls `.abort()`. The user *never* sees an abort signal; cancellation is implied by tree shape.

In pulse this would correspond to "the async work is *owned* by some node in the reactive graph, and when that node is disposed, the work is aborted". pulse already does owner-disposal for effects; it could extend this to async work that holds the equivalent of a JoinHandle. The Rust framing is *enabled* by `Drop` running automatically when the framework drops `ViewState`; the JS equivalent would be `FinalizationRegistry` (unreliable timing) *or* explicit framework-driven `dispose()` on owner teardown. pulse already has the latter.

Worth checking: does pulse abort the underlying promise/fetch when a Loading boundary is unmounted, or does it just discard the result? Xilem aborts.

### 2. Generation counters for await-shaped views without abort

In `xilem_web`, where there is no abort, the framework uses a `generation: u64` counter incremented on data change. Stale results are recognised at the receiver via `MessageResult::Stale`. This is essentially the same pattern pulse uses for transitions (per `solid-2x.md` and the transitions-pattern doc), and it is the *correct* fallback when you can't physically cancel.

The xilem_web implementation is small (~40 lines for the generation logic in `MemoizedAwait`). If pulse wants a `useAsync(data, fn)`-style hook that auto-debounces and auto-discards stale results, this is the minimum viable shape.

### 3. Typed message proxies = a generalisation of the "throw a Promise" hack

React-style Suspense uses `throw promise` because JavaScript doesn't have a natural way to say "I am not ready, give me a wake-up address". Xilem makes the wake-up address first-class: every view has an id-path, and `MessageProxy<M>` is *typed-message-to-id-path*. The waker analog is explicit (per Raph's essay): *"the waker provided to the Future trait is a thin wrapper around an id path, as well as a callback to notify the platform that it should wake the UI thread"*.

For pulse, the cell that pulse has filled with brand-aware `read` + yield-based transition snapshot is the JS-flavoured analog. The Xilem version is *typed at the API boundary*, not branded. Both reach the same place.

### 4. No Suspense ≠ no async — but the cost is user-side

Xilem actively chose *not* to have a framework-level Loading boundary, and the result is that **every** async path in the codebase has `enum { NotRequested, Pending, Available(T) }` written by hand, with explicit `OneOf3::A/B/C` rendering. The trade-off is total flexibility (multi-state machines, partial errors) but with significant boilerplate.

pulse's `<Loading>` is a more opinionated choice. The Xilem evidence suggests that Rust's type system makes the manual approach *survivable* (enums are exhaustive, `OneOf*` is type-checked), whereas in JS the manual approach is too noisy. The lesson is: *the Loading boundary primitive is more valuable in JS than in Rust*.

### 5. The IC framing's actual payoff is *typed addresses*, not dataflow

Session 10 (SAC) noted that classical SAC has no async story because its node-as-thunk model doesn't carry an address for asynchronous wake-up. Xilem's resolution is the most elegant one this research has surfaced so far: keep the view-tree-as-IC-state-shape, but enrich every node with a path-typed message address. Async then composes for free — a future just needs to hold the address.

For pulse, the takeaway is that **identity/address discipline is the missing ingredient in classical IC for async-friendliness**, and pulse's owner+lane machinery already provides this in JS form. The dive validates the architectural choice rather than suggesting a change.

### 6. `fork` is the cleanest way to mount lifecycle-only nodes

`fork(visible_view, alongside_view)` where `alongside_view: ViewSequence<NoElement>` is a clean primitive: it gives the alongside node a place in the tree (so it gets `build`/`teardown`) without affecting layout. This is structurally similar to React Portals, but for *invisible side-effect* nodes instead of *displaced visible* nodes.

In pulse, the equivalent role is played by effects within an owner. Whether to make this user-visible (Xilem-style: explicit `fork` in the view) or implicit (pulse-style: effects auto-bound to the surrounding owner) is a real design dimension; the Xilem version forces the user to be explicit about *where* a long-running task is rooted, which is arguably better for debugging.

---

## Open questions

- **`xilem_core` is `#![no_std]`-compatible** (the file uses `alloc::boxed::Box`, `core::fmt`). The async views (`task`, `worker`) live in `xilem_masonry`, where tokio is in scope. Whether the *core* abstractions intentionally avoid pulling in async machinery (and so leave it to backends) is plausible but unverified.
- **No tests of cancellation semantics in the abort path were inspected.** That `join_handle.abort()` actually drops the future at the next await point is documented in tokio, but I did not find a Xilem test exercising "task aborted while reqwest in flight, verify the connection was closed".
- **Whether `MessageResult::RequestRebuild` is used to defer rendering until an async result is in.** It is named in `MemoizedAwaitMessage::ScheduleUpdate`'s handler (`xilem_web/src/concurrent/memoized_await.rs:268`) but I did not trace how the host reacts. Inferred: it triggers a `rebuild` pass without changing app state. Worth verifying if pulse wants a "rebuild without state change" message-type.
- **Placehero** (an in-repo larger example app, `placehero/`) likely exercises real-world async patterns — auth flow, timeline fetching. I sampled grep hits (`tokio::task::spawn`, `worker_raw`, `task_raw`) but did not read end-to-end. Possible follow-up if pulse wants more concrete patterns at production-app scale.
- **Whether `xilem_web::concurrent::interval` / `task` use the same generation-counter discipline.** I read `memoized_await` only.

---

## Notes / aside

### Rust-specific affordances that are load-bearing

1. **`Drop` runs deterministically.** When the view tree drops `JoinHandle`, abort happens. JS GC cannot match this.
2. **`size_of::<F>() == 0` const-assert.** The `task` view enforces "non-capturing closure" *at compile time*. This is the static-typing analog of React's eslint-plugin-react-hooks `exhaustive-deps` rule, but unfailingly accurate and machine-checked.
3. **`Send` bounds on `Fut`.** Native tasks are required to be `Send`; this means the futures-on-tokio model is fully multi-threaded. Web tasks drop the `Send` bound because `spawn_local` is single-threaded. The framework expresses both with the same `task` API by parameterising the runtime.
4. **`PhantomData<fn(M)>` for message-type tagging.** `MessageProxy<M>` carries `M` only at the type level; the runtime payload is type-erased through `SendMessage(Box<dyn AnyDebug + Send>)`. This gives free type-safety at the boundary without runtime cost. The JS equivalent — brand checks at read sites — is what pulse session 9 landed on.
5. **`#[const] assert!` rule-checking on closures.** The `task` view's compile-time complaint about non-zero-sized closures is a pattern worth borrowing intellectually: *encode "stale closure" pitfalls as type-system errors where possible*.

### Methodology note

Druid is in maintenance mode and the Linebender community has explicitly moved on (see `xilem/README.md` and the workspace-level `ARCHITECTURE.md`). Treating the two systems as a pair was useful primarily for the *contrast* — Druid's `ExtEventSink` is the "where Xilem started" baseline that makes Xilem's choices legible. If a follow-up dive wanted to extend this, Iced (another Rust UI framework, not Linebender) and Slint would be the obvious comparison points — they have their own async stories but are outside Linebender's IC-influenced lineage.

### Parallel-passes catch: a wrong prediction corrected

Documented for the methodology record (and for future calibration). Main session's pre-launch hypothesis was: *"async is layered separately on the view-tree, not fused into it"* — reasoning that since Rust's async runtimes (tokio, async-std) are explicitly separable from any framework, Xilem would keep async at arm's length the way Bonsai keeps its effect layer separate from Incremental. **The source-reading falsified this.** Xilem doesn't layer async separately; it makes async tasks *into views* (`task` / `worker` views, with `ViewState = JoinHandle<()>` and `teardown` calling `abort()`). Async lifetime IS view lifetime. The view-tree IS the async-cancellation discipline. This is the opposite of the prediction.

The methodology lesson reinforces sessions 7–8 and 10: the parallel-passes pattern catches when a main-session prediction is wrong by *empirically demonstrating the actual mechanism*. The prediction was reasonable from the JS-framework reference frame; it failed because Rust's `Drop` semantics enable a structural-cancellation pattern JS frameworks can't reach. Promoting this as another data point: **predictions made from one language's idioms misread cross-language design choices** — the parallel-passes methodology guards against this systematically by separating empirical source-reading from framing.
