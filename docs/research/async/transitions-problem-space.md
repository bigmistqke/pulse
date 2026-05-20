# Transitions — the problem space

**Status:** problem-space map, not a design. Catalogs the concrete async failure
modes a transition mechanism exists to prevent, with worked examples. It does not
propose pulse's transition API — that synthesis lives in
[`pulse-design-direction.md`](./pulse-design-direction.md). This doc is the *what
goes wrong*; that doc is the *what pulse does about it*.

**Origin:** session 13 (2026-05-20) design conversation. The conversation
re-grounded "are full-scale transitions necessary?" to first principles; this doc
captures that re-grounding as a durable artifact.

**Relationship to [`../scenarios/concurrent-flows.md`](../scenarios/concurrent-flows.md):**
that doc catalogs the same design space through a *transaction / shadow-write*
lens — scenarios S1–S8 with capability columns (snapshot isolation, atomic
commit, entanglement). This doc uses a *transitions* lens, organized by
user-visible failure mode. The two overlap heavily (concurrent-flows S3 ≈ FM1
torn state here; S1 / S7 ≈ FM4 uncommittable speculation here) and should stay
consistent; neither subsumes the other.

---

## What a transition is

One sentence:

> A transition makes a state change that involves async work **commit
> atomically** — the UI moves from one coherent state to another coherent state,
> never showing an incoherent in-between — while **staying responsive** during
> the wait.

Two clauses, both load-bearing:

