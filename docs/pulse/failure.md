# Failure — what speculation failure looks like in apps

A scenario-first exploration of *failure* as a first-class part of
speculation in pulse: what kinds of failure happen in real apps, what
response patterns apps deploy, what information the framework needs
to surface for those patterns to be expressible, and where the
application/framework split should land.

The current naive model is "action body throws → scope discards →
cleanups fire → done." That covers maybe one of the patterns below
and forces every app to re-implement the rest poorly. The question
this doc explores: what does pulse need to expose so that the rich
landscape of failure UX becomes expressible without baking in
opinionated strategies?

This doc is exploration, not specification. Recommendations are
*current candidates*, subject to revision as implementation surfaces
new constraints.

**Companion documents:**

- [framings.md](./framings.md) — principles, especially
  [P1](./framings.md#p1--speculation-is-one-concept-with-two-faces)
  (speculation as symmetric speculate / commit / discard) and
  [P5](./framings.md#p5--compose-dont-proliferate-in-either-direction)
  (compose, don't proliferate).
- [questions.md](./questions.md) — open questions registry, especially
  [Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)
  (cleanup composition) which underpins the lifecycle-hook question
  here.
- [concurrent-divergence.md](./concurrent-divergence.md) — companion
  exploration of speculation overlap; some failure patterns (conflict
  resolution, partial commit) intersect with the divergence question.
- [optimistic-ui.md](./optimistic-ui.md) — companion exploration of
  optimistic UI; failure patterns under optimism (rollback toast,
  force-commit-despite-failure) connect here.
- [../async/CONTEXT.md](../async/CONTEXT.md) — research-arc lexicon.

## Contents

- [The framing](#the-framing)
- [Patterns of failure in apps](#patterns-of-failure-in-apps)
- [The kinds of failure that actually happen](#the-kinds-of-failure-that-actually-happen)
- [What pulse currently has, and what's missing](#what-pulse-currently-has-and-whats-missing)
- [How existing frameworks handle failure](#how-existing-frameworks-handle-failure)
- [The application / framework split](#the-application--framework-split)
- [Candidate framework primitives](#candidate-framework-primitives)
- [Sub-questions still open](#sub-questions-still-open)
- [Tentative recommendations](#tentative-recommendations)

---

## The framing

Pulse's [P1](./framings.md#p1--speculation-is-one-concept-with-two-faces)
already commits to symmetry between commit and discard — *speculate /
commit / discard* are equally important paths, not "success and the
weird sad case." That framing comes through in the engine semantics
(discard is a first-class scope close, not a recovery from
commit-attempt). But the *application's* experience of discard varies
wildly: a user explicitly cancelling, a server validation rejecting,
a network timeout, a 401 expiring auth, a conflict on shared state.
The framework collapses all of these into "scope discarded"; the
application has to disentangle them from outside.

A more honest framing: **discard has causes, and the cause carries
information the application needs.** Failure isn't a single thing —
it's a family of distinguishable events, each with its own response
patterns. If the framework can't tell the application which kind of
discard happened, the application either has to manually instrument
every action body to track its own causes, or treat all failures
uniformly and lose the rich UX patterns users expect.

This doc walks the family of failure patterns in real apps, names what
information each pattern needs from the framework, and identifies the
minimum set of additions to pulse that unblock the family without
forcing opinionated strategies.

## Patterns of failure in apps

The recurring shapes of failure UX. Listed by what the framework needs
to expose for each to be expressible cleanly.

### F1 — Toast + retry button

User action fails → toast appears with error message and a "retry"
button. User clicks retry → same action re-runs.

- *Framework needs:* the error message (or some serializable failure
  info); a retry primitive that re-runs the same action body.
- *Common for:* form submits, send-message, save operations where
  the user is present and willing to wait.

### F2 — Inline form error

Action fails with validation errors → form shows per-field errors →
user fixes and resubmits.

- *Framework needs:* the failure payload (typically a structured
  validation error: `{ field: 'email', message: 'already taken' }`).
- *Common for:* form submits with server-side validation; CRUD
  operations.

### F3 — Auto-retry with backoff

Action fails with transient error → framework or library retries N
times with exponential backoff → only surfaces if all retries fail.

- *Framework needs:* retry primitive; a way to distinguish "retryable"
  failures from "don't-retry" failures (network error vs validation
  error vs 401).
- *Common for:* network-flaky environments, background sync,
  resilient infrastructure.

### F4 — Optimistic-with-rollback-toast

Optimistic UI showed predicted state → action fails → UI rolls back
*and* a toast surfaces "couldn't save your edit, click to retry."

- *Framework needs:* lifecycle hook fired on failure specifically (not
  on cancellation or supersession); access to the failure error.
- *Connects to:* the [`optimistic-ui.md`](./optimistic-ui.md) pattern —
  this is what the F4 toast attaches to.

### F5 — Queue-for-later

Offline-first app: action fails because no connection → action is
*queued* → retried when connectivity returns → eventually commits.

- *Framework needs:* a way to *persist* a failed-but-not-given-up
  action; ability to re-create the action from durable state;
  failure-cause discrimination (queue on network failure, not on
  validation failure).
- *Common for:* offline-first apps, mobile experiences, sync engines.

### F6 — Conflict resolution dialog

Action fails with 409 (concurrent edit) → open modal showing both
versions → user picks one or merges → new action commits the choice.

- *Framework needs:* failure payload carrying both server-state and
  the user's attempted-state; distinct "conflict" failure category.
- *Common for:* collaborative editing, version-controlled documents,
  optimistic concurrency control.

### F7 — Partial-failure surfaced

Bulk action — "move 10 items" — 8 succeed, 2 fail (permission) →
UI shows 8 moved, 2 stayed with "couldn't move (permission)" badge.

- *Framework needs:* either per-item nested actions (each succeeding
  or failing independently) or a way for the outer action to commit
  partial results with embedded failure information.
- *Common for:* bulk operations, batch imports, multi-record updates.

### F8 — Degraded mode

Action fails repeatedly → app switches to a degraded mode (read-only,
cached data, sync-disabled) → notifies user of the degradation.

- *Framework needs:* repeated-failure tracking (count, history); a
  way for the app to query "how many of the recent actions have
  failed?"; aggregation across multiple actions.
- *Common for:* mission-critical apps, dashboards, monitoring tools.

### F9 — Auth-required retry

Action fails with 401 → app prompts user to re-authenticate → on
successful auth, automatically retries the original action.

- *Framework needs:* preserve the action's body and inputs across
  the re-auth boundary; retry primitive that can re-execute after an
  unrelated interaction completes.
- *Common for:* apps with auth that can expire mid-session.

### F10 — Silent ignore

Background analytics action fails → log silently → never bother the
user.

- *Framework needs:* nothing extra — silent ignore is the absence of
  user-facing surfacing.
- *Common for:* telemetry, fire-and-forget side effects.

### F11 — Diagnostics drawer

Power-user "details" panel: action fails → user can click "details"
→ see full error info, request ID, retry count, timing.

- *Framework needs:* failure context preserved (error, timing,
  attempt count, source action handle, scope chain at failure time).
- *Common for:* developer tools, internal dashboards, support
  workflows.

### F12 — Compensating rollback

Multi-step action fails partway → manually reverse the side effects
of the steps that did succeed via additional compensating actions
(server-side state can't be transactionally rolled back).

- *Framework needs:* failure-point information ("which step
  failed?"); access to what was already committed; ability to
  trigger compensating logic from the failure handler.
- *Common for:* multi-system transactions (payment + inventory +
  email), workflows that touch external services.

### F13 — Save-what-you-can partial commit

Action partially failed → save the successful parts and surface the
failures rather than reverting everything.

- *Framework needs:* the action body itself decides what to commit
  vs discard, often via try/catch within the body (so the body
  returns normally with partial state).
- *Common for:* form drafts, multi-step wizards, autosave.

### F14 — Forgiving timeout

Long action exceeded timeout → ask user "still wait?" → keep waiting
or give up.

- *Framework needs:* timeout primitive; ability to *extend* a
  timed-out action vs cancelling it; UI hook fired on timeout.
- *Common for:* long-running operations (uploads, video processing,
  AI generation).

### F15 — Try-with-fallback

Action 1 fails → automatically try action 2 with different strategy
→ commit whichever succeeds.

- *Framework needs:* failure-as-data (so app can route on the failure
  reason); ability to chain actions where the second is conditional
  on the first's failure.
- *Common for:* multi-provider auth, fallback rendering paths,
  graceful degradation.

### Cross-cutting observations

Across these fifteen patterns:

- **Most need to distinguish failure reasons.** F1/F2/F3/F4/F5/F6/F9
  all want to know "what kind of failure was this" to decide their
  response. A flat "the action threw" event isn't enough.
- **Several need failure metadata beyond the error.** F2 wants
  per-field validation; F6 wants the conflicting server state; F11
  wants timing and request ID; F12 wants which step failed.
- **Some need retry as a distinct concept.** F1/F3/F5/F9 all use
  "re-run the same action body" with different policies. Without a
  retry primitive, every app re-implements this from scratch.
- **Some need persistence across discard.** F5 (offline queue), F9
  (re-auth retry), F12 (compensating rollback) need to preserve the
  failed action's data across the discard boundary.
- **Failure is rarely silent.** F10 is the exception; most failures
  surface to the user in some form. The framework's job isn't to
  decide how — it's to make the decision *possible*.

## The kinds of failure that actually happen

Different failures have different shapes, different recoverability,
different user-actionability. The patterns above span them; this
section names the categories themselves.

**Environmental failures.** Network unreachable, timeout, connection
dropped, rate-limited, server 5xx. Typically *transient* (retry might
succeed). Not user-actionable beyond "wait and retry." Often
appropriate for auto-retry with backoff.

**Domain failures.** Validation rejected (4xx), authorization denied
(401/403), concurrent-edit conflict (409). The server understood the
request and refused on domain grounds. Usually *user-actionable*:
fix the input, log in again, resolve the conflict. Auto-retry is
inappropriate (the failure will recur).

**Lifecycle failures.** User cancelled, newer action superseded,
deadline expired. Not really "failures" in the error sense — the
speculation didn't run to completion because the *intent changed*
(or the lifecycle ended). No error to surface; no retry to offer.

**Programmatic failures.** JS bug in the action body — unexpected
exception, null reference, type error. Usually a developer concern,
not a user concern. Should typically be logged and surfaced for
debugging.

**Composite / partial failures.** Bulk operations where some items
succeeded and some failed. Each item's failure has its own category
(some may be domain, some environmental). Aggregate handling is
typically per-item, then a summary at the bulk level.

**Pre-condition failures.** Action's prereqs weren't met
([Q14](./questions.md#q14--action-prereqs--standing-state-handle));
the action body never ran. Distinct from "ran and failed" — the user
should know "we didn't try because X" rather than "we tried and
failed because X."

**Out-of-band failures.** Client crashed, page closed, browser
killed the tab. The action was in flight; we never got to report
success or failure. From the next page-load's perspective, the
action's state is *unknown* — server may have committed, may not
have. Different from any of the above because pulse can't even
observe this directly.

These categories aren't always crisp at the boundaries (is a server
timeout environmental or domain? depends on whether the request was
even received). But they map cleanly to *response patterns*: the
right thing to do on a 5xx is different from the right thing on a
422 is different from "the user cancelled." The framework should
preserve enough information to let the application route on these
categories.

## What pulse currently has, and what's missing

**What pulse has today:**

- Action body throws → action driver catches → `closeScope(S,
'discard')`.
- Per
  [Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy):
  scope cleanups fire on discard only (commit is success, no cleanup).
- Action handle exposes `.status: 'open' | 'committed' | 'discarded'`
  ([Q6](./questions.md#q6--what-is-a-scope-as-a-value)).
- The handle's completion promise (implied; not yet pinned in detail)
  rejects with the error on failure.

That's it. Functional minimum; nothing more.

**What's missing for the patterns above:**

- **No distinction between discard causes.** F4/F6/F9 want to fire
  failure-specific UX; can't tell from `scope.status === 'discarded'`
  whether the action threw, the user cancelled, or supersession
  killed it.
- **No structured failure metadata.** F2 (per-field validation), F6
  (conflicting state), F11 (diagnostic context) all need richer
  failure-data than a single `Error` object would naturally carry.
  Apps can wrap, but the framework provides no guidance.
- **No retry primitive.** F1/F3/F5/F9 all need "re-run the same body."
  Apps manually re-call `action(fn)` with the same body, losing the
  action handle's identity (a new handle each time, complicating
  retry-policy tracking).
- **No lifecycle hooks per cause.** F4 wants `onFailure(err)` distinct
  from `onCancel()`; F8 wants `onAnyDiscard()` to count failures for
  degraded-mode detection. Currently only `onCleanup` exists, firing
  uniformly on discard.
- **No partial-commit primitive.** F7 wants "8 of 10 committed; 2
  discarded." Pulse's writeSet is per-action all-or-nothing. The
  workaround is per-item nested actions, which works but every bulk
  operation re-implements the pattern.
- **No "force commit despite failure."** F13's "save what you can" is
  doable via try/catch in the action body — the body decides to
  return normally despite errors — but every body re-implements the
  pattern.
- **No queueing / persistence.** F5 (offline) and F9 (re-auth)
  need the failed action's body + inputs preserved across discard,
  retriable later. Pulse discards the action; the closure may still
  be referenceable but there's no framework support for "re-run this
  in 5 minutes" or "re-run after re-auth."
- **No failure timeout / deadline.** F14 needs "action exceeded N
  seconds" as a first-class event. Apps can build this with `Promise.race`
  in the action body but it's manual.
- **Cancellation as failure to action body.** When user calls
  `handle.discard()` while the body is parked on `yield*`, the body
  shouldn't resume *at all* (current pattern: discard-guard on
  resume). But the body has no way to distinguish "I was discarded
  because I failed" from "I was discarded because user cancelled" —
  it doesn't get to handle either, it just stops.

## How existing frameworks handle failure

For reference, not authority. Each framework has its own approach;
none is obviously right for pulse.

**React modern.**

- Server Actions return either an error object or success result via
  `useActionState`. Inside the action body, `try/catch` around
  `await` is the standard idiom; un-caught errors propagate to the
  framework.
- `useTransition`'s `isPending` flips false on either success or
  failure; the app reads the returned state to detect which.
- `useOptimistic` reverts implicitly when the parent doesn't update
  the value — failure-handling is "the parent re-renders with the
  same `value` it had before, so the optimistic value disappears."
  No explicit failure callback.
- No framework-provided retry; apps build their own (often via
  manually re-invoking the Action).
- No distinction between cancellation, supersession, and error at
  the framework level. Apps disambiguate via their own status
  tracking.

Reference: [`../async/deep-dives/react-modern.md`](../async/deep-dives/react-modern.md).

**Solid 2.x.**

- `action()` body is a generator; throws propagate via the iterator;
  the action's promise rejects.
- `createOptimistic` reverts unconditionally at transition completion
  — whether the transition succeeded or failed. (The pattern: write
  both the overlay and the committed source; on failure, only the
  overlay reverts.)
- Identity-based stale-discard for async: `_inFlight !== result`
  silently drops superseded async resolutions.
- No retry primitive; user reconstructs the action.
- No first-class failure categorization; the thrown error is just a
  JS exception.

Reference: [`../async/deep-dives/solid-2x.md`](../async/deep-dives/solid-2x.md).

**Svelte 5.**

- `OBSOLETE` symbol: rejected promise from a superseded async derived;
  the handler early-returns and the resolution is silently swallowed.
- `STALE_REACTION`: thrown when an effect is aborted; also swallowed.
- Errors funnel via `ERROR_VALUE` flag on signals; when a consumer
  later reads the errored signal, the read throws; the throw
  propagates to the nearest `<svelte:boundary>` with a `failed`
  snippet for UI handling.
- `fork()` reverts the batch's mutations on throw.
- No retry primitive; user re-invokes.

Reference: [`../async/deep-dives/svelte-5.md`](../async/deep-dives/svelte-5.md).

**Common patterns across frameworks:**

- *None* distinguish cancellation / supersession / error at the
  framework level. All three look like "the speculation ended without
  committing"; apps disambiguate by their own state.
- *None* provide a retry primitive. Apps reconstruct.
- *None* model failure as typed data; everything is a JS exception
  with whatever payload the action body throws.
- *All* assume the application owns the UX side of failure.

So the field hasn't converged on a richer model. Pulse has room to
pick something better, but the priority isn't catching up — it's
deciding what would actually help apps without bloating the primitive.

## The application / framework split

Most failure patterns above are *application UX choices*. Whether to
retry, how to surface the error, when to switch to degraded mode,
how to render a conflict-resolution dialog — these are app-specific
decisions the framework can't make.

But the framework controls the *information available* to make those
decisions. Without framework support, every app re-implements:

- Tracking which discards were errors vs cancellations.
- Wrapping errors with category metadata.
- Counting retries per action.
- Distinguishing "should retry" failures from "shouldn't retry"
  failures.
- Preserving action bodies for re-execution.

The right split feels like: **framework provides the information and
the lifecycle hooks; apps and libraries provide the strategies.**

Concretely:

*Framework provides:*

- Discard cause categorization (failure / cancelled / superseded /
  timeout) on the action handle.
- Failure payload preserved on the handle (the thrown error or
  structured failure data).
- Lifecycle hooks per cause (`onFailure(err)`, `onCancel()`,
  `onSettle((cause, err?) => …)`).
- A retry primitive (`handle.retry()`) that re-runs the same body in
  a fresh scope, preserving handle identity for retry-counting.
- Cancellation distinguished from failure in the handle's completion
  promise.

*Apps and libraries provide:*

- Retry policies (auto-retry with backoff is library code, possibly
  ergonomic helper like `withRetry(action, policy)`).
- Failure categorization (apps know "this is a network error" vs
  "this is a validation error" because they know their backend).
- Queue-for-later mechanics (offline support is library code, possibly
  with persistence integration).
- Conflict resolution UI (entirely application-specific).
- Partial-commit semantics (per-item nested actions, with app-level
  coordination for the summary).
- Degraded-mode detection (app-level state machines aggregating
  framework failure events).
- Error-toast wiring (design system / app code).
- Diagnostics tooling (dev-mode helpers or app instrumentation).

This split keeps the framework's API surface small while making every
listed pattern *expressible*. No pattern requires the framework to
encode opinions about retry strategy or queueing or merge semantics
— those live where they should, in app or library code.

## Candidate framework primitives

The minimum-viable set, ordered by leverage:

### 1. Discard cause categorization

The single biggest leverage: extend the action handle (and possibly
scope state) to carry *why* the discard happened.

```ts
type DiscardCause =
	| { kind: 'failure'; error: unknown }
	| { kind: 'cancelled' } // user called .discard()
	| { kind: 'superseded'; by?: ActionHandle } // another action took over
	| { kind: 'timeout' } // deadline expired
```

Handle exposure:

```ts
const handle = action(fn)
// ...
handle.status // 'open' | 'committed' | 'discarded'
handle.discardCause // DiscardCause | undefined (defined when status === 'discarded')
```

This is the load-bearing addition. Every other pattern depends on
the framework distinguishing these cases.

Implementation cost is tiny — the scope already tracks `status`; add
a `discardCause` field populated by whichever code path closed the
scope.

### 2. Lifecycle hooks per cause

Building on (1):

```ts
handle.onFailure((err) => /* error-specific UX */)
handle.onCancel(() => /* cancellation UX */)
handle.onSettle((cause) => /* common-to-all handler */)
handle.onCommit(() => /* success UX */)
```

These are sugar over `handle.completion.then/.catch`, but the
typed-cause discrimination is what makes F4 (failure-specific toast)
and F8 (degraded-mode counter) cleanly expressible.

Note this interacts with
[Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)
— pulse's `scope.cleanups` currently fire on discard only. The
hooks above fire conditional on cause, which is finer-grained. Both
mechanisms can coexist (`onCleanup` for scope-level resources;
`onFailure`/`onCancel`/`onCommit` for action-level UX).

### 3. Retry primitive

```ts
handle.retry() // re-run the same action body in a fresh scope
```

The retry runs the original body again. The handle's identity is
preserved so retry-counting libraries can track per-handle attempt
history. The fresh scope is opened at the same parent as the
original (typically ROOT).

Open sub-questions: does retry produce a new handle or reuse the
original (with a bumped attempt counter)? Lean: reuse the handle —
the user said "retry *this* action," not "make a new action that
happens to be like this one." Same handle, new scope, new attempt.

### 4. Cancellation distinguished from failure in `completion`

```ts
const handle = action(fn)
try {
	await handle.completion
} catch (err) {
	if (err instanceof CancellationError) {
		/* user cancelled; not a failure */
	} else {
		/* actual failure */
	}
}
```

`handle.completion` resolves on commit, rejects with the thrown error
on failure, rejects with `CancellationError` on cancellation, rejects
with `SupersededError` on supersession. The discriminating subclasses
let the caller route without inspecting `handle.discardCause`
separately.

Alternative: `handle.completion` always resolves (never rejects); the
caller checks `handle.status` and `handle.discardCause`. Cleaner
type-wise but breaks the `await handle.completion` ergonomic.

Lean: typed-rejection — keep the await idiom; users who want to
distinguish use `instanceof` or read `handle.discardCause`.

### 5. Action body access to the cause-of-cancellation

When the body is parked on `yield*` and the action gets discarded
(user cancel or supersession), the body doesn't get to "clean up
gracefully" — the discard-guard pattern just stops the body. But for
some cases (releasing an external lock, aborting an HTTP fetch),
the body needs to *do something* on cancellation.

One approach: the body can register an `onCancel` cleanup that fires
on cancellation:

```ts
action(function* () {
	const ctrl = new AbortController()
	onCancel(() => ctrl.abort())
	yield* fetchWithSignal(url, ctrl.signal)
})
```

This is per-body convenience, similar to existing `onCleanup`. The
cleanup-on-cancel hook fires when the body's enclosing scope is
discarded with `kind: 'cancelled'`.

Could be folded into existing `onCleanup` (which fires on any
discard) with a `cause` argument: `onCleanup((cause) => { if
(cause.kind === 'cancelled') ctrl.abort() })`. Either shape works.

## Sub-questions still open

- **Failure-payload shape.** Should pulse standardize the failure
  payload (`{ kind, error, attempt, source, ... }`) or just preserve
  the thrown value as-is? Lean: preserve as-is for primary, but
  provide a `FailureContext` object accessible via the handle that
  carries metadata (attempt count, timing, etc.).
- **Cause categories beyond the four named.** Are
  failure / cancelled / superseded / timeout the right set, or do
  we need more (`preconditionFailed`, `clientCrashed`, etc.)?
  Lean: start with four; extend if usage forces.
- **Retry semantics with mutable closure state.** The action body
  closes over variables. Retry uses the closure as-is — meaning if
  those variables changed since first execution, the retry sees the
  new values. Surprising? Or expected (the user wants the latest
  state)? Probably the latter, but worth flagging.
- **Retry with mutated inputs.** F1's "retry button" sometimes wants
  to retry with the *same* inputs; sometimes (F2 fix-and-resubmit)
  wants different inputs. The latter is just a new action, not a
  retry. Lean: `handle.retry()` = same body, same closure, no input
  changes. Different-input cases construct a new action.
- **Retry-counting.** Should the handle expose `attempt: number`?
  Useful for backoff policies and degraded-mode detection. Cheap to
  add; lean yes.
- **`onSettle` versus `onCleanup`.** These are different mechanisms
  (action-level UX hooks vs scope-level resource cleanup) but they
  could be unified. Q12 has the related question.
- **Persistence for queue-for-later (F5).** Pulse doesn't have a
  built-in mechanism to serialize a failed action and re-instantiate
  it later. Outside the framework's scope for now; library territory
  if/when offline-first patterns are concretely needed.
- **Timeout primitives.** F14 wants a deadline; current pulse has
  none. Apps can build with `Promise.race` but it's manual. Worth
  considering a `withDeadline(action, ms)` library helper or a
  framework primitive.
- **Failure observability for `Q3` consumers.** Effects subscribing
  to a signal don't see action failure directly — they just see the
  signal's value not change (or revert). Should consumers have a way
  to observe "the last action on this signal failed"? Probably out
  of scope — application-level concern.

## Tentative recommendations

Per the application/framework split principle, the minimum-viable
ship set:

**1. Discard cause categorization.** Extend the action handle (and
scope state) to carry `discardCause: { kind: 'failure' | 'cancelled'
| 'superseded' | 'timeout', error?: unknown }`. Tiny addition;
unblocks every downstream pattern.

**2. Typed completion promise.** `handle.completion` resolves on
commit, rejects with the original error on failure, rejects with
`CancellationError` / `SupersededError` / `TimeoutError` on the
other discard causes. Preserves the `await` ergonomic; the typed
subclasses let callers route via `instanceof`.

**3. Per-cause lifecycle hooks.** `handle.onFailure(err =>
...)`, `handle.onCancel(() => ...)`, `handle.onSettle((cause) =>
...)`, `handle.onCommit(() => ...)`. These are library-level sugar
over the typed completion promise; ship them as default helpers.

**4. Retry primitive.** `handle.retry()` re-runs the same body in
a fresh scope; preserves handle identity; bumps an attempt counter.
This is the second-biggest leverage after (1) — covers the F1, F3,
F5, F9 patterns directly.

**5. Cancellation-aware cleanup.** `onCleanup((cause) => ...)`
accepts an optional cause argument so action bodies can branch on
why they're being cleaned up. Backwards-compatible with the
current `onCleanup(() => ...)` form (cause argument is just ignored).

**6. Defer everything else to libraries / apps.** Retry policies
(backoff, max-attempts, jitter), queueing, conflict resolution,
degraded-mode detection, error toasts, diagnostics — all
application or library territory. Pulse provides the primitives;
they provide the strategies.

The crux: most app-level failure UX patterns are *expressible
today with the additions above* without further framework changes.
The framework's job is to expose enough information about failure
that apps don't have to manually instrument every action body to
track its own discard causes.

**6. Revisit when usage data exists.** Like the other exploration
docs, these recommendations are informed by scenario reasoning and
existing-framework survey, not by usage data. Once pulse ships and
apps are built, the candidate set may need extending (queueing
primitives? partial-commit primitives? timeout helpers?) or trimming
(if some additions don't earn their keep). The minimum-viable set is
correct *as a starting point*, not as a final spec.