- **Coherent → coherent, never torn.** A logical change ("navigate to bob's
  profile") often fans out into several async fetches. The UI must not render
  frames where some fetches have landed and others haven't.
- **Responsive during the wait.** The user can keep typing, clicking, and
  navigating while the async work is in flight. The committed-but-stale view
  stays live; it does not freeze.

Everything else — optimistic updates, priority lanes, entanglement detection,
snapshot isolation — is elaboration on top of those two clauses.

---

## The four failure modes

What goes wrong *without* a transition mechanism. Each is a distinct
user-visible defect; a transition mechanism is judged by how completely it
prevents all four. Each failure mode below closes with the **dimensions** of
transitions it exercises — a four-way structural decomposition (Dim 1 internal,
Dim 2 concurrent, Dim 3 input-arrival, Dim 4 state-overlap) defined canonically
in the lexicon, [`CONTEXT.md`](./CONTEXT.md), and analysed in
[Cross-cutting](#cross-cutting-the-four-dimensions) below. Code examples are
pulse-flavored (`signal` returns `[Accessor, Setter]`; `computed` whose body
returns a Promise is an async derivation, read through `use()` and gathered by
`<Loading>`).

### FM1 — Torn state

**Setup.** A profile page. A route change sets `userId`; three independent async
derivations read it:

```ts
const [userId, setUserId] = signal('alice')

const profile   = computed(() => api.getProfile(userId()))    // ~80ms
const followers = computed(() => api.getFollowers(userId()))  // ~150ms
const posts     = computed(() => api.getPosts(userId()))      // ~400ms
```

The page renders all three: a header from `profile`, a count from `followers`, a
list from `posts`.

**What goes wrong.** The user navigates alice → bob: `setUserId('bob')`. All three
fetches re-fire and resolve at different times. If each derivation writes to the
DOM the instant it resolves:

```
t=0ms     setUserId('bob') — all three go pending
t=80ms    profile resolves   → header flips to BOB
t=150ms   followers resolves → count flips to BOB's
t=400ms   posts resolves     → list flips to BOB's
```

For the 320ms window between t=80 and t=400 the page is a **chimera**: bob's name
and avatar above alice's posts. A screenshot of t=200ms looks like a
data-integrity bug. If the fetches resolve in a different order (`posts` first),
it is worse — the header still says "alice" while her post list has already been
replaced by bob's.

**What "correct" means.** The page stays entirely on alice — the last coherent
committed state — until all three of bob's fetches have resolved, then flips to
entirely-bob in a single commit. No frame ever mixes the two users.

**Dimensions exercised.** Dim 1 (internal branching), and only Dim 1. One logical
change, a tree of dependent async, gathered and committed together. This is the
irreducible core of what a transition is for.

### FM2 — Spinner flash

**Setup.** Same profile page. The user navigates alice → bob, but bob's data is
warm in an HTTP cache: all three fetches resolve in ~30ms.

**What goes wrong.** A boundary that drops to a loading fallback the instant *any*
derivation goes pending produces:

```
alice's page → [loading spinner, 1 frame] → bob's page
```

The spinner appears and vanishes within ~30ms. The flash is more jarring than
the alternative — holding alice's fully-rendered page for 30ms, then flipping
straight to bob's. Show-spinner-then-content is strictly worse than
just-show-content-30ms-later.

**The symmetric defect.** The fallback flashing *away* too fast is the same
problem in the other direction: a genuine first-load fallback shown for one frame
before the fetch resolves flickers just as badly. React's one timer in this area
addresses exactly that — once a fallback is shown it is kept visible for ≥300ms
([`deep-dives/react-modern.md`](./deep-dives/react-modern.md), "Suspense
fallbacks are throttled at ≥300ms"). It is a fallback-visibility *minimum*, not a
hold-prior *maximum*: no production transition mechanism has a "hold prior
content for N ms, then drop to the fallback" timer. During a transition, React,
Solid, and Svelte all hold the prior coherent state *indefinitely* — until the
new state is ready or the transition is superseded. Stale content held for a long
time is surfaced with an inline in-progress indicator (`isPending`), not resolved
by auto-flipping to a fallback.

**What "correct" means.** During the gather, keep displaying the last coherent
committed state ("hold-prior") for as long as the work takes; surface a long wait
with an inline pending indicator. Drop to a fallback only when there is no prior
coherent state to hold — a genuine first load — and once a fallback is shown,
keep it visible long enough that it does not itself flash away.

**Dimensions exercised.** Dim 1. But note the dependency this surfaces:
hold-prior requires the mechanism to answer *"is there a prior coherent state
for this content?"* — a question about the *content's* history. That question
becomes the crux of "Where pulse stands today" below.

### FM3 — Lost interactivity

**Setup.** A typeahead search. A `query` signal; a `results` derivation that
fetches from it:

```ts
const [query, setQuery] = signal('')

const results = computed(() => api.search(query()))  // ~250ms each
```

The search input writes `query`; a list below renders `results`.

**What goes wrong.** The user types `r`, `re`, `rea`, `reac`, `react` — five
keystrokes over ~600ms. Each keystroke changes `query` and puts `results`
pending. Two distinct things break:

- **The results area strobes.** If each keystroke replaces the list with a
  spinner, the area below the cursor flickers spinner → list → spinner → list as
  the user types. The old `rea` results — still perfectly useful context — are
  thrown away the instant the next keystroke lands.
- **Focus loss.** If the search input is *inside* the boundary that drops to a
  fallback, the input element itself unmounts when the fallback shows. The user
  loses focus and cursor position mid-word.

**What "correct" means.** The input stays mounted, focused, and responsive for
the entire 600ms. The previous results stay visible — and scrollable, clickable —
while the next query loads. The committed state remains *live*; the pending work
happens in the background without seizing the UI.

**Dimensions exercised.** Dim 1 (each keystroke is its own gather) + Dim 3
(input-arrival): keystroke 5 arrives while keystroke 4's transition is still in
flight; the newer input must pre-empt, and keystroke 4's result must not be shown
if it lands after keystroke 5's. If stale transitions are not cancelled, also
Dim 2 (concurrent) — up to five `api.search` calls in flight at once, four of
them already irrelevant.

### FM4 — Uncommittable speculation

**Setup.** Two flavors of the same structural need.

*(a) Mind-change mid-flight.* A list with a "Show archived" toggle; flipping it
refetches the list.

```ts
const [showArchived, setShowArchived] = signal(false)

const list = computed(() => api.getItems({ archived: showArchived() }))  // ~300ms
```

*(b) Deliberate preview.* A settings panel with a "Preview" button that shows the
dashboard as it *would* look with candidate settings, before "Apply" commits
them.

**What goes wrong.**

- *(a)* The user toggles on → off → on within 200ms. Three transitions start. If
  transition #1 (`archived: true`) commits 300ms later — by which point the user
  is back on `false` then `true` again — the committed list briefly contradicts
  the toggle. Worse, if a transition writes its in-progress results directly into
  the committed `list` signal, there is no clean way to *back out* a transition
  the user has already superseded.
- *(b)* If "Preview" mutates the real settings signals, then everything else
  reading those signals (analytics, autosave, other panels) reacts as though the
  settings genuinely changed. "Cancel" then has to reconstruct the prior state by
  hand.

**What "correct" means.** A transition's in-progress state is **discardable** —
it can be abandoned without corrupting committed state, and without anything
outside the transition's scope observing it. A superseded transition is discarded
silently. A cancelled preview leaves committed state untouched because it was
never written.

**Dimensions exercised.** Dim 2 (concurrent — toggle #2 starts before #1
settles) + Dim 4 (state-overlap — every toggle's transition targets the same
`list` signal, so they must be ordered or discarded relative to each other) +
the discardability requirement, which cuts across both.

---

## Cross-cutting: the four dimensions

The failure modes above are *symptoms*. The **four dimensions** are the
structural axes a transition mechanism branches along — defined canonically in
the lexicon ([`CONTEXT.md`](./CONTEXT.md)); the framing originated in the
[`LOG.md`](./LOG.md#cross-cutting-thread--transitions-branch-in-four-dimensions) thread "Transitions branch in four dimensions." Each failure
mode exercises a different subset:

| Failure mode                  | Dim 1 internal | Dim 2 concurrent | Dim 3 input-arrival | Dim 4 state-overlap |
|-------------------------------|:--------------:|:----------------:|:-------------------:|:-------------------:|
| FM1 Torn state                | core           | —                | —                   | —                   |
| FM2 Spinner flash             | yes            | —                | —                   | —                   |
| FM3 Lost interactivity        | yes            | if uncancelled   | yes                 | —                   |
| FM4 Uncommittable speculation | yes            | yes              | yes                 | yes                 |

The dimensions (canonical definitions in [`CONTEXT.md`](./CONTEXT.md); recapped
here for reading flow):

- **Dim 1 — internal branching.** A single transition contains a *tree* of
  dependent async work. The mechanism gathers all of it and commits together.
  (FM1 is pure Dim 1.)
- **Dim 2 — concurrent transitions.** More than one transition in flight at the
  same time.
- **Dim 3 — input-arrival priority.** New input arrives *during* a transition;
  the newer intent should pre-empt or supersede the older.
- **Dim 4 — state-overlap (entanglement).** Two transitions touch the same
  state, so their commit order — or mutual discard — matters.

**The load-bearing observation.** Dim 1 *is* the motivation. A transition exists
to gather the async work of one logical change and commit it atomically — that is
FM1, and FM2 is just FM1's display policy during the wait. **Dims 2, 3, and 4
only exist because you might allow more than one transition at once:**

- Dim 2 — two logical changes in flight simultaneously.
- Dim 3 — one should pre-empt the other.
- Dim 4 — two of them touch the same state.

If a framework permits only one transition at a time, Dims 2–4 collapse and only
Dim 1 remains. This is why "do we need *full-scale* transitions?" is a real
question and not a rhetorical one — it is precisely the question of whether pulse
needs Dims 2–4 or only Dim 1.

A further nuance: even with concurrent transitions, *most* concurrent transitions
touch disjoint state. (FM3's five keystrokes all target `results` — overlapping;
but a "follow user" action and a "save post for later" action target nothing in
common — disjoint.) Disjoint concurrent transitions are handled by trivial
machinery — N independent Dim-1 gathers. The genuinely hard machinery (Dim 4
entanglement, Dim 3 priority) only earns its cost when concurrent transitions
*overlap* or need *ordering*.

---

## Where pulse stands today

Pulse already solves Dim 1. The `<Loading>` boundary (`src/dom/loading.ts`) is a
Dim-1 gather:

- Child bindings register pending / ready state with the boundary (`pendingSet`,
  `readySet`, `deferredCommits`).
- The gate opens — all commits flush atomically via `flushAll()` — only when
  `pendingSet.size === 0` and something is ready. That is FM1 prevented: no
  binding commits until every sibling binding in the boundary is settled.
- Hold-prior (FM2) is implemented: when pending and previously-loaded, the
  boundary keeps showing the loaded subtree rather than the fallback
  (`loading.ts:149-153`).

So pulse serves the *core* of what transitions are for. What it does **not** have
is any Dim 2/3/4 machinery — concurrent named transitions, priority,
entanglement.

**The known fragility — boundary-lifecycle coupling.** The hold-prior decision
(FM2) depends on `hasEverLoaded`, a closure variable owned by the *boundary*
(`loading.ts:142`). It flips true the first time that boundary observes pending
drop to false. This couples a property of the *content* to the lifecycle of the
*boundary*:

- A `<Loading>` boundary mounted *after* the signals it wraps have already
  resolved starts with `hasEverLoaded === false`.
- When those signals next go pending (a refetch), the freshly-mounted boundary
  treats it as **first load** and shows the fallback — even though the content
  has been resolved for a long time and the user reasonably expects hold-prior.
- Same children, same signals, different mount timing → different behavior. A
  refactor that adds a wrapper, a conditionally-mounted boundary, or a remount
  all trigger it.

The defect is that "has this content ever been coherent?" is a property of the
*signals*, not of the boundary observing them. Tracking it on the boundary makes
a render decision depend on mount timing, which users cannot predict. This is the
"temporary solution" character of the current mechanism: it maps the lifecycle of
async state onto the lifecycle of the `<Loading>` boundary.

The proposed fix — move the "has ever committed" property onto the signal itself
(its value-bag) so any boundary asking gets the same answer — is worked out in
[`pulse-design-direction.md`](./pulse-design-direction.md) under "the
late-mounted `<Loading>` edge case." It is noted here only to mark *which* failure
mode the current implementation handles fragilely: FM2's hold-prior.

---

## Deliberately out of scope

- **Pulse's transition API.** This doc maps the problem;
  [`pulse-design-direction.md`](./pulse-design-direction.md) holds the candidate
  solution (the node / value-bag framing, the `scope()` primitive sketch).
- **Whether pulse should support Dims 2–4 at all.** That is the live design
  decision — `pulse-design-direction.md` Q2 (concurrent), Q3 (priority), Q4
  (state-overlap). This doc only establishes that Dim 1 is mandatory and
  Dims 2–4 are optional elaboration, so the decision is real.
- **Transaction / optimistic-UI framing.** The overlapping-but-distinct lens —
  snapshot isolation, atomic commit across multi-step server flows, optimistic
  reconciliation — is catalogued in
  [`../scenarios/concurrent-flows.md`](../scenarios/concurrent-flows.md) S1–S8.

---

## Cross-references

- [`CONTEXT.md`](./CONTEXT.md) — the research lexicon: canonical definitions of
  the four dimensions, the four failure modes, and the core transition terms
  this doc uses.
- [`pulse-design-direction.md`](./pulse-design-direction.md) — the synthesis:
  four-dimensions framing, node / value-bag decomposition, the `<Loading>`
  late-mount fix, open questions Q1–Q9.
- [`../scenarios/concurrent-flows.md`](../scenarios/concurrent-flows.md) — the
  same design space through the transaction / shadow-write lens; scenarios S1–S8
  with capability columns and policy questions Q1–Q5.
- [`LOG.md`](./LOG.md#cross-cutting-thread--transitions-branch-in-four-dimensions)
  — cross-cutting thread "Transitions branch in four dimensions."
- `src/dom/loading.ts` — pulse's current Dim-1 gather; the `hasEverLoaded`
  fragility is at line 142.
