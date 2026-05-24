# Pulse — scenario traces

End-to-end traces of architecturally-distinct cases through pulse's engine

- library. Each trace walks every engine call and state change for one
  scenario from the [catalog](./scenarios.md), verifying the framings (or
  falsifying them when they break).

**Companion documents:**

- [scenarios.md](./scenarios.md) — the catalog itself (TDD basis).
- [README.md](./README.md) — framings, falsified hypotheses, engine /
  library sketches, open questions, threads.

**All eight traces below pass.** No framings falsified. Two scenarios
forced deliberate design calls into the open (K1 → resolved to Position
(C); H3 → Policy α for effect chains, lean).

> **Note on terminology.** Traces use the resolved
> [Q1](./questions.md#q1--fall-through-and-edge-policy) framing — **Model 1
> (engine-managed chains)**: edges are plain `(source, target)` pairs;
> on a write, the engine derives the chain from each edge's target slot
> (`chainFor(edge.target.scope)`), checks whether `writeScope` is in
> the chain and not shadowed by a more-specific slot, and fires if so.
> Earlier drafts used a selector-on-edge sketch (Model 2); the
> behaviour is identical, only the locus of the predicate differs.

**Related pulse-repo docs:**

- [`../async/CONTEXT.md`](../async/CONTEXT.md) — speculation lexicon, four dimensions, failure modes.

## Contents

- [`doubleName` under scope `S`](#doublename-under-scope-s) — exercises A2, B1, B2.
- [C2 — action body with async read](#c2--action-body-with-async-read) — exercises C2a, C2b, C2c, C2d.
- [H1a-c — effect under speculation](#h1a-c--effect-under-speculation) — exercises H1a, H1b, H1c.
- [K1 — re-entrant setter mid-recompute](#k1--re-entrant-setter-mid-recompute) — exercises K1a, K1b.
- [G2 — nested actions and commit promotion](#g2--nested-actions-and-commit-promotion) — exercises G1, G2, G3, G4.
- [H3 — cleanup chains across speculative effect runs](#h3--cleanup-chains-across-speculative-effect-runs) — exercises H3 (a, b, b').
- [C2e — post-yield derived read (async K1b analogue)](#c2e--post-yield-derived-read-async-k1b-analogue) — exercises C2e.
- [H1d — effect-body coherence on commit](#h1d--effect-body-coherence-on-commit) — exercises H1d.

---

## `doubleName` under scope `S`

A worked trace verifying the resolved architecture
(Q1 Model 1 + Q6 scope-centric storage + Q9 writeSet/readSet + Q10
deferred-fires region + P6 pull-driven reads) against the case the
[falsified hypothesis](#speculation-purely-above-unmodified-r3-doesnt-work)
broke on. Walks every engine call and every state change.

### Setup

```ts
const [name, setName] = signal('foo')
const doubleName = compute(() => get(name) + get(name))
```

- `signal("foo")` → library calls `createNode<string>(() => "foo")` →
  engine creates Node `name = { defaultRecipe: () => "foo", subs: ∅ }`.
  Returns `[name, setName]` where `setName(v)` calls
  `writeSlot(name, getCurrentScope(), { recipe: () => v, cached: v, deps: [] })`
  and adds `name` to `scope.writeSet`.
- `compute(fn)` → library calls `createNode<string>(fn)` → engine creates
  Node `doubleName = { defaultRecipe: fn, subs: ∅ }`.

**Initial state:**

```
name        = { defaultRecipe: () => "foo", subs: ∅ }
doubleName  = { defaultRecipe: () => get(name) + get(name), subs: ∅ }

ROOT = Scope {
  parent: undefined, children: ∅,
  slots: ∅, edges: ∅,
  writeSet: ∅, readSet: ∅,
  cleanups: [], status: 'open',
}
```

### Step 1: `get(doubleName)` outside any action

- Library: `scope = ROOT` (no action active). `scope.readSet.add(doubleName)`.
  `currentTracker = null` → no `link`. `invoke(doubleName, ROOT)`.
- Engine: chain-walk for an existing slot — `ROOT.slots.has(doubleName)`? No.
  Miss. Create `slot_DN_R = { recipe: doubleName.defaultRecipe, deps: [] }`.
  Push `currentTracker = slot_DN_R`. Run recipe under ROOT.
  - Recipe: `get(name) + get(name)`.
  - First `get(name)`:
    - `scope.readSet.add(name)`.
    - `currentTracker = slot_DN_R` → `link(name, slot_DN_R)`:
      - `edge1 = { source: name, target: slot_DN_R, targetScope: ROOT }`
      - `name.subs.add(edge1)`; `ROOT.edges.add(edge1)`;
        `slot_DN_R.deps.push(edge1)`.
    - `invoke(name, ROOT)`: `ROOT.slots.has(name)`? No. Create
      `slot_N_R = { recipe: () => "foo", deps: [] }`. Run recipe → `"foo"`.
      `slot_N_R.cached = "foo"`. `ROOT.slots.set(name, slot_N_R)`. Return `"foo"`.
  - Second `get(name)`:
    - `scope.readSet.add(name)` — no-op (already present).
    - `link(name, slot_DN_R)` — dedup: `name.subs` already has an edge with
      `target === slot_DN_R`; skip.
    - `invoke(name, ROOT)`: hit, return cached `"foo"`.
  - Recipe returns `"foofoo"`. `slot_DN_R.cached = "foofoo"`.
    `ROOT.slots.set(doubleName, slot_DN_R)`. Pop tracker.
- Return `"foofoo"`. ✓

**State after Step 1:**

```
name.subs       = { edge1 }
doubleName.subs = ∅

ROOT.slots      = { name → slot_N_R("foo"), doubleName → slot_DN_R("foofoo") }
ROOT.edges      = { edge1 }
ROOT.readSet    = { name, doubleName }
ROOT.writeSet   = ∅

edge1 = { source: name, target: slot_DN_R, targetScope: ROOT }
```

### Step 2: `action(function* () { … })` opens scope `S`

- Library: `S = openScope()`. Engine creates
  `S = { parent: ROOT, children: ∅, slots: ∅, edges: ∅, writeSet: ∅,
  readSet: ∅, cleanups: [], status: 'open' }`. `ROOT.children.add(S)`.
- Push `currentScope = S`. Driver begins.

### Step 3: `setName("bar")` inside the action

- Library: `scope = S`. `writeSlot(name, S, { recipe: () => "bar", cached:
  "bar", deps: [] })`. `S.writeSet.add(name)`.
- Engine: `S.slots.set(name, slot_N_S)`. Fire chain-match for each
  `edge ∈ name.subs`:
  - `edge1`: `targetScope = ROOT`, `chainFor(ROOT) = [ROOT]`. `writeScope = S`
    not in chain → **don't fire.** ✓ Committed state untouched.

**The falsified case.** Under unmodified r3 (single-slot), `setName` would
have invalidated `doubleName`'s only cache → corrupting committed state.
Under the resolved architecture: a new slot is created in `S.slots`, and the
chain-match correctly skips `edge1` because `S` is not in the target's chain.

**State after Step 3:**

```
name.subs       = { edge1 }  (unchanged)
S.slots         = { name → slot_N_S("bar") }
S.writeSet      = { name }
S.readSet       = ∅
S.edges         = ∅
ROOT unchanged.
```

### Step 4: `get(doubleName)` inside the action

- Library: `scope = S`. `scope.readSet.add(doubleName)`. `currentTracker =
  null` (action-body reads are imperative; per [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified)
  the action body doesn't re-run on dep change). `invoke(doubleName, S)`.
- Engine: `S.slots.has(doubleName)`? No. Miss. Create `slot_DN_S = { recipe:
  doubleName.defaultRecipe, deps: [] }`. Push `currentTracker = slot_DN_S`.
  Run recipe under S.
  - Recipe: `get(name) + get(name)`.
  - First `get(name)`:
    - `scope.readSet.add(name)`. (`S.readSet` now `{ doubleName, name }`.)
    - `currentTracker = slot_DN_S` → `link(name, slot_DN_S)`:
      - `edge2 = { source: name, target: slot_DN_S, targetScope: S }`
      - `name.subs.add(edge2)`; `S.edges.add(edge2)`;
        `slot_DN_S.deps.push(edge2)`.
    - `invoke(name, S)`: `S.slots.has(name)`? Yes — `slot_N_S` from Step 3.
      Return cached `"bar"`. ✓ (Reads inside the recipe pull the most-specific
      slot.)
  - Second `get(name)`: dedup; hit; return `"bar"`.
  - Recipe returns `"barbar"`. `slot_DN_S.cached = "barbar"`.
    `S.slots.set(doubleName, slot_DN_S)`. Pop tracker.
- Return `"barbar"`. ✓ (Per [P6](./framings.md#p6--pull-driven-reads-push-driven-consumers-no-explicit-flush):
  synchronous, no flush.)

**State after Step 4:**

```
name.subs        = { edge1, edge2 }
doubleName.subs  = ∅

S.slots          = { name → slot_N_S("bar"), doubleName → slot_DN_S("barbar") }
S.edges          = { edge2 }
S.readSet        = { doubleName, name }
S.writeSet       = { name }

ROOT unchanged (slot_DN_R still cached "foofoo", slot_N_R still "foo")

edge1 = { source: name, target: slot_DN_R, targetScope: ROOT }   // chain: [ROOT]
edge2 = { source: name, target: slot_DN_S, targetScope: S }       // chain: [S, ROOT]
```

### Step 5a: action returns → `closeScope(S, 'commit')`

Per [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires):
commit is a deferred-fires region. Per
[Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally):
walk `writeSet` for promotion; drop slots in `readSet` ∪ `writeSet`.

1. **Open deferred-fires region.** Subsequent `writeSlot` fires queue.

2. **Promote writeSet** in dep-order leaves-first. `S.writeSet = { name }` —
   one entry. Promote:
   `writeSlot(name, ROOT, { recipe: () => "bar", cached: "bar", deps: [] })`.
   `ROOT.slots.set(name, slot_N_R_new)`. `ROOT.writeSet.add(name)`.
   Fire chain-match for each `edge ∈ name.subs`:
   - `edge1`: `targetScope = ROOT`, `chainFor(ROOT) = [ROOT]`. `writeScope =
     ROOT` at index 0; no more-specific check needed. **Queue fire** for
     `slot_DN_R`.
   - `edge2`: `targetScope = S`, `chainFor(S) = [S, ROOT]`. `writeScope =
     ROOT` at index 1. More-specific check: `name.slots.has(S)`?
     At this moment `S.slots[name]` still exists (we haven't dropped yet).
     **Skip.** ✓ (S's own consumer doesn't get a spurious fire for its
     own write being committed.)

3. **Walk `S.edges`, remove from `node.subs`.** `S.edges = { edge2 }`.
   Remove `edge2` from `name.subs`. After this step: `name.subs = { edge1 }`.

4. **Drop S's slots.** For each node in `S.readSet ∪ S.writeSet =
   { doubleName, name }`: `S.slots.delete(node)`. `S.slots` now `∅`.

5. **Close child scopes.** `S.children = ∅` — nothing to recurse into.

6. **Drain deferred-fires region.** One queued fire: invalidate `slot_DN_R`
   (clear `cached`, mark dirty).

7. **Finalize.** `S.status = 'committed'`. `S.cleanups` empty.
   `ROOT.children.delete(S)`. Pop ambient.

**State after Step 5a:**

```
name.subs        = { edge1 }   (edge2 removed in step 3)
doubleName.subs  = ∅

ROOT.slots       = { name → slot_N_R_new("bar"),
                     doubleName → slot_DN_R(cached: undefined, dirty) }
ROOT.edges       = { edge1 }   (unchanged)
ROOT.writeSet    = { name }    (gained name from promotion)
ROOT.readSet     = { name, doubleName }  (unchanged)

S — fully disposed. No references to S except possibly the user's action handle.
```

Subsequent `get(doubleName)` outside any action: `ROOT.slots.has(doubleName)`?
Yes, but cached is undefined → recompute under ROOT. Recipe reads `name` →
`ROOT.slots[name].cached = "bar"`. Returns `"barbar"`. ✓

### Step 5b: action throws → `closeScope(S, 'discard')`

Alternative: action body throws. No promotion happens.

1. Open deferred-fires region (no fires expected, but for invariant uniformity).
2. Skip promotion (discard mode).
3. Walk `S.edges`, remove from `node.subs`. Remove `edge2` from `name.subs`.
4. Drop `S.slots` entries (both `doubleName` and `name`).
5. Close child scopes (none).
6. Drain deferred-fires region (empty).
7. Fire `S.cleanups` (none in this trace; would be `onCleanup(...)`
   registrations, e.g. `AbortController.abort()`).
8. `S.status = 'discarded'`. `ROOT.children.delete(S)`. Pop ambient.

**State after Step 5b:** identical to State after Step 1 (committed state
never observed the speculation). ✓ `get(doubleName)` after discard: cached
`"foofoo"`. ✓

### Verification: every architectural decision exercised

| Decision | Where exercised |
| --- | --- |
| [Q1 Model 1](./questions.md#q1--fall-through-and-edge-policy) (engine-side chain-match) | Steps 3, 5a — fire / skip decisions per edge. |
| [Q6 scope-centric storage](./questions.md#q6--what-is-a-scope-as-a-value) | All state representations; slots live in `S.slots` / `ROOT.slots`. |
| [Q6 explicit disposal](./questions.md#q6--what-is-a-scope-as-a-value) | Steps 5a/5b — walk `S.edges` to clean `node.subs`; drop `S.slots`. |
| [Q9 writeSet / readSet](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally) | Steps 3, 4 — Set membership decides promotion vs drop. |
| [Q10 deferred-fires region](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires) | Step 5a — fires queue during promotion, drain after slot drops. |
| [Q11 Policy α](./questions.md#q11--effect-chain-policy-chain-follows-owner-or-always-root_scope) | (Trivially — no effect in this trace, but `S.edges` ownership is the same mechanism.) |
| [P6 synchronous reads](./framings.md#p6--pull-driven-reads-push-driven-consumers-no-explicit-flush) | Step 4 — `get(doubleName)` returns `"barbar"` synchronously, no flush. |

**No falsifications. No new sub-questions.** The trace previously exposed
eight follow-ups (commit ordering, promoted-slot cached carry, action-body
tracking, edge index location, edge dedup, late subscribers, async, commit
ordering races). All eight are now resolved by the locked-in framings:

1. **Commit ordering** — Q10 dep-order leaves-first inside deferred-fires region.
2. **Promoted-slot cached** — preserved; old deps not carried (chain-match
   re-resolves naturally at the new scope).
3. **Action-body tracking** — Q8 confirms separate ambients;
   `currentTracker = null` for action bodies, parallel-coupled with scope.
4. **Edge index location** — Q6: `node.subs: Set<Edge>` is the write-fire
   index; `scope.edges` is the cleanup tracker. Both for free.
5. **Edge dedup** — under Model 1 edges are plain `(source, target)`; dedup
   checks `node.subs` for the same target.
6. **Late subscribers / chains longer than 1** — Q1 chain-match handles
   any chain depth naturally; trace H2 would verify by example but no new
   mechanism needed.
7. **Async** — Q4: Promise resolution is not an engine event; consumers
   that hold the Awaitable handle their own resumption. Traced separately
   in C2 / C2e.
8. **Dangling-ref window** — Q6 explicit disposal removes from
   `node.subs` before dropping `S.slots`, so no dangling ref ever escapes.

---

## C2 — action body with async read

A worked trace through the four C2 sub-scenarios (await-and-resume, long-lived
scope, supersession-during-await, writes-during-await). C2 was identified as
the highest-yield single trace because it pressures all four framings
(Node-as-recipe, walks-first-class, slim-engine + thick-library, scope/owner
unification) and several open questions ([Q1](./questions.md#q1--fall-through-and-edge-policy), [Q2](./questions.md#q2--scopeowner-unification), [Q4](./questions.md#q4--async-at-the-engine-level), [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified)) simultaneously.

### Setup

```ts
let resolveUser: (v: string) => void
const userPromise = new Promise<string>(r => {
	resolveUser = r
})

const [user, setUser] = signal<string | Promise<string>>(userPromise)
// user.defaultRecipe = () => userPromise (Promise, pending)
```

The signal's recipe returns a `Promise<string>`. Reading the signal yields the
Promise; resolving requires either awaiting or using a walk that suspends.

**State after setup:**

```
user        = { defaultRecipe: () => userPromise, subs: ∅ }
ROOT.slots  = ∅, ROOT.edges = ∅,
ROOT.readSet = ∅, ROOT.writeSet = ∅
userPromise : pending
```

### Walks involved

Two library primitives are exercised in C2:

- **`get(node)`** (the basic walk): returns whatever the recipe returns —
  `T` or `Promise<T>`. Forms a tracking edge if called inside a recompute
  context. Doesn't suspend; the caller chooses how to handle Promises.
- **`yield* get(node)`** (the generator-form walk): inside a generator
  (compute body or action body), `yield* get(node)` either returns
  immediately with `T` (sync case) or yields a `park` command (async case)
  that the calling driver dispatches on.

The action body runs as a generator; it can `yield* get(...)` to park.
Sketched walk implementation:

```ts
function* read<T>(node: Node<T>): Generator<ParkCommand, T, T> {
	const scope = getCurrentScope()
	if (currentTracker) link(node, currentTracker)
	const result = invoke(node, scope) as T | Promise<T>
	if (result instanceof Promise) {
		const resolved = yield { kind: 'park', promise: result } as ParkCommand
		return resolved
	}
	return result
}
```

And the action driver:

```ts
function driveAction(scope: Scope, gen: Generator) {
	const step = (value: unknown) => {
		if (scope.status !== 'open') return // discarded mid-await; bail
		pushScope(scope)
		try {
			const { done, value: cmd } = gen.next(value)
			if (done) closeScope(scope, 'commit')
			else if (cmd.kind === 'park') cmd.promise.then(step, stepThrow)
			// else: other command kinds
		} catch (e) {
			closeScope(scope, 'discard')
			throw e
		} finally {
			popScope()
		}
	}
	const stepThrow = (err: unknown) => {
		/* analogous, gen.throw */
	}
	step(undefined)
}
```

Three things to notice in `driveAction`: **(1)** every `gen.next` is bracketed
by `pushScope` / `popScope` — that's how ambient scope restores across awaits.
**(2)** the `scope.status !== 'open'` check on resume — if the scope was
discarded mid-await, the resume callback bails. **(3)** the driver is library
code; engine knows nothing about generators or park commands.

### C2a: simple await-and-resume

```ts
action(function* () {
	const name = yield* get(user) // parks until userPromise resolves
	setUser(Promise.resolve(name + '!'))
})
// later: resolveUser("alice")
```

**Step 1: open scope.** `action(body)` → `openScope()` → engine creates
`S = { parent: ROOT, children: ∅, slots: ∅, edges: ∅, writeSet: ∅,
readSet: ∅, cleanups: [], status: 'open' }`. `ROOT.children.add(S)`.
Library pushes `S` as ambient. Library calls `driveAction(S, gen)`.

**Step 2: first `gen.next(undefined)`.** Generator runs until first yield.

- Body calls `yield* get(user)`. The `get` sub-generator runs:
  - `getCurrentScope()` → `S`. `S.readSet.add(user)`. `currentTracker = null`
    (action-body reads are imperative; per [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified)
    the action body doesn't re-run on dep change). No `link()` call.
  - `invoke(user, S)`:
    - Engine: `S.slots.has(user)`? No. Create `slot_U_S = { recipe:
      user.defaultRecipe, deps: [] }`. Run recipe → `userPromise`.
      `slot_U_S.cached = userPromise`. `S.slots.set(user, slot_U_S)`.
      Return `userPromise`.
  - `get` sees Promise → yields `{ kind: 'park', promise: userPromise }`.
- `yield*` propagates the park command up to the action body's iterator. The
  body's `gen.next(undefined)` returns `{ done: false, value: { kind: 'park',
  promise: userPromise } }`.
- Driver: `cmd.kind === 'park'` → attach `userPromise.then(step, stepThrow)`.
- Driver: `popScope()` runs (finally block). Ambient back to `ROOT_SCOPE`.
- Driver returns. Synchronous portion of action handler is done.

**State after Step 2:**

```
user.subs    = ∅
S.slots      = { user → slot_U_S(cached: userPromise) }
S.readSet    = { user }                 # read-populated only
S.writeSet   = ∅                        # no writes yet
S.edges      = ∅                        # action body doesn't track
S.status     = 'open'
userPromise  : pending (driver awaits)
```

Notice: no edges. The action body's reads don't register tracking edges
(no `currentTracker`) because the body isn't going to re-run on dep
change. Per [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally),
`user` lives in `S.readSet` only — it will drop at commit without
promotion.

**Step 3: time passes; `resolveUser("alice")` is called.**

`userPromise` resolves to `"alice"`. The `.then` callback fires (microtask).

- Driver `step("alice")` runs.
- Check `scope.status === 'open'` → yes. `pushScope(S)`. Ambient back to `S`.
- Call `gen.next("alice")`. The `yield*` machinery resumes the `get`
  sub-generator with `"alice"`. `get` returns `"alice"`. `yield*` resumes
  the action body with `"alice"`. `name = "alice"`.

**Engine handling of Promise resolution** (per
[Q4](./questions.md#q4--async-at-the-engine-level)): the engine does
**nothing** on resolution. The driver above (which is the consumer for
this action body) already held the Awaitable — it attached its own
`.then` and is resuming the generator directly. The Awaitable's `status`
flipped to `'fulfilled'` and `value: "alice"` populated as instance state
on the Awaitable class (not as a side-table or tweak on a foreign Promise
— pulse owns the wrapper, see the Awaitable framing). `slot_U_S.cached`
still points at the same Awaitable; its identity didn't change, so
there's no write event and no chain-match firing. Walks that later
inspect the slot read `.status` and `.value` synchronously. Consumers
that care about resolution (other than this driver) would have to hold
the Awaitable themselves — there is no ambient "resolution fired"
channel on the slot.

**Step 4: body continues — `setUser(Promise.resolve("alice!"))`.**

- Library: `setUser` (closed-over setter) runs. `getCurrentScope()` → `S`.
- Library: `writeSlot(user, S, { recipe: () => Promise.resolve("alice!"),
  cached: Promise<"alice!">, deps: [] })`. `S.writeSet.add(user)`.
  `S.slots.set(user, slot_U_S_new)` (overwrites the read-populated entry).
- Engine fires chain-match for each `edge ∈ user.subs = ∅`. Nothing.

(The library's setter is responsible for the Awaitable wrapping; whether
the cached value here is the raw `Promise<"alice!">` or an Awaitable is
a wrapper question per Q4 — either way, slot identity is what matters.)

**State after Step 4 (before microtask):**

```
S.slots    = { user → slot_U_S_new(cached: Promise<"alice!">) }
S.writeSet = { user }                  # gained user
S.readSet  = { user }                  # already present
```

**Step 5: generator returns; action commits.**

- Body's `gen.next(...)` (the one from step 3) continues past `setUser` and
  reaches the end. Returns `{ done: true }`.
- Driver: `done` → `closeScope(S, 'commit')`.

Per [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires):

1. Open deferred-fires region.
2. Promote `S.writeSet = { user }`: `writeSlot(user, ROOT, { recipe:
   () => Promise.resolve("alice!"), cached: Promise<"alice!">, deps: [] })`.
   `ROOT.slots.set(user, …)`. `ROOT.writeSet.add(user)`. Fire chain-match
   for each `edge ∈ user.subs = ∅`. Nothing.
3. Walk `S.edges = ∅`. Nothing.
4. Drop `S.slots` for `S.readSet ∪ S.writeSet = { user }`.
5. Close children (none).
6. Drain region (empty).
7. `S.status = 'committed'`. `ROOT.children.delete(S)`. Pop ambient.

**State after Step 5:**

```
ROOT.slots    = { user → cached: Promise<"alice!"> }
ROOT.writeSet = { user }
S             : committed
```

Subsequent `get(user)` returns the Promise (or `"alice!"` once settled,
per Q4 — `slot.cached` is an Awaitable whose `status` flips internally). ✓

### Architecture exposed by C2a

C2a tested cleanly. The decisions it forced into the open:

1. **Async-honest walks.** `get(node)` returns `T | Promise<T>`. The walk
   doesn't hide the Promise; the caller chooses how to handle it. [P2](./framings.md#p2--acknowledge-async-dont-hide-it) holds.
2. **Park commands separate walk intent from action machinery.** `yield*
get(node)` yields a `park` command; the action driver decides what to do
   with it (`.then` here; could be `requestAnimationFrame` for an `raf`
   command; library convention, not engine concern). Slim engine + thick
   library (the third framing) holds.
3. **Ambient scope restoration is mechanical.** The driver's
   `pushScope(S)` / `popScope()` around every `gen.next` is what makes the
   scope persist across awaits. Without this, `setUser` after the await
   would write to `ROOT_SCOPE` instead of `S`. [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified) (tracker vs scope):
   the _scope_ persists across awaits via push/pop; the _tracker_ doesn't
   (the action body has no tracker at all). They're separate.
4. **Action-body reads don't track.** No edges formed during the trace.
   Confirms the assumption from [doubleName trace](#doublename-under-scope-s)'s open question #3 and
   from H1's premise (action bodies are one-shot).
5. **The driver's discard-guard on resume.** `if (scope.status !== 'open')
return` is what makes C2c safe — see below. [Q2](./questions.md#q2--scopeowner-unification) (cancellation) interacts
   with [Q4](./questions.md#q4--async-at-the-engine-level) (async) through this guard.
6. **Engine does nothing on Promise resolution** (per
   [Q4](./questions.md#q4--async-at-the-engine-level)). The Awaitable's
   `status` flips internally; consumers that hold the Awaitable handle
   their own resumption via `.then` / `yield*` / `use`.
7. **Promise identity as supersession signal.** The driver attached
   `.then` to a _specific_ `userPromise`; if the slot's `cached` later
   changes to a different Promise (a new Awaitable), the original `.then`
   is stale. The discard-guard catches it.

### C2b: long-lived open scope

Same code as C2a, but `resolveUser` is called minutes later (or never). The
trace is structurally identical to C2a — the scope `S` simply stays `open`
for the duration. Slot `user.slots[S]` stays cached as `userPromise`. The
driver holds its `.then` indefinitely.

What's new:

- **Resource accumulation.** `S` holds `cleanups`, accumulates further
  writes from the action body if any happen pre-await. The slot at `user.S`
  pins the original `userPromise`.
- **External cancellation matters more.** A long-lived action without
  cancellation is a leak. Practical actions that might wait long need
  `onCleanup(() => abortController.abort())` so they can be discarded.
- **No new mechanism.** Same path as C2a; correctness doesn't depend on
  await duration.

### C2c: supersession during await

```ts
const handle = action(function* () {
  yield* get(user)
  setUser(...)
})
// later, while handle is parked:
handle.discard()                // or: another action arrives and supersedes
// even later: resolveUser("alice") still fires
```

**Step C2c-1: `handle.discard()` while parked.**

- Library: `closeScope(S, 'discard')`.
  1. Open deferred-fires region.
  2. Skip promotion (discard mode).
  3. Walk `S.edges = ∅`. Nothing.
  4. Drop `S.slots` for `S.readSet ∪ S.writeSet = { user }`.
     `S.slots.delete(user)`.
  5. Close children (none).
  6. Drain region (empty).
  7. Fire `S.cleanups` per [Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)
     (e.g., `abortController.abort()` if the action body had registered
     one — none in this trace).
  8. `S.status = 'discarded'`. `ROOT.children.delete(S)`. Ambient stays
     at whatever it was (not pushed because `discard()` was called from
     outside any scope context).

**State after Step C2c-1:**

```
S.slots      = ∅
S.status     = 'discarded'
userPromise  : still pending (no one called resolveUser yet)
```

**Step C2c-2: `resolveUser("alice")` fires later.**

- `userPromise.then(...)` callback fires. Driver `step("alice")` runs.
- **Guard fires:** `scope.status !== 'open'` (it's `'discarded'`) → driver
  returns without calling `gen.next`. ✓
- Generator is garbage-collected when references drop. Done.

What this trace exposes:

- **The discard-guard pattern is load-bearing.** Without it, a discarded
  scope's resume would call `gen.next` and potentially execute body code
  (including writes!) under a closed scope. Library convention required.
- **Cancellation discipline is library code over scope + cleanups.** The
  AbortController pattern composes with `onCleanup`; the engine doesn't
  need a separate cancellation primitive. [Q2](./questions.md#q2--scopeowner-unification) (cancellation) ≈ scope-discard
  - `onCleanup`. Confirms the working hypothesis from [Q2](./questions.md#q2--scopeowner-unification).
- **Promise still resolves but nothing happens.** The original `.then`
  fires but the guard absorbs it. Resource cleanup: the underlying
  fetch/timer would already have been aborted by `S.cleanups`; the
  `.then` callback firing is harmless.
- **Memory: the discarded scope can be GC'd once the .then is consumed.**
  If a discard happens but `userPromise` _never_ resolves, the `.then`
  holds a reference to the driver, which holds the generator, which holds
  closures. Detail-level open question; pulse may need WeakRef gymnastics
  here.

### C2d: writes during the await window

```ts
action(function* () {
	const name = yield* get(user) // parks
	console.log(name)
})
// while parked:
setUser(Promise.resolve('bob')) // write from outside the action
// then:
resolveUser('alice') // original promise resolves
```

The interesting subtlety: while the action is parked, _someone else_ writes
to `user` (in `ROOT_SCOPE` here, since the outside write has no ambient
scope). What does the action body see when it resumes?

**Step C2d-1: action parks at `yield* get(user)`.** Same as C2a Steps 1-2.
After: `S.slots[user] = slot_U_S(cached: userPromise)`,
`S.readSet = { user }`, `S.writeSet = ∅`. Driver awaits.

**Step C2d-2: outside `setUser(Promise.resolve("bob"))`.**

- `getCurrentScope()` → `ROOT_SCOPE` (no action active outside; the driver
  popped scope when the body parked).
- `writeSlot(user, ROOT, { recipe: () => Promise.resolve("bob"),
  cached: Promise<"bob">, deps: [] })`. `ROOT.writeSet.add(user)`.
  `ROOT.slots.set(user, slot_U_R)`.
- Engine fires chain-match for each `edge ∈ user.subs = ∅`. Nothing.

**State after C2d-2:**

```
ROOT.slots = { user → slot_U_R(cached: Promise<"bob">) }   # new
S.slots    = { user → slot_U_S(cached: userPromise, pending) }
S.readSet  = { user }, S.writeSet = ∅
```

**Step C2d-3: `resolveUser("alice")` resolves the original promise.**

- The driver's `.then("alice")` callback fires.
- Guard: `S.status === 'open'` → continue. `pushScope(S)`.
- `gen.next("alice")` resumes the body. `name = "alice"`.
  `console.log("alice")`.
- Body returns. `closeScope(S, 'commit')`.

Per [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires)
+ [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally):

1. Open deferred-fires region.
2. **Promote `S.writeSet` only.** `S.writeSet = ∅` — nothing to promote.
   This is the load-bearing step: the action read `user` but never wrote
   it, so `user` is in `S.readSet` only, not `S.writeSet`. The outside
   write to `ROOT.slots[user]` is preserved.
3. Walk `S.edges = ∅`. Nothing.
4. Drop `S.slots` for `S.readSet ∪ S.writeSet = { user }`.
   `S.slots.delete(user)`. The read-populated `slot_U_S` (containing the
   original `userPromise`) is dropped without affecting `ROOT.slots[user]`.
5. Close children (none).
6. Drain region (empty).
7. `S.status = 'committed'`. Pop ambient.

**Final state:**

```
ROOT.slots = { user → cached: Promise<"bob"> }   # outside write wins
S          : committed (fully disposed)
```

This is exactly the C2d wrinkle the trace originally surfaced — the
distinction between read-populated and write-populated slots — and the
resolved [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally)
"scope.writeSet drives promotion" lands it correctly. The earlier draft
proposed a per-slot `wasWritten` flag (position β); Q9 instead puts the
distinction on the scope (`writeSet` vs `readSet`), with uniform slot
shape. Same semantics, cleaner locus.

What C2d exposes:

- **Read-populated vs write-populated slots live on the scope, not the
  slot.** Per [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally),
  `scope.writeSet` and `scope.readSet` partition the distinction at the
  scope level; slot shape stays uniform.
- **Read-skew is real.** The action body saw `"alice"` because it read
  before the outside write. After the action commits, the canonical value
  is `Promise<"bob">` (from outside) — _not_ what the action body "saw."
  Intrinsic to await-and-resume.
- **The action body had no way to notice the outside write.** Because it
  didn't form a tracking edge (no `currentTracker` in an action body).
  If it _had_ formed an edge, the edge would have invalidated → but the
  action body wouldn't re-run anyway. Edges are useless for action
  bodies; pure imperative reads are the right shape.
- **D-skew between scopes.** When scope `S` is open and outside writes
  happen to `ROOT_SCOPE`, scope `S` doesn't see them because reads under
  `S` walk most-specific in `chainFor(S) = [S, ROOT]` and `S` has a slot.
  To see the outside write, the action would have to drop its slot or
  read `latest()` (which invokes against `ROOT_SCOPE` directly).

### Summary

C2 was the highest-yield trace because it forced the following decisions /
sub-questions into the open:

1. **Walks return `T | Promise<T>` honestly.** (Confirms [P2](./framings.md#p2--acknowledge-async-dont-hide-it).)
2. **`yield* get` yields `park` commands; the action driver dispatches.**
   Library convention; engine knows nothing.
3. **Ambient-scope restoration via `pushScope`/`popScope` around every
   `gen.next`.** Driver responsibility.
4. **Action bodies don't track.** No edges formed.
5. **Discard-guard on resume.** `if (scope.status !== 'open') return`.
6. **Engine does nothing on Promise resolution** (per
   [Q4](./questions.md#q4--async-at-the-engine-level)). The slot's
   `cached` is an Awaitable; its identity doesn't change when the
   underlying Promise settles (only the instance's
   `status`/`value`/`reason` flips). The consumer that received the
   Awaitable from `get(...)` — the action body's driver in this trace —
   holds the reference and attaches its own `.then` for resumption. No
   engine-level `'resolved'` event; chain-match fires on writes only.
7. **Read-vs-write slot distinction lives on the scope** (per
   [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally)):
   `scope.writeSet` drives commit promotion; `scope.readSet ∪ writeSet`
   drives slot drop on close. Slot shape stays uniform.
8. **Read-skew is intrinsic to await-and-resume; programmer's
   responsibility.** D8 (sequential `yield*`s sample at different
   instants) confirmed by trace.
9. **Cancellation discipline is library code over scope-discard +
   `onCleanup`** (per [Q2](./questions.md#q2--scopeowner-unification),
   [Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)).
   No new engine primitive for cancellation.

All sub-questions surfaced by C2 are now resolved by the locked-in
framings (Q4, Q6, Q9, Q10, Q12). All framings held: Node-as-recipe
survived (recipes can return Promises), walks-first-class survived
(`get` and `yield* get` are walks), slim-engine + thick-library
survived (driver is library; engine sees writes), scope/owner
unification held (cleanups + scope-status + discard mechanism). No
falsifications.

---

## H1a-c — effect under speculation

A worked trace of the three H1 sub-scenarios verifying the **defer-until-commit**
position for effects-under-speculation: speculative writes inside an action
_do not_ fire effects registered outside; commit fires them once; discard
never fires them. The trace also establishes a consumer-pattern abstraction
([Q3](./questions.md#q3--consumer-patterns)) that's load-bearing for the next-pressing piece of the architecture.

### What's an Effect, structurally?

Under the [framings](#signal--computed--jsx-expression--effect-are-all-the-same-primitive),
Effect is one of the four connection patterns over `Node<() => T>`:

- The Node's recipe is the _body_ (which contains reads and side effects).
- The recipe is _fixed at creation_ (like Computed).
- The **consumer** is a _scheduler_ that re-invokes the recipe whenever any
  of the recipe's tracked deps changes.
- If the recipe returns a function, that's a _cleanup_ run before the next
  invocation (or on disposal).
- The effect's _ambient scope_ at creation time determines what chain its
  tracking edges form against.

Library shape:

```ts
function effect(fn: () => void | (() => void)): EffectHandle {
	const scope = getCurrentScope() // ambient scope = ownership + dep-chain
	const node = createNode<void>(fn) // Effect is a Node whose recipe is fn

	let lastCleanup: (() => void) | undefined

	const runBody = () => {
		lastCleanup?.()
		pushScope(scope)
		pushTracker(getOrCreateSlot(node, scope))
		try {
			lastCleanup = fn() as (() => void) | undefined
		} finally {
			popTracker()
			popScope()
		}
	}

	// Initial invocation forms tracking edges
	runBody()

	// Register as a consumer: when this Node's slot is invalidated, re-run on
	// next microtask (batched).
	subscribe(node, e => {
		if (e.kind === 'invalidated') scheduleMicrotask(runBody)
	})

	return {
		dispose: () => {
			lastCleanup?.()
			disposeNode(node)
		},
	}
}
```

Three things to notice: **(1)** the effect's ambient scope at creation is
captured in `scope` — its edges form against `chainFor(scope)`. **(2)** the
consumer is just a `subscribe` call on the Effect Node itself; the engine
fires "slot invalidated" events; library batches via `scheduleMicrotask`.
**(3)** the engine knows nothing about effects — `subscribe` is the only
engine primitive used.

### Setup

```ts
const [count, setCount] = signal(0)
let effectRuns = 0
const handle = effect(() => {
	const value = get(count)
	effectRuns += 1
	console.log(`Effect runs: ${effectRuns}, value: ${value}`)
})
```

**Step 0: effect creation, initial run.**

- `effect(fn)` runs. `getCurrentScope()` → `ROOT_SCOPE` (top-level).
- `createNode<void>(fn)` → engine creates `effectNode = { defaultRecipe: fn,
  subs: ∅ }`.
- `runBody()`:
  - `pushScope(ROOT_SCOPE)` (no-op; already there). Create
    `slot_E_R = { recipe: fn, deps: [] }` and `ROOT.slots.set(effectNode,
    slot_E_R)`. Push `currentTracker = slot_E_R`.
  - Invoke `fn`:
    - `get(count)`:
      - `currentScope = ROOT`. `ROOT.readSet.add(count)`.
        `currentTracker = slot_E_R` → `link(count, slot_E_R)`:
        - `edge1 = { source: count, target: slot_E_R, targetScope: ROOT }`.
          `count.subs.add(edge1)`; `ROOT.edges.add(edge1)`;
          `slot_E_R.deps.push(edge1)`.
      - `invoke(count, ROOT)`: miss. Create `slot_C_R = { recipe: () => 0,
        deps: [] }`. Run recipe → `0`. `slot_C_R.cached = 0`.
        `ROOT.slots.set(count, slot_C_R)`. Return `0`.
    - Body: `value = 0`. `effectRuns = 1`. Returns undefined.
  - `lastCleanup = undefined`. Pop tracker.
- `subscribe(effectNode, handler)`. Library registers handler.

Per [Q11](./questions.md#q11--effect-chain-policy-chain-follows-owner-or-always-root_scope)
Policy α: because the effect was created in `ROOT_SCOPE`, its tracking
edges live in `ROOT.edges` with `targetScope = ROOT`. When `ROOT_SCOPE`
ever closes (it doesn't, by library convention), the edges would die
structurally.

**State after Step 0:**

```
count.subs      = { edge1 }
effectNode.subs = ∅

ROOT.slots      = { count → slot_C_R(cached: 0),
                    effectNode → slot_E_R(deps: [edge1]) }
ROOT.edges      = { edge1 }
ROOT.readSet    = { count }
ROOT.writeSet   = ∅

edge1 = { source: count, target: slot_E_R, targetScope: ROOT }
        // chainFor(ROOT) = [ROOT]

effectRuns = 1
```

### H1a: speculative write inside an action — effect does NOT fire

```ts
action(function* () {
	setCount(5)
})
// expectation: effect does NOT run inside the action
```

**Step 1a-1: open scope.** `openScope()` → `S = { parent: ROOT, children: ∅,
slots: ∅, edges: ∅, writeSet: ∅, readSet: ∅, cleanups: [], status: 'open' }`.
`ROOT.children.add(S)`. Push ambient. Begin driving generator.

**Step 1a-2: `setCount(5)` inside the action.**

- Library: setter runs. `getCurrentScope()` → `S`. `writeSlot(count, S,
  { recipe: () => 5, cached: 5, deps: [] })`. `S.writeSet.add(count)`.
  `S.slots.set(count, slot_C_S)`.
- Engine fires chain-match for each `edge ∈ count.subs`:
  - `edge1`: `chainFor(ROOT) = [ROOT]`. `writeScope = S` not in chain.
    **Don't fire.** ✓

**State after Step 1a-2:**

```
count.subs   = { edge1 }   (unchanged)

S.slots      = { count → slot_C_S(cached: 5) }
S.writeSet   = { count }
S.readSet    = ∅
S.edges      = ∅

ROOT unchanged. effectRuns = 1.
```

**Step 1a-3: generator returns.** _(we'll cover commit in H1b.)_

The key observation: **the effect's edge targets a slot in `ROOT_SCOPE`,
and the engine's chain-match naturally rejects writes to `S`** (since
`chainFor(ROOT_SCOPE)` doesn't contain `S`). No special "defer-until-commit"
logic in the engine; the defer behaviour falls out of chain-match
composition. The effect doesn't fire during the action because _its
subscription chain doesn't include `S`_.

This is the cleanest possible answer to H1a: the chain-match machinery
already enforces it. **Confirming the lean: defer-until-commit.**

### H1b: action commits — effect fires exactly once

Continuing from the H1a state, with the generator returning normally:

**Step 1b-1: `closeScope(S, 'commit')`.**

Per [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires):
commit is a deferred-fires region.

1. **Open deferred-fires region.** Subsequent fires queue.

2. **Promote writeSet.** `S.writeSet = { count }`. Promote:
   `writeSlot(count, ROOT, { recipe: () => 5, cached: 5, deps: [] })`.
   `ROOT.slots.set(count, slot_C_R_new)`. `ROOT.writeSet.add(count)`.
   Fire chain-match for each `edge ∈ count.subs`:
   - `edge1`: `chainFor(ROOT) = [ROOT]`. `writeScope = ROOT` at index 0;
     no more-specific check needed. **Queue fire** for `slot_E_R`.
     Effect's subscribe-handler receives the invalidation; calls
     `scheduleMicrotask(runBody)` — the per-Node scheduled flag dedups
     subsequent calls within this turn.

3. **Walk `S.edges`, remove from `node.subs`.** `S.edges = ∅` — nothing.

4. **Drop S's slots.** `S.readSet ∪ S.writeSet = { count }`.
   `S.slots.delete(count)`. `S.slots = ∅`.

5. **Close child scopes.** None.

6. **Drain deferred-fires region.** One queued fire for `slot_E_R`;
   already scheduled.

7. `S.status = 'committed'`. `ROOT.children.delete(S)`. Pop ambient.

**Step 1b-2: microtask runs scheduler.**

The effect's `subscribe` handler received the invalidation event in Step
1b-1; it called `scheduleMicrotask(runBody)`. Microtask now fires.

- `runBody()`:
  - `lastCleanup?.()` — none yet.
  - `pushScope(ROOT)`. `pushTracker(slot_E_R)`.
  - **Unlink stale deps.** `slot_E_R.deps = [edge1]`. Remove `edge1`
    from `count.subs` and from `ROOT.edges`. Reset `slot_E_R.deps = []`.
  - Invoke `fn`:
    - `get(count)`:
      - `ROOT.readSet.add(count)` — already present.
      - `link(count, slot_E_R)` → creates `edge1'` (fresh identity):
        `{ source: count, target: slot_E_R, targetScope: ROOT }`.
        `count.subs.add(edge1')`; `ROOT.edges.add(edge1')`;
        `slot_E_R.deps.push(edge1')`.
      - `invoke(count, ROOT)`: hit, return cached `5`.
    - Body: `value = 5`. `effectRuns = 2`. Returns undefined.
  - `lastCleanup = undefined`. Pop tracker. Pop scope.

**State after Step 1b-2:**

```
count.subs   = { edge1' }
ROOT.slots   = { count → slot_C_R_new(cached: 5),
                 effectNode → slot_E_R(deps: [edge1']) }
ROOT.edges   = { edge1' }
effectRuns   = 2
```

✓ The effect fired _exactly once_ on commit, with the committed value `5`.

### H1c: action discards — effect never fires

Same setup as H1a (post Step 0 state). The action body throws (or
`handle.discard()` is called externally).

**Step 1c-1: `closeScope(S, 'discard')`.**

1. Open deferred-fires region (invariant uniformity; no fires expected).
2. Skip promotion (discard mode — `S.writeSet` is not promoted).
3. Walk `S.edges` (∅), remove from `node.subs` — nothing.
4. Drop `S.slots` entries for `S.readSet ∪ S.writeSet = { count }`.
   `S.slots.delete(count)`. No edges had `slot_C_S` as a target.
5. Close child scopes (none).
6. Drain region (empty).
7. Fire `S.cleanups` per [Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)
   (none in this trace).
8. `S.status = 'discarded'`. `ROOT.children.delete(S)`. Pop ambient.

**No write to `ROOT.slots[count]` happens.** The chain-match for the
effect's edge is never tested against a fire-worthy write. Subscribers
receive no events; the microtask scheduler queues nothing.

**State after Step 1c-1:**

```
count.subs   = { edge1 }                  // unchanged from Step 0
ROOT.slots   = { count → slot_C_R(cached: 0),
                 effectNode → slot_E_R(deps: [edge1]) }
effectRuns   = 1                          // never advanced
```

✓ The effect _never_ fired during or after the action. The discard cleanly
unwinds the speculation with no side-effect leakage.

### Architecture exposed by H1a-c

The trace established **Q3 (consumer pattern)** with a concrete shape:

1. **A consumer is just a `subscribe` + a scheduler.** No new engine
   primitive needed. The library composes existing pieces: `subscribe(node,
handler)` for the engine-side notification, `scheduleMicrotask(...)` for
   batching/timing.
2. **The deferred-until-commit semantics fall out of chain-match composition.**
   An effect at `ROOT_SCOPE` has chain `[ROOT_SCOPE]` on its tracking edges.
   Writes to a speculative scope `S` don't match the chain → don't fire.
   Writes to `ROOT_SCOPE` (commit promotion) match → fire. **No engine
   logic; pure walk policy.** This is the cleanest possible answer to H1
   and arguably the strongest validation of the (β) "open walks over a
   smaller core" lean we've seen so far.
3. **Effect re-invocation is recipe re-invocation.** Same `pushTracker` /
   `pushScope` / `invoke` discipline as Computed re-runs. Effects and
   Computeds share machinery; what differs is _what the consumer does
   with the result_ (Computed caches in the slot; Effect throws away the
   value but holds the cleanup).
4. **Edge discipline on re-run.** Before re-invoking, the consumer unlinks
   stale `deps` (so they get rebuilt). Same as r3's existing pattern.
5. **JSX-binding consumer mirrors Effect.** A JSX expression `{get(x)}`
   is a Node whose consumer schedules a DOM update on invalidation. Same
   shape as `effect`; the scheduler hands off to the DOM updater instead
   of running a side-effecting body. **I1 falls out of H1.**
6. **Scope/owner unification holds, structurally via Q11 Policy α.** The
   effect's ambient scope at creation = its owner; its tracking edges
   live in `ownerScope.edges` with `targetScope = ownerScope`. When the
   owner closes, the engine walks `S.edges`, removes each from
   `node.subs`, and the effect's reactivity dies. H2 (effect inside
   action body) works the same way: the effect's scope is the action's
   scope `S`, so edges have `targetScope = S` and `chainFor(S) =
   [S, ROOT]` — writes to `S` DO fire the effect, which is what you want
   for effects inside actions.

### Consumer-pattern abstraction (Q3 answered)

The library has a uniform consumer shape:

```ts
type ConsumerKind =
	| { run: () => void } // re-invoke a body (Effect)
	| { render: () => void } // re-render a JSX subtree
	| { invalidate: () => void } // mark dependent Computed dirty
// …

function consumer(node, onSlotChange: () => void) {
	return subscribe(node, e => {
		if (e.kind === 'invalidated') scheduleMicrotask(onSlotChange)
	})
}
```

Effect / JSX-binding / Computed-cache-dependent are all `consumer(node, …)`
calls with different `onSlotChange` bodies. The engine doesn't see the
difference. **Q3 lands at: "consumers are library code over the engine's
`subscribe` primitive; no new engine primitive needed."**

### New sub-questions surfaced

The trace was clean — no falsifications — but a few details deserve being
captured:

1. **Microtask batching policy.** If multiple writes happen in quick
   succession, multiple invalidations fire, multiple `scheduleMicrotask`
   calls happen. Does the library de-dupe (one re-run per microtask cycle
   per Node) or does it re-run multiple times? r3 batches via the dirty
   heap; the library equivalent here would be a per-Node "scheduled"
   flag. Cheap fix; doesn't change architecture.
2. **Effect-during-recompute.** An effect's body calls `get(count)`; what
   if `count`'s recipe (when invoked) itself triggers an effect (via some
   side path)? Re-entrancy — exactly **K1 territory.** Worth tracing K1
   next since it directly tests this.
3. **Effect priority.** If 100 effects all depend on the same signal, and
   that signal commits, the scheduler runs them all in some order. Does
   order matter? Does pulse expose a priority hint? **Adjacent to R
   (scheduling).**
4. **Effects under a chain longer than 1.** A component-owned effect has
   chain `[component_scope, ROOT_SCOPE]`; an effect inside an action
   inside a component has chain `[action_scope, component_scope,
ROOT_SCOPE]`. The chain composition is implicit in `chainFor(scope)`.
   The trace didn't exercise this; H2 would.

### Framings status after H1a-c

All four framings held:

- _Node-as-recipe_: an Effect is a Node whose recipe is the body. Same
  shape as Signal/Computed.
- _Walks-first-class_: `get` inside the body forms edges with the right
  chain; the chain _is_ the consumer's subscription policy.
- _Slim engine + thick library_: the entire effect mechanism is library
  code over `createNode` / `subscribe` / `invoke` / `link` / `writeSlot`.
  Engine knows nothing about effects.
- _Scope/owner unification_: the effect's ambient scope at creation is
  its owner; disposing the scope disposes the effect via the cleanup
  chain.

**Q3 is essentially resolved** at the architectural level (mechanism +
policy via the chain-match predicate). H2/H3/H4 would test specific
compositions but don't require a new framing. **Two big upstream pieces are
now in place:** C2 established async-walk discipline; H1a-c established
consumer-pattern via the chain-match. Both came out cleanly.

---

## K1 — re-entrant setter mid-recompute

**Note (post-revision):** the original [K1 trace](#k1--re-entrant-setter-mid-recompute) below identified three
positions (A: ban, B: permit + defer fires, C: permit + fire synchronously)
and leaned (B) while ruling out (C). That conclusion was _wrong_. Two
subsequent findings dissolved K1's "design call" entirely:

1. **(A) is structurally incompatible** with the slim-engine framing
   (effects need to write inside their bodies; the engine doesn't
   distinguish "this tracker is a computed's recipe" from "this tracker
   is an effect's body" without violating one-Node-primitive).
2. **(B) returns _stale_ values** in the K1b scenario (write a signal
   then read a derived in the same recipe — see catalog K1b). The
   deferred fires mean the derived's slot isn't marked dirty until
   after the recipe returns; the in-recipe `get` returns the stale
   cached value.
3. **(C) was ruled out on a confused premise.** "Synchronous fire mid-
   recompute creates re-entrant invocation" conflated _firing edges_
   (mark target dirty + emit slot-changed event) with _synchronously
   invoking the consumer's body_. Firing is just propagate-dirty +
   queue-microtask; consumers schedule async; no re-entry occurs.

**Settled answer: (C) — permit + fire synchronously.** Consumers schedule
async via microtasks; cycle detection at consumer level catches loops. The
K1b sub-trace below walks through why.

The historical trace below remains for reference; the architectural status
is amended in the "Architecture exposed (post-revision)" section at the
end of K1.

### The interaction question (historical framing)

Concrete shape:

```ts
const [count, setCount] = signal(0)
const [shadow, setShadow] = signal(0)
const derived = computed(() => {
	const c = get(count)
	setShadow(c * 2) // ← re-entrant write inside the recipe
	return c + 1
})
get(derived)
```

What happens when the recipe calls `setShadow(0)`? Three positions were
identified; pulse leaned (B) initially but later flipped to (C) — see
the K1b sub-trace and "Architecture exposed (post-revision)" below.

### The three positions (historical exposition)

Concrete shape:

```ts
const [count, setCount] = signal(0)
const [shadow, setShadow] = signal(0)
const derived = computed(() => {
	const c = get(count)
	setShadow(c * 2) // ← re-entrant write inside the recipe
	return c + 1
})
get(derived)
```

What happens when the recipe calls `setShadow(0)`? Three positions were
identified. The historical conclusions are reproduced below for context;
the post-revision finding flips (B) → (C) — see "Why (B) is wrong" and
"K1b sub-trace" sections below.

- **(A) Hard ban.** `writeSlot` called while `currentTracker` is set →
  throw. Defensible: re-entrant writes are usually bugs and prohibiting
  them is the simplest invariant. r3 doesn't explicitly throw, but most
  reactive libraries (MobX strict mode, Solid in certain contexts) do.
- **(B) Permit + defer the fire.** `writeSlot` updates the slot
  synchronously (so later reads in the same body see the new value), but
  _defers_ edge-firing until the recompute completes. After the body
  returns, the engine drains a "deferred fire queue." Cycles (writes that
  invalidate the current tracker) re-queue the tracker for a future
  re-run; this can loop pathologically if the recipe always writes to
  one of its own deps.
- **(C) Fire synchronously.** `writeSlot` fires edges immediately, even
  mid-recompute. Naïve; can re-invalidate the currently-running recompute,
  causing reentrant invocation. Almost certainly wrong.

r3's behaviour today is closest to **(B)**: `setSignal` updates `el.value`
synchronously and inserts subs into the dirty heap; the heap is drained at
the next `stabilize()`. If the subs include the currently-recomputing
computed, it gets recomputed _again_ on the next pass. No explicit ban; no
explicit defer either — the deferral is implicit because firing means
"insert into heap," not "invoke synchronously."

For pulse the question is sharper because the chain-match predicate fires
edges _immediately_ on `writeSlot` (the predicate runs on the call stack).
To get B's deferral, we'd have to add explicit gating.

### Position B traced in detail

Library-side: `writeSlot` checks for an active tracker.

```ts
let deferredFires: { node: Node<unknown>; scope: Scope }[] | null = null

function writeSlot<T>(node: Node<T>, scope: Scope, slot: Slot<T>): void {
	node.slots.set(scope, slot) // engine: write the slot
	if (deferredFires !== null) {
		deferredFires.push({ node, scope }) // defer (we're inside a recompute)
	} else {
		fireEdges(node, scope) // immediate (no tracker active)
	}
}

function invoke<T>(node: Node<T>, scope: Scope): T | Promise<T> {
	const slot = getOrCreateSlot(node, scope)
	const savedFires = deferredFires
	deferredFires = []
	pushTracker(slot)
	pushScope(scope)
	try {
		slot.cached = slot.recipe()
		return slot.cached
	} finally {
		popScope()
		popTracker()
		const toFire = deferredFires
		deferredFires = savedFires
		if (savedFires === null) {
			// outermost invoke — actually fire
			for (const { node, scope } of toFire!) fireEdges(node, scope)
		} else {
			// nested — propagate up to outer queue
			savedFires.push(...toFire!)
		}
	}
}
```

Three things worth noting: **(1)** writes are visible _immediately_ to
subsequent reads in the same body (slot is updated synchronously). **(2)**
edge-firing is gated and queued. **(3)** nested invokes propagate deferred
fires upward — fires only happen when the _outermost_ invoke completes.

#### Trace: `get(derived)` from a clean slate

Initial state: all slots empty.

**Step 1.** `get(derived)`. Library: `getCurrentScope()` → `ROOT_SCOPE`.
`currentTracker` → null. `invoke(derived, ROOT_SCOPE)`.

**Step 2.** Engine `invoke(derived, ROOT_SCOPE)`:

- `derived.slots.get(ROOT_SCOPE)` miss. Create `slot_D_R` =
  `{ recipe: deriveBody, deps: [], subs: [] }`.
- `deferredFires` was null (top-level invoke); set to `[]`.
- `pushTracker(slot_D_R)`, `pushScope(ROOT_SCOPE)`.
- Invoke `deriveBody`:
  - `get(count)`:
    - `link(count, slot_D_R)` → creates
      `edge_C_D`. Add to `count`'s outgoing and `slot_D_R.deps`.
    - `invoke(count, ROOT_SCOPE)` → miss → create `slot_C_R` with
      `recipe: () => 0`, invoke → 0, cache → 0, return 0.
  - Body has `c = 0`.
  - `setShadow(c * 2)` = `setShadow(0)`:
    - Library setter: `writeSlot(shadow, ROOT_SCOPE, { recipe: () => 0,
cached: 0, deps: [], subs: [] })`.
    - Engine writes `shadow.slots[ROOT_SCOPE]`.
    - `deferredFires` is non-null → push `{ shadow, ROOT_SCOPE }` to queue.
      **No edge-firing here.**
  - Body returns `0 + 1 = 1`.
- `slot_D_R.cached = 1`.
- `popScope`, `popTracker`.
- `toFire = [{ shadow, ROOT_SCOPE }]`. `deferredFires = null` (back to outer
  state).
- Drain `toFire`: `fireEdges(shadow, ROOT_SCOPE)`.
  - Walk `shadow`'s outgoing edges with `(shadow.slots, ROOT_SCOPE)`. None.
  - No-op.
- Return 1.

**Final state:**

```
count.slots = { ROOT_SCOPE: cached 0,  subs: [edge_C_D] }
shadow.slots = { ROOT_SCOPE: cached 0, subs: [] }
derived.slots = { ROOT_SCOPE: cached 1, deps: [edge_C_D], subs: [] }
edge_C_D = { source: count, target: derived.slots[ROOT_SCOPE] }
```

`get(derived)` returned `1`; `shadow` is now `0`. ✓ The re-entrant write
happened; no loop, no error. If we read `shadow` later, we'd see `0`.

#### Why the deferral matters

If `fireEdges` had run _synchronously_ during `setShadow`, what would
happen?

- `shadow` has no outgoing edges yet (we're in the very first invocation),
  so nothing would fire. **In this exact trace, the difference is
  invisible.**

But add a downstream consumer of `shadow`:

```ts
let observedShadow = -1
effect(() => {
	observedShadow = get(shadow)
})
```

The effect's initial run forms an edge `shadow → effectSlot`. Now when
`get(derived)` runs and `setShadow(0)` fires _synchronously_ during the
recipe, the chain-match for the effect.s edge matches → effect's slot invalidates → effect
scheduled. The effect _might_ re-run before the recipe finishes (depending on
microtask ordering), creating partial-update visibility. With deferral, the
effect runs after `get(derived)` returns, observing the consistent
post-state.

Even subtler: if the effect itself reads `derived`, we get
`shadow → effect → derived`-style coupling, and synchronous firing during
`derived`'s recompute would re-enter `derived` recursively. Defining
"unwinds correctly" here requires invariants synchronous firing can't
satisfy.

#### The cycle subcase

```ts
const [count, setCount] = signal(0)
const incrementer = computed(() => {
	const c = get(count)
	setCount(c + 1) // writes to its own dep
	return c
})
get(incrementer)
```

Trace under Position B:

- Invoke `incrementer`. Push tracker.
- `get(count)` → 0; form edge `count → incrementer.slot`.
- `setCount(1)`: writeSlot writes count.slot. Defer fire.
- Return 0. Pop tracker.
- Drain: fire `count → incrementer.slot`. Selector matches; invalidate
  `incrementer.slot`. Mark dirty.

After the initial `get(incrementer)`:

- `incrementer.slots[ROOT_SCOPE].cached = 0` (returned value) but
  immediately invalidated by the drain.
- `count.slots[ROOT_SCOPE].cached = 1`.

If a consumer demands `incrementer` again (e.g., a downstream effect fires
the consumer), it recomputes:

- `get(count)` → 1. `setCount(2)`. Defer.
- Return 1. Pop. Drain → invalidate `incrementer`. Mark dirty.

Each demand-driven read recomputes one step. **No infinite loop _during_ a
single read** — the recompute completes, returns a value, and only _then_ is
the invalidation processed. The loop only continues if some consumer keeps
pulling.

If there's a consumer that re-runs on each invalidation (an Effect), the
Effect's scheduler will keep scheduling re-runs:

- Effect fires → reads incrementer → invalidates incrementer → Effect's
  slot also invalidates (since the Effect depends on incrementer's slot) →
  Effect rescheduled → loops.

Position B catches this _at the consumer level_, not at the recompute level.
The library's scheduler can detect "same Effect re-scheduling more than N
times in one microtask cycle" and bail with an error. r3 doesn't have this
today; pulse would need to add it.

### Position A (hard ban) traced

`writeSlot` inside a tracker throws.

```ts
function writeSlot(node, scope, slot) {
	if (currentTracker !== null) {
		throw new Error(
			'Cannot write to a signal during recompute. ' +
				'Move side-effecting writes to an effect or action.',
		)
	}
	// ... otherwise normal write ...
}
```

For the `derived` example above: `setShadow(0)` throws. The recipe throws.
`invoke(derived, ROOT_SCOPE)` propagates the throw. `get(derived)` throws.

Trade-offs vs Position B:

- **Pros (A):** simpler invariant, prevents the cycle case at the source,
  encourages cleanly separating computation from side-effect (use Effects
  for side effects). MobX-strict-mode style.
- **Cons (A):** some legitimate patterns become awkward (memoised writes to
  an isomorphic shadow representation; cache warming on demand; logging
  metrics from a derivation). Workarounds (`untrack`-then-write) feel
  hacky.

### Position C (fire synchronously) — ruled out

Already covered: synchronous firing mid-recompute creates re-entrant
invocation of the current recompute, which can corrupt cached state and
violate the "a recompute runs to completion uninterrupted" invariant.
Listed for completeness; almost certainly wrong.

### Architecture exposed

K1 forced the following framings under stress; all held, but with newly-
visible work:

1. **Q8 (tracker vs scope) matters here.** The re-entrant write's
   `getCurrentScope()` returns the scope being recomputed under — _not_
   `ROOT_SCOPE` by default. If `derived` is being recomputed under
   speculation scope `S`, the re-entrant `setShadow(...)` writes to
   `shadow.slots[S]`. **The scope nests cleanly with the tracker.** The
   ambient context's two slots (tracker, scope) push together when
   entering a recompute and pop together. [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified)'s "they're at different
   granularities" framing holds — but they're _parallel_ and _coupled_.

2. **Q1 (chain-match / fire policy) didn't break.** Under Position B, the
   chain-match still runs when `fireEdges` drains the deferred queue. The
   _only_ engine change Position B requires is gating `fireEdges` behind
   the `deferredFires` queue. The chain-match logic itself is unchanged.

3. **Q3 (consumer pattern) is the right level for cycle detection.**
   Cycles surface at the consumer level (Effects re-running indefinitely),
   not at the recompute level (recomputes always run to completion).
   The library's scheduler is where the "N re-runs per cycle" guard lives.
   This is a _new_ sub-question for [Q3](./questions.md#q3--consumer-patterns) — not "consumer shape" (resolved
   in H1a-c) but "consumer-driven cycle detection."

4. **Q5 (signal vs computed asymmetry) does _not_ matter here.** The
   re-entrant write is to a Signal slot; the trace would work the same
   way if it were to a Computed slot (Computed slots can also be written
   via promotion, etc.). The recompute discipline is uniform.

5. **A new question about read coherence.** Inside a recipe body that
   does `setShadow(...)` then `get(shadow)`, does the second read see
   the new shadow value? Under Position B's "write synchronously, fire
   later" — yes, because the slot is updated synchronously. Worth
   making explicit: **writes are visible within the recipe body that
   issued them, even before edges fire.** Read-your-own-write is
   intra-body.

### Lean

I lean **Position B (permit + defer fires)** with one library-side guard
(consumer cycle detection). Reasons:

1. _Consistent with r3's existing behaviour_ — `setSignal` updates value
   synchronously, defers notification via the dirty heap. The pulse Model
   2 fork would essentially make this explicit (a `deferredFires` queue
   gated on `currentTracker`).
2. _Doesn't ban legitimate patterns._ Memoised shadow projections, cache
   warming, derived metrics — these are all useful and don't necessarily
   indicate bugs.
3. _Cycle detection at the consumer level is the right granularity_ —
   cycles only loop if a consumer keeps demanding the same value, which
   the scheduler already coordinates. A "max re-runs per microtask cycle"
   guard catches infinite loops without false-positives on legitimate
   self-modifying recomputes.
4. _Programmer error is still detectable._ Even Position A doesn't catch
   _all_ infinite loops (it just bans the trivial direct case); the
   consumer-level guard catches the more general case.

But the lean is _soft_. Position A has real ergonomic appeal — "writes
during recompute are bugs" is a strong invariant. Pulse may end up shipping
**a mode flag** that toggles between A (strict, dev-mode) and B (permissive,
production). Mode flags are a hedge against locking in.

### New sub-questions surfaced

1. **Deferral propagation across nested invokes.** The sketch propagates
   `deferredFires` up to the outermost invoke. Is that the right
   granularity, or should each invoke's deferred fires fire when _that_
   invoke returns (so a transitive read sees a consistent intermediate
   state)? The trace suggests outermost — but for nested speculations
   (action inside action), the answer might be "fire at the action
   boundary" instead. Open.

2. **Consumer cycle-detection policy.** Max re-runs per microtask, or
   per-second, or detect "this consumer scheduled itself with no input
   change"? Library design call. **New [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires) candidate.**

3. **`untrack` interaction.** Calling `setShadow` inside an
   `untrack(() => ...)` block: does the deferral still apply? Per the
   tracker/scope separation, `untrack` clears `currentTracker` but not
   `currentScope`. So `deferredFires` (which is gated on tracker) would
   _not_ defer in untrack — writes would fire synchronously. That's
   plausible but worth confirming. Connects to L1 in the catalog.

4. **The Position A escape hatch.** If A is the default, what's the
   sanctioned way to do _needed_ re-entrant writes? `Promise.resolve().then(
() => setShadow(0))` to defer to next microtask? An explicit
   `defer(() => setShadow(0))` helper? Library shape, open.

### Framings status after K1

All four framings held:

- _Node-as-recipe_: re-entrant writes don't break the framing — the recipe
  is just JavaScript that happens to call a setter.
- _Walks-first-class_: `get` and `writeSlot` are walks; their composition
  during recompute is the policy question.
- _Slim engine + thick library_: Position B's deferral is implementable
  with one engine flag (`deferredFires`) and library-side scheduling. No
  new engine machinery beyond what's already sketched.
- _Scope/owner unification_: the re-entrant write inherits the scope from
  the recompute it's nested in. The scope/tracker pair pushes and pops
  together as a unit.

**No falsifications.** But K1 is the first traced scenario where the
architecture itself doesn't pick a winner between two real positions (A vs
B). That's _signal_ — it tells us the question is genuinely a _design call_
the engine machinery can support either way, and pulse has to make it
deliberately. Worth keeping the call open in the doc.

### K1b sub-trace: write inside recipe, then read downstream derived

A scenario that was not part of the original K1 wording — surfaced by a
user question:

```ts
const [name, setName] = signal('foo')
const doubleName = computed(() => get(name) + get(name))

const weird = computed(() => {
	setName('name') // write
	return get(doubleName).capitalize() // read of downstream derived
})
```

Assume `ROOT.slots[doubleName].cached = "foofoo"` (from an earlier read),
with `edge_N_D = { source: name, target: slot_DN_R, targetScope: ROOT }`
in `name.subs` and `ROOT.edges`.

**Under Position B (defer fires during recompute):**

- Recipe runs under `currentTracker = slot_weird_R`. Hypothetical
  `deferredFires = []`.
- `setName("name")`: `writeSlot(name, ROOT, …)`. `slot_N_R.cached = "name"`
  (synchronous). Hypothetically queue the fire instead of running
  chain-match.
- `get(doubleName)`: `invoke(doubleName, ROOT)`. `ROOT.slots[doubleName]`
  is `slot_DN_R` cached `"foofoo"`. **Is the slot dirty?** No — the fire
  was deferred, so the dirty flag was never set. Returns `"foofoo"`.
- Recipe: `"foofoo".capitalize() = "Foofoo"`. Cache
  `slot_weird_R.cached = "Foofoo"`.
- Pop tracker, drain queue. Fire chain-match for `edge_N_D`. Mark
  `slot_DN_R` dirty. (Too late.)

**Result under (B): `get(weird) = "Foofoo"`. Stale.** ✗

The reason: deferred fires mean _the dirty flag on `slot_DN_R` isn't set
until after the recipe returns_. The in-recipe `get(doubleName)` finds
the slot clean and returns the stale cached value.

**Under Position C (fire synchronously):**

- Recipe runs. No deferral.
- `setName("name")`: `writeSlot(name, ROOT, …)`. Engine fires chain-match
  for `edge_N_D` immediately (`chainFor(ROOT) = [ROOT]`, writeScope ROOT
  at index 0). Mark `slot_DN_R` dirty.
- `get(doubleName)`: `invoke(doubleName, ROOT)`. Slot exists but dirty.
  **Recompute**: reads `name` (now `"name"`), returns `"namename"`. Cache,
  clear dirty.
- Recipe: `"namename".capitalize() = "Namename"`. Cache.

**Result under (C): `get(weird) = "Namename"`. Fresh.** ✓

### Why the original K1 trace missed this

The original K1 used `setShadow(c * 2); return c + 1` — the recipe wrote
to `shadow` but didn't _read_ anything afterward, just returned. Without a
follow-up read of a derived value, Position B looked fine because the
deferred fires got drained after the recipe returned, with no
opportunity to observe the stale state mid-recipe.

K1b is the case that distinguishes (B) from (C). The catalog's original
K1 was _under-specified_: it tested "is the write permitted?" but not
"is in-recipe state coherent across the write?" Two different questions;
only the second probes the synchronous-vs-deferred-fires mechanism.

### Why (C) doesn't cause re-entrant invocation

The original [K1 trace](#k1--re-entrant-setter-mid-recompute) ruled out (C) with "synchronous firing mid-recompute
creates re-entrant invocation of the current recompute." This was a
confusion. Let's name the operations precisely:

- **`writeSlot`** updates `slot.cached` and walks outgoing edges.
- **`fireEdges`** for each matching edge: mark target slot dirty, emit a
  slot-changed event to subscribers.
- **Consumer** (Effect, Computed-cache, JSX-binding) receives the event
  and responds. Effects: `scheduleMicrotask(runBody)`. Computeds: no-op
  beyond the dirty flag (next demand recomputes). JSX: schedule DOM
  update.

Firing is just _mark dirty + emit event + queue microtask_. Crucially,
**consumers do not synchronously invoke bodies** — effects schedule async,
computeds wait for demand. So "fire synchronously inside a recipe" doesn't
re-enter the current recompute's body. It just sets flags on downstream
slots, which the current recompute may then encounter via its own reads
(triggering recomputes of _those_ slots, not the current one).

### The cycle subcase under (C)

```ts
const incrementer = computed(() => {
	const c = get(count)
	setCount(c + 1)
	return c
})
```

- `get(count)`: edge `edge_C_I = { source: count, target: slot_inc_R,
  targetScope: ROOT }` formed in `count.subs` and `ROOT.edges`.
- `setCount(c+1)`: `writeSlot(count, ROOT, …)`. Engine walks `count.subs`,
  runs chain-match. `edge_C_I`: matches. Mark `slot_inc_R` dirty.
- But `slot_inc_R` is currently being recomputed. Marking it dirty just
  sets a flag. The recompute completes, caches `c`, leaves dirty set.
- Next demand for `incrementer`: dirty, recompute. `c = new value`,
  `setCount` again, mark dirty. Cached, dirty.

Pull-driven: one recompute per demand. No infinite synchronous loop. An
Effect consumer pulling each microtask loops — caught at consumer level
("max N re-runs per microtask cycle → bail").

(C) doesn't make cycles worse than (B). It just makes the non-cycle case
correct.

### Architecture exposed (post-revision)

K1's design call **dissolves**:

- **(A) Hard ban** — incompatible with effects (per the H1a-c-derived
  observation that effects need to write inside their bodies). The engine
  doesn't know "this tracker is a computed's recipe vs. an effect's body"
  without violating the one-Node-primitive framing.
- **(B) Permit + defer fires** — returns _stale_ values on K1b. **Wrong.**
- **(C) Permit + fire synchronously** — handles K1b correctly; cycles
  caught at consumer level; no re-entrant invocation.

**Settled: (C).** This is essentially r3's model (writes propagate dirty
to subs synchronously; consumers schedule async via the heap + microtask).
Pulse adopts the same semantics, just with the engine chain-match gating which
edges actually fire. Locked into the architecture by [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires)
("Recipes do not open a deferred-fires region") and
[Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified) (tracker
and scope are separate ambients, parallel-coupled — re-entrant writes
inherit the scope of the active recompute).

Implication for [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires) (commit-as-transaction): the deferred-fires region is
**commit-mode-only**, not tracker-mode. Recipes don't open a deferred-fires
region (per Q10's "Recipes do not open a deferred-fires region" — Position
C). Commits do. The two modes don't interfere because a recipe inside a
commit is rare (commits are themselves outside any recompute).

Note on Q10's vocabulary: earlier drafts described `deferredFires` as
"keyed on tracker." Under the resolved architecture, the deferred-fires
region is opened by `closeScope(..., 'commit')`, not by `invoke` — there
is no tracker-keyed region. Fires inside a recipe go through `node.subs`
chain-match synchronously; cascading dirty propagation is the standard
reactive bookkeeping (per H1d).

### Updated framings status after K1+K1b

All four framings still hold:

- _Node-as-recipe_: recipes can write; engine doesn't distinguish kinds.
- _Walks-first-class_: writes propagate dirty via chain-match;
  consumers receive events.
- _Slim engine + thick library_: (C) requires no special engine
  machinery for recipes — just the normal fireEdges path. Cycle detection
  is library code.
- _Scope/owner unification_: unaffected.

**The architecture itself picks (C).** What looked like a deliberate
policy choice (A vs B) was actually a tracing under-specification (K1
didn't probe the write-then-read-derived case that distinguishes B from
C). With the right scenario (K1b), the answer falls out.

---

## G2 — nested actions and commit promotion

A worked trace verifying that the chain-match mechanism handles nested
actions cleanly, and surfacing the inner-promotes-to-outer-vs-direct-to-ROOT
design call. G2 was identified as the smallest-cheap trace that forces a
real policy choice into the open.

### The question

Two positions on what _inner-action commit_ should do:

- **(i) Inner promotes to outer.** Inner's slots (tagged `S2`) get promoted
  to the outer's scope (`S1`), not directly to `ROOT_SCOPE`. Outer continues
  with the inner's writes folded into its scope; outer-commit later promotes
  to `ROOT_SCOPE`. Database "savepoint" semantics — inner's effects are
  _conditional on outer's commit_.
- **(ii) Inner promotes directly to ROOT.** Inner-commit publishes
  immediately; outer's scope doesn't see inner's writes (because the chain
  would still resolve to the outer's earlier slot). Independent-transaction
  semantics.

The architecture forces (i), as the trace shows — but the _why_ is worth
walking through.

### Setup

```ts
const [count, setCount] = signal(0)
const [name, setName] = signal('foo')
const outerReads: any[] = []
const innerReads: any[] = []

action(function* () {
	// outer scope S1
	setCount(10)
	outerReads.push(get(count)) // expect: 10

	action(function* () {
		// inner scope S2, child of S1
		setCount(20)
		setName('bar')
		innerReads.push(get(count)) // expect: 20
		innerReads.push(get(name)) // expect: "bar"
	})

	// After inner commits — what does outer see?
	outerReads.push(get(count)) // expect under (i): 20
	outerReads.push(get(name)) // expect under (i): "bar"
})

// After outer commits
get(count) // expect: 20
get(name) // expect: "bar"
```

Initial state: `count.subs = ∅`, `name.subs = ∅`, `ROOT.slots = ∅`. The
signals have only their `defaultRecipe`s.

### Step-by-step trace under Position (i)

**Step 1: outer opens.** `openScope()` → `S1 = { parent: ROOT, children:
∅, slots: ∅, edges: ∅, writeSet: ∅, readSet: ∅, cleanups: [], status:
'open' }`. `ROOT.children.add(S1)`. Push `S1` as ambient.

**Step 2: `setCount(10)` under `S1`.**

- `getCurrentScope()` → `S1`. `writeSlot(count, S1, { recipe: () => 10,
  cached: 10, deps: [] })`. `S1.writeSet.add(count)`. `S1.slots.set(count,
  slot_C_S1)`.
- Engine fires chain-match for each `edge ∈ count.subs`. `count.subs = ∅`.
  Nothing to fire.

**Step 3: `get(count)` inside outer body.**

- `getCurrentScope()` → `S1`. `currentTracker = null` (action body
  imperative; per [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified)).
- `S1.readSet.add(count)`. `invoke(count, S1)`. `S1.slots.get(count)` hit,
  cached `10`. Return `10`.
- `outerReads.push(10)`.

State after Step 3:

```
count.subs    = ∅
S1.slots      = { count → slot_C_S1(cached: 10) }
S1.writeSet   = { count }
S1.readSet    = { count }
S1.edges      = ∅
ambient = S1
```

**Step 4: inner opens.** Nested `action(...)` call. `openScope()` →
`S2 = { parent: S1, children: ∅, slots: ∅, edges: ∅, writeSet: ∅,
readSet: ∅, cleanups: [], status: 'open' }`. `S1.children.add(S2)`. Push
`S2` as ambient. The scope chain via parent pointers is now
`S2 → S1 → ROOT`, so `chainFor(S2) = [S2, S1, ROOT]`.

**Step 5: `setCount(20)` under `S2`.**

- `writeSlot(count, S2, { recipe: () => 20, cached: 20, deps: [] })`.
  `S2.writeSet.add(count)`. `S2.slots.set(count, slot_C_S2)`.
- Engine fires chain-match for each `edge ∈ count.subs = ∅`. Nothing.

**Step 6: `setName("bar")` under `S2`.**

- `writeSlot(name, S2, …)`. `S2.writeSet.add(name)`. `S2.slots.set(name,
  slot_N_S2(cached: "bar"))`. `name.subs = ∅` → nothing fires.

**Step 7: `get(count)` inside inner body.**

- `S2.readSet.add(count)`. `invoke(count, S2)`. `S2.slots[count]` hit
  (most-specific). Return `20`.
- `innerReads.push(20)`. ✓

**Step 8: `get(name)` inside inner body.**

- `S2.readSet.add(name)`. `invoke(name, S2)`. Hit. Return `"bar"`.
- `innerReads.push("bar")`. ✓

State after Step 8:

```
count.subs    = ∅,    name.subs     = ∅

S1.slots      = { count → cached 10 }
S1.writeSet   = { count },        S1.readSet  = { count }

S2.slots      = { count → cached 20, name → cached "bar" }
S2.writeSet   = { count, name },  S2.readSet  = { count, name }
```

(Note: `S1.slots` has no `name` entry — the outer never read or wrote
`name`. The inner created its slots directly.)

**Step 9: inner returns. `closeScope(S2, 'commit')`.**

Per [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires):

1. Open deferred-fires region.
2. Promote `S2.writeSet = { count, name }` to `S2.parent = S1`:
   - `writeSlot(count, S1, { recipe: () => 20, cached: 20, deps: [] })`.
     `S1.slots.set(count, slot_C_S1_new)` (overwrites the existing entry).
     `S1.writeSet.add(count)` (already present). Fire chain-match for
     each `edge ∈ count.subs = ∅`. Nothing.
   - `writeSlot(name, S1, …)`. `S1.slots.set(name, slot_N_S1)`.
     `S1.writeSet.add(name)`. `name.subs = ∅`. Nothing fires.
3. Walk `S2.edges = ∅`. Nothing.
4. Drop `S2.slots` for `S2.readSet ∪ S2.writeSet = { count, name }`.
   `S2.slots = ∅`.
5. Close children (none).
6. Drain region (empty).
7. `S2.status = 'committed'`. `S1.children.delete(S2)`. Pop ambient to `S1`.

State after Step 9:

```
count.subs    = ∅,    name.subs    = ∅

S1.slots      = { count → cached 20, name → cached "bar" }
S1.writeSet   = { count, name }
S1.readSet    = { count }                  # name was never read at S1
S2            : committed (fully disposed)
ambient = S1
```

The inner's writes have been "lifted" into the outer's scope. From the
outer's perspective, it's as if the inner had been inlined into the outer
body's flow.

**Step 10: `get(count)` after inner commits (still in outer body).**

- `S1.readSet.add(count)` (already present). `invoke(count, S1)` → hit,
  `20`. `outerReads.push(20)`. ✓

**Step 11: `get(name)` after inner commits.**

- `S1.readSet.add(name)`. `invoke(name, S1)` → hit, `"bar"`.
  `outerReads.push("bar")`. ✓

**Step 12: outer returns. `closeScope(S1, 'commit')`.**

Same Q10 procedure, promoting `S1.writeSet = { count, name }` to
`ROOT`:

1. Open deferred-fires region.
2. `writeSlot(count, ROOT, …)`. `ROOT.slots.set(count, …)`.
   `ROOT.writeSet.add(count)`. Fire chain-match for each
   `edge ∈ count.subs = ∅`. Nothing.
   `writeSlot(name, ROOT, …)`. Same.
3. Walk `S1.edges = ∅`. Nothing.
4. Drop `S1.slots` for `S1.readSet ∪ S1.writeSet = { count, name }`.
5. Close children (none — S2 already gone).
6. Drain region (empty).
7. `S1.status = 'committed'`. `ROOT.children.delete(S1)`. Pop ambient.

Final state:

```
count.subs   = ∅,    name.subs    = ∅
ROOT.slots   = { count → cached 20, name → cached "bar" }
ROOT.writeSet = { count, name }
```

`get(count)` outside → 20. `get(name)` → "bar". ✓

### Why Position (ii) doesn't work under the framing

Suppose instead the inner promoted _directly to ROOT_SCOPE_:

**Step 9 (alternate):** `closeScope(S2, 'commit')` promotes to ROOT:

- `writeSlot(count, ROOT, { cached: 20, … })`. `ROOT.slots.set(count, …)`.
- `writeSlot(name, ROOT, { cached: "bar", … })`.
- Drop `S2.slots`.

State after Step 9 alt:

```
S1.slots    = { count → cached 10 }            # unchanged
ROOT.slots  = { count → cached 20, name → cached "bar" }
ambient = S1
```

**Step 10 (alternate):** `get(count)` in outer body. `invoke(count, S1)` →
`S1.slots.get(count)` hit, **cached 10**. `outerReads.push(10)`. ✗

The outer's read returns _the outer's earlier write_, not the inner's
post-commit value. Most-specific-wins per the chain `[S1, ROOT]` resolves
to the `S1` entry first; the inner's commit-to-ROOT is invisible.

It gets worse at outer-commit. **Step 12 (alternate):** `closeScope(S1,
'commit')` promotes `S1.slots[count]` (still cached 10) to `ROOT`. This
**overwrites the inner's earlier commit-to-ROOT** with the outer's stale
value. Final `ROOT.slots[count].cached = 10`. **The inner's commit was
clobbered.**

Position (ii) doesn't work without additional bookkeeping — the engine would
have to detect "outer's slot is stale because a nested scope committed
through it" and refuse to promote the stale value. That's machinery the
nesting model already does for free in Position (i).

**Position (i) is the architecturally correct answer.** The chain mechanism
naturally encodes savepoint semantics; we don't need to engineer them
separately.

### Discard variants

**Inner discards; outer continues.** Setup: inner body throws.

- `closeScope(S2, 'discard')`: skip promotion; walk `S2.edges` (∅); drop
  `S2.slots` for `S2.readSet ∪ S2.writeSet = { count, name }`; fire
  `S2.cleanups` (none). `S2.status = 'discarded'`.
- State: `S1.slots = { count → 10 }`, `ROOT.slots = ∅`.
- Outer continues. `get(count)` under `S1` → 10. `get(name)` under `S1`:
  chain `[S1, ROOT]` miss-miss → `name.defaultRecipe()` → "foo"
  (read-populated into `S1.slots`).
- Outer-commit later: `ROOT.slots[count] = 10`; `name` is in `S1.readSet`
  only (never written) so it drops without promotion.
- ✓ Inner's effects fully unwound.

**Outer discards; inner had committed.** Setup: outer body throws after
inner returns.

- After inner commits: `S1.slots = { count → 20, name → "bar" }`,
  `S1.writeSet = { count, name }`.
- `closeScope(S1, 'discard')`: skip promotion; walk `S1.edges` (∅);
  drop all S1 slots.
- ✓ Outer discard rolls back both outer's _and_ inner's writes. Savepoint
  semantics: inner's commit is conditional on outer's commit. Databases
  work the same way.

If a use case ever surfaces where the inner should _survive_ outer discard
(autonomous inner action), it would be a _different primitive_ — not nested
`action`. Pulse can pick a different name (e.g., `independentAction(...)`)
later if needed.

### Edge invalidation across nested commits

What about external consumers that subscribed to `count` or `name`?

Consider an Effect outside both actions:

```ts
let observed = -1
effect(() => {
	observed = get(count)
}) // chain [ROOT_SCOPE]
```

Initial run: `observed = 0` (from `count.defaultRecipe`, read-populated
into `ROOT.slots`). Edge formed: `edge_eff = { source: count, target:
slot_E_R, targetScope: ROOT }` in `count.subs` and `ROOT.edges`.
`chainFor(ROOT) = [ROOT]`.

During the nested actions above, does the effect re-run?

- _Step 2 (setCount under S1):_ writeScope=`S1`. Chain-match for
  `edge_eff`: `chainFor(ROOT) = [ROOT]`, doesn't include S1.
  **Don't fire.** ✓
- _Step 5 (setCount under S2):_ writeScope=`S2`. **Don't fire.** ✓
- _Step 9 (inner-commit promotion: writeSlot count to S1):_
  writeScope=`S1`. Chain `[ROOT]` doesn't include S1. **Don't fire.** ✓
- _Step 12 (outer-commit promotion: writeSlot count to ROOT):_
  writeScope=`ROOT`. Chain `[ROOT]`, writeIdx=0, no more-specific check
  needed. **Fire** (queued in commit's deferred-fires region).
  Effect's `slot_E_R` invalidates; scheduler queues re-run; region drains.
- Effect re-runs, observes `count = 20`. ✓

The effect fires _exactly once_ after outer commits — not on inner-commit,
not on the outer's earlier `setCount(10)`. Defer-until-commit (H1a-c) holds
across nesting. The effect sees the final committed value, never the
intermediate `10`.

### Architecture exposed

1. **Nested commits are not a special engine feature.** They're just
   `writeSlot(node, parentScope, slot_content)` — the same primitive used
   everywhere else. The "nesting" lives in the scope hierarchy (each scope
   has a `parent`), and the library's commit logic uses
   `scope.parent` as the target. Engine doesn't know about nesting.
2. **The chain-match handles multi-level fall-through automatically.** Reads
   under `S2` walk `chainFor(S2) = [S2, S1, ROOT_SCOPE]`. Each scope in the
   chain is just an opaque key to the engine; the library composes the
   chain from `scope.parent` walks.
3. **Defer-until-commit holds across nesting.** External consumers don't
   see inner-commits, only the outermost commit. Each inner-commit is a
   write to an intermediate scope that _no external chain matches_.
4. **Savepoint semantics fall out of the chain mechanism.** Inner commits
   are conditional on outer commits; outer discard rolls back inner's
   effects. We get database-style nested-transaction semantics without any
   engine-level transaction machinery.
5. **[Q6](./questions.md#q6--what-is-a-scope-as-a-value)
   (scope nesting via parent pointers).** The scope is a linked
   structure with `parent` pointers. `chainFor` walks `scope.parent`
   until `undefined`; terminal is structural, not a privileged
   ROOT_SCOPE key. Per-tenant / multi-world roots fall out for free.
6. **Inner-promotes-to-outer is the _only_ coherent answer** under our
   framings. Position (ii) requires explicit bookkeeping that doesn't fit
   the architecture; Position (i) requires no new machinery.

### Framings status after G2

All four framings held; **G2 is the cleanest validation of scope/owner
unification so far**. The "scope is a tree" structure naturally encodes
savepoints, and the chain-match naturally encode "consumers see only the
final-committed value." No new primitive needed for nested actions; the
nesting is _emergent_ from the scope hierarchy + the chain mechanism.

The trace forces no design call (unlike K1) — the architecture genuinely
picks Position (i). Worth noting because it's a _positive falsification_:
Position (ii) was tested and ruled out by the trace.

### Sub-questions surfaced

1. **`chainFor` policy — resolved** by Q6: terminal is structural
   (`scope.parent === undefined`), not a privileged key. `ROOT_SCOPE`
   is just a library-provided parentless scope. Multiple-roots /
   per-tenant scopes fall out for free.
2. **Edge-ordering during multi-write commits — resolved** by
   [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires):
   promotion walks `S.writeSet` in dep-order leaves-first inside the
   deferred-fires region. Intermediate fires queue without re-running
   consumers, so a derived consumer that depends on multiple promoted
   signals never observes partial state.
3. **Promotion atomicity at the consumer level — resolved** by
   [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires):
   commit IS a deferred-fires region; fires deduplicate by
   `(node, targetSlot)` before draining. Consumers see one invalidation
   per affected slot regardless of how many writes contributed.

---

## H3 — cleanup chains across speculative effect runs

A worked trace of effect cleanup discipline. **The earlier H3a / H3b
scenarios (effect created _inside_ an action body) are no longer
applicable** — per [Q3](./questions.md#q3--consumer-patterns)'s
restriction, calling `effect(...)` inside a speculative scope throws.
The H3a/H3b text below is preserved as a record of how the trace
surfaced the H3b cleanup-vehicle ambiguity that motivated the
restriction; the operative verification trace is **H3b' (effect outside
the action)**, which the resolved architecture handles cleanly.

The single remaining live scenario:

- **H3b':** an effect created _outside_ an action, with an established
  cleanup from its initial run; action commits and triggers the effect.
  Tests: does the previous body's cleanup fire before the new body runs?

### Two kinds of cleanup, distinct in this stack

Before tracing, name the two cleanup mechanisms used in this trace:

- **Scope-level cleanup** — `onCleanup(fn)` called outside an effect body,
  inside any scope (action, component, root). The callback fires when _that
  scope discards_. Sits on `scope.cleanups: Disposable[]`. Used for
  "resource X belongs to this scope; tear it down when the scope ends."
- **Body-level cleanup** — `onCleanup(fn)` called _inside an effect body_.
  Registers a callback that fires before the _next invocation_ of that
  effect's body, **or** when the effect itself is disposed. Sits on
  `effectNode.bodyCleanups`. Used for "this body run produced a
  subscription / timer; cancel it before re-running or when the effect
  ends."

These are distinct: `scope.cleanups` is per-scope; `bodyCleanups` is
per-effect-body-invocation. They compose — an effect's disposal triggers
its bodyCleanups; the scope's discard triggers scope-level cleanups _and_
disposes everything that scope owns (including effects).

### The chain policy for effects-inside-actions

Resolved by [Q11](./questions.md#q11--effect-chain-policy-chain-follows-owner-or-always-root_scope):
**Policy α (chain follows owner).** Sealed structurally by
[Q6](./questions.md#q6--what-is-a-scope-as-a-value)'s scope-centric
storage: an effect created in scope `S` has its tracking edges registered
in `S.edges` with `targetScope = S`. The engine's chain-match consults
`chainFor(S) = [S, ..., ROOT_SCOPE]`. Writes inside `S` match → fire;
writes outside `S`'s chain don't.

H1a-c established that effects _outside_ actions have chain `[ROOT_SCOPE]`
and don't fire on speculative writes — the same answer falls out under
Policy α, because an outside-effect's owner _is_ `ROOT_SCOPE`. For
inside-action effects, Policy α gives natural composition: the effect
reacts to the action's intermediate state, and when the action closes
(commit or discard), its edges die structurally as `S.edges` is walked.

This trace uses Policy α throughout.

### Setup (historical — H3a/H3b)

```ts
const [count, setCount] = signal(0)
const teardowns: string[] = []
const log: string[] = []

const handle = action(function* () {
	// outer scope S
	effect(() => {                          // ← THROWS under Q3 restriction
		const c = get(count)
		log.push(`Effect ran with count=${c}`)
		onCleanup(() => teardowns.push(`cleanup at count=${c}`))
	})
	setCount(5)
})
```

**Under the resolved architecture, the `effect(...)` call above throws**
at creation time: the library walks the scope chain, finds `S.kind ===
'speculative'`, and raises. The H3a/H3b traces below were written
before this restriction was adopted; they're preserved as the record
that surfaced the cleanup-vehicle ambiguity which motivated the
restriction. Skip to [H3b'](#h3b-previous-bodys-cleanup-fires-before-re-run-effect-outside-action)
for the live verification trace.

### H3a (historical): action discards mid-flight

**Step 1: open scope `S`.** `openScope()` → `S = { parent: ROOT, children:
∅, slots: ∅, edges: ∅, writeSet: ∅, readSet: ∅, cleanups: [], status:
'open' }`. `ROOT.children.add(S)`. Push ambient.

**Step 2: `effect(fn)` called.**

- `getCurrentScope()` → `S`. `effectNode = createNode(fn) = { defaultRecipe:
  fn, subs: ∅ }`. Owner = `S`; per [Q11](./questions.md#q11--effect-chain-policy-chain-follows-owner-or-always-root_scope)
  Policy α, the effect's tracking edges will have `targetScope = S`.
- Register `S.cleanups.push(disposeEffectNode)`: when `S` discards, dispose
  `effectNode` (fires its `bodyCleanups`, marks it disposed). The engine's
  own walk of `S.edges` handles edge unlinking from `node.subs`.
- Initial body run:
  - Create `slot_E_S = { recipe: fn, deps: [] }`; `S.slots.set(effectNode,
    slot_E_S)`; `S.readSet.add(effectNode)`. Push `currentTracker = slot_E_S`,
    `currentScope = S`.
  - `get(count)`:
    - `S.readSet.add(count)`. `link(count, slot_E_S)`:
      - `edge1 = { source: count, target: slot_E_S, targetScope: S }`.
        `count.subs.add(edge1)`; `S.edges.add(edge1)`;
        `slot_E_S.deps.push(edge1)`.
    - `invoke(count, S)` → miss → create `slot_C_S = { recipe: () => 0,
      cached: 0, deps: [] }`; `S.slots.set(count, slot_C_S)`. Read-populated
      (per [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally),
      `count` enters `S.readSet` not `S.writeSet`).
  - Body: `c = 0`. `log.push("Effect ran with count=0")`. `onCleanup(cb)`
    registers a _body-level_ cleanup on `effectNode.bodyCleanups`:
    `cb = () => teardowns.push("cleanup at count=0")`.
  - Pop tracker, pop scope.
- `subscribe(effectNode, handler)` — handler schedules a microtask re-run
  on invalidation.

**State after Step 2:**

```
count.subs      = { edge1 }
effectNode.subs = ∅

S.slots         = { count → slot_C_S(cached: 0),
                    effectNode → slot_E_S(deps: [edge1]) }
S.edges         = { edge1 }
S.readSet       = { effectNode, count }
S.writeSet      = ∅
S.cleanups      = [disposeEffectNode]

edge1 = { source: count, target: slot_E_S, targetScope: S }
effectNode.bodyCleanups = [cleanupAtZero]

log       = ["Effect ran with count=0"]
teardowns = []
```

**Step 3: `setCount(5)` under `S`.**

- `writeSlot(count, S, { recipe: () => 5, cached: 5, deps: [] })`.
  `S.writeSet.add(count)`. This overwrites the read-populated `slot_C_S`
  in `S.slots`. Per [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally),
  `count` is now in both `S.readSet` and `S.writeSet` — writeSet
  membership drives commit promotion.
- Engine fires chain-match for each `edge ∈ count.subs`:
  - `edge1`: `chainFor(S) = [S, ROOT]`. `writeScope = S` at index 0.
    No more-specific check needed. **Fire.** Invalidate `slot_E_S`
    (clear cached, mark dirty). Emit slot-changed event.
- Subscriber receives event. `scheduleMicrotask(runBody)`. Re-run queued.

**State after Step 3:**

```
S.slots    = { count → slot_C_S_new(cached: 5),
               effectNode → slot_E_S(dirty, deps: [edge1]) }
S.writeSet = { count }
S.readSet  = { effectNode, count }
microtask queue: [runBody]
log       = ["Effect ran with count=0"]
teardowns = []
```

The body cleanup is _still installed_ — `effectNode.bodyCleanups =
[cleanupAtZero]`. It hasn't fired yet.

**Step 4: action body throws — `handle.discard()` or generator rejects.**

`closeScope(S, 'discard')`:

1. Open deferred-fires region (invariant uniformity).
2. Skip promotion (discard mode).
3. **Walk `S.edges`, remove from `node.subs`.** `S.edges = { edge1 }`.
   Remove `edge1` from `count.subs`. `count.subs = ∅`.
4. **Drop `S.slots`** for `S.readSet ∪ S.writeSet = { effectNode, count }`.
   `S.slots = ∅`.
5. Close child scopes (none).
6. Drain deferred-fires region (empty).
7. **Fire `S.cleanups`** (per [Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy):
   discard only). `S.cleanups = [disposeEffectNode]`.
   - `disposeEffectNode()`:
     - Walk `effectNode.bodyCleanups`. Fire each.
       - `cleanupAtZero()` → `teardowns.push("cleanup at count=0")`.
     - `effectNode.bodyCleanups = []`. Mark `effectNode` disposed.
8. `S.status = 'discarded'`. `ROOT.children.delete(S)`. Pop ambient.

**State after Step 4:**

```
count.subs = ∅                                # edge1 unlinked by step 3
S          : fully disposed
effectNode : disposed (bodyCleanups empty)
log       = ["Effect ran with count=0"]
teardowns = ["cleanup at count=0"]
microtask queue: [runBody]                    ← still queued!
```

**Step 5: microtask drains.**

- `runBody()` is called.
- _Guard:_ check `effectNode.disposed === true`. **Yes.** Bail. ✓
- (Alternative: the scheduler unhooks the subscription on dispose, so the
  microtask is never enqueued in the first place. Either works; the
  guard-on-resume pattern is the simpler/safer one.)

**Final state for H3a:**

```
count.slots = {}                                     # restored to pre-action
effectNode: gone
log = ["Effect ran with count=0"]                    # one body run
teardowns = ["cleanup at count=0"]                   # cleanup fired exactly once
```

✓ The effect ran once (at creation), saw the pre-action state, and its
cleanup fired exactly once when the action discarded. No re-run occurred
because the action discarded before the microtask drained. The action's
speculative writes left no observable trace.

### H3b (historical): action commits — previous body's cleanup fires before re-run

Same setup as H3a, but the action body returns normally instead of
throwing.

**Step 4 (alternate): `closeScope(S, 'commit')`.**

Per [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires):
commit is a deferred-fires region.

1. **Open deferred-fires region.** Fires queue.
2. **Promote writeSet.** `S.writeSet = { count }`. Promote:
   `writeSlot(count, ROOT, { recipe: () => 5, cached: 5, deps: [] })`.
   `ROOT.slots.set(count, slot_C_R_new)`. `ROOT.writeSet.add(count)`.
   Fire chain-match for each `edge ∈ count.subs`:
   - `edge1`: `chainFor(S) = [S, ROOT]`. `writeScope = ROOT` at index 1.
     More-specific check: `S.slots.has(count)`? **Yes** (we haven't dropped
     `S` slots yet). **Skip.** (Per Q12 effects are owned by `S`, so the
     effect's edge is about to die — firing it would be wasted work
     anyway.)
3. **Walk `S.edges`, remove from `node.subs`.** `S.edges = { edge1 }`.
   Remove `edge1` from `count.subs`. `count.subs = ∅`.
4. **Drop `S.slots`** for `S.readSet ∪ S.writeSet = { effectNode, count }`.
   `S.slots = ∅`.
5. Close child scopes (none).
6. **Drain deferred-fires region.** No queued fires.
7. _No `S.cleanups` fired_ (commit is success per [Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)
   — cleanups fire on discard only).

   But the trace expectation here was that an in-action effect's
   `bodyCleanups` fire at commit. With Q12's "scope cleanups fire on
   discard only" resolution, the effect-disposer registered in
   `S.cleanups` does _not_ run on commit. This means the effect is left
   in a stranded state: its tracking edge has been removed (step 3) so
   it can no longer be invalidated, but `effectNode.bodyCleanups` has
   never fired and `effectNode.disposed` remains false.

   The mechanism that should fire bodyCleanups at scope close (regardless
   of commit/discard) is the effect's own teardown path, not a
   `scope.cleanups` callback. The library shape for `effect()` therefore
   needs a separate hook — wired into `closeScope` itself or into the
   "edge from `S.edges` removed → if it was the effect's last edge,
   dispose the effect" structural cascade — that runs on both commit and
   discard. Captured as an open sub-question below.

8. `S.status = 'committed'`. `ROOT.children.delete(S)`. Pop ambient.

**Final state for H3b (under the resolved Q12):**

```
count.subs = ∅
ROOT.slots = { count → slot_C_R_new(cached: 5) }
ROOT.writeSet = { count }
effectNode : edges removed structurally; bodyCleanups NOT fired
             (architectural gap — see below)
log       = ["Effect ran with count=0"]
teardowns = []                                # ← not the original expectation
```

**Architectural note (discrepancy from the original trace).** The earlier
draft of H3b assumed `S.cleanups` fires on commit too, which sourced the
`teardowns = ["cleanup at count=0"]` outcome. Q12's resolution
(commit = success → no cleanup) breaks that assumption for any
disposer registered as a scope-cleanup. The trace's _structural_
finding (the effect is owned by `S`, dies with `S`, doesn't outlive
its owner) still holds, but the _vehicle_ for the disposal must be
something other than `S.cleanups`. The natural place is the
library-side `effect()` shape registering a teardown that runs as
part of the engine's `closeScope` regardless of mode, or as part of
the structural-edge-removal cascade in step 3. **This is a small
new design call surfaced by the trace — not a falsification of the
architecture, but a clarification of where an effect-disposer hook
lives.**

For effects created inside the action: the effect's owner is `S`;
when `S` closes (commit or discard), the effect disposes. Effects
don't _outlive_ their owners. For an effect that should persist past
the action, the user creates it in an outer scope (component, root)
— _its_ owner would be that outer scope, not the action.

This is conventional reactive-framework semantics (Solid, MobX, S.js): an
effect's owner is its containing context, and effects die when their
containers die. Pulse's scope/owner unification preserves this.

The "previous body's cleanup fires before re-run" semantics — what H3b's
title suggests — applies to a different scenario: an effect that
_persists across the action_ (i.e., was created outside the action).
Let me trace that too, as H3b'.

### H3b': previous body's cleanup fires before re-run (effect outside action)

```ts
const [count, setCount] = signal(0)
const log: string[] = []
const teardowns: string[] = []

effect(() => {
	// created outside any action; owner = ROOT_SCOPE
	const c = get(count)
	log.push(`Effect ran with count=${c}`)
	onCleanup(() => teardowns.push(`cleanup at count=${c}`))
})
// log = ["Effect ran with count=0"], teardowns = []
// effectNode.bodyCleanups = [cleanupAtZero]

action(function* () {
	setCount(5)
})
// after commit, the effect should re-run with count=5;
// cleanupAtZero should fire first, then the new body runs.
```

**Initial setup.** Effect's owner = `ROOT_SCOPE`. Per Policy α, tracking
edges have `targetScope = ROOT`. `slot_E_R` lives in `ROOT.slots`.
`edge1 = { source: count, target: slot_E_R, targetScope: ROOT }` in
`count.subs` and `ROOT.edges`. After initial run:
`effectNode.bodyCleanups = [cleanupAtZero]`. Log has "Effect ran with
count=0".

**Action runs. Inside `S`:**

- `setCount(5)`: `writeSlot(count, S, …)`. `S.writeSet.add(count)`.
  `S.slots.set(count, slot_C_S)`. Engine chain-match for `edge1`
  (`targetScope = ROOT`, `chainFor(ROOT) = [ROOT]`): `writeScope = S` not
  in chain → **don't fire.** ✓ (H1a-c.)

**Commit.** `closeScope(S, 'commit')`:

1. Open deferred-fires region.
2. Promote `S.writeSet = { count }`:
   `writeSlot(count, ROOT, { recipe: () => 5, cached: 5, deps: [] })`.
   Fire chain-match for `edge1`: `chainFor(ROOT) = [ROOT]`, writeScope ROOT
   at index 0; no more-specific check needed. **Queue fire** for `slot_E_R`.
   Subscriber receives event → `scheduleMicrotask(runBody)`.
3. Walk `S.edges` (∅) — nothing to remove.
4. Drop `S.slots[count]`.
5. Close children (none).
6. Drain region — `runBody` already scheduled.
7. (Discard-only cleanups not fired.)
8. `S.status = 'committed'`. Pop ambient.

**Microtask: `runBody`.**

- _Guard:_ `effectNode.disposed === false`. Proceed.
- _Fire previous bodyCleanups first._ `cleanupAtZero()` →
  `teardowns.push("cleanup at count=0")`. `effectNode.bodyCleanups = []`.
- _Unlink stale `deps`._ `slot_E_R.deps = [edge1]`. Remove `edge1` from
  `count.subs` and `ROOT.edges`. Reset `slot_E_R.deps = []`.
- Push tracker = `slot_E_R`, scope = `ROOT`. Invoke body:
  - `get(count)`: `link(count, slot_E_R)` → `edge1'` (fresh). `invoke(count,
    ROOT)` → hit, return `5`.
  - Body: `c = 5`. `log.push("Effect ran with count=5")`. `onCleanup(...)`
    registers `cleanupAtFive` → `effectNode.bodyCleanups = [cleanupAtFive]`.
- Pop tracker, pop scope.

**Final state for H3b':**

```
count.subs      = { edge1' }
ROOT.slots      = { count → cached 5,
                    effectNode → slot_E_R(deps: [edge1']) }
ROOT.edges      = { edge1' }
log             = ["Effect ran with count=0", "Effect ran with count=5"]
teardowns       = ["cleanup at count=0"]
effectNode.bodyCleanups = [cleanupAtFive]
```

✓ The previous body's cleanup (`cleanupAtZero`) fired _before_ the new
body ran. The new body registered its own cleanup (`cleanupAtFive`)
which will fire on the next re-run or on effect disposal.

### Architecture exposed

H3 traced cleanly under Policy α (Q11) with one architectural gap
flagged in H3b (the effect-disposer-on-commit vehicle).

1. **Two cleanup mechanisms compose at scope close ([Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)).**
   `scope.cleanups` (the scope's own disposers, **discard only**) and
   `effectNode.bodyCleanups` (per-body cleanups, fire before re-run or
   on dispose). They are distinct mechanisms with distinct triggers.
   For H3a (discard) the disposer registered in `S.cleanups` carries
   the effect's tear-down; for H3b (commit) the disposer cannot be
   registered there because commit doesn't fire scope cleanups —
   surfaced as a new sub-question (where does the effect-disposer
   hook live so it runs on both commit and discard?).
2. **Effect lifetime is owner-scope lifetime, structurally via Q11
   Policy α + Q6 storage.** Effects don't outlive their owners. An
   in-action effect's edges live in `S.edges`; when `S` closes, the
   engine walks `S.edges` and removes each from `node.subs` — the
   effect's reactivity dies structurally with no extra machinery.
3. **Body cleanups fire _before_ re-run, not on resume.** The microtask
   `runBody` fires the previous body's cleanups first, then unlinks
   stale deps, then invokes the body anew (H3b').
4. **[Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally)
   (writeSet vs readSet) was load-bearing in H3a.** `count` entered
   `S.writeSet` (from `setCount(5)`) while `effectNode` stayed in
   `S.readSet` only (read-populated by the effect body's invocation).
   Commit promotion walks `writeSet`; only `count` would have
   promoted. The earlier draft used a per-slot `wasWritten` flag;
   under the resolved Q9, the flag is gone and the scope's writeSet
   carries the same information.
5. **[Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires)'s
   deferred-fires region was empty in H3b** because the chain-match
   for the only edge (`edge1` with `targetScope = S`) skipped (S still
   had a slot at the moment of promotion). In H3b' the region carried
   one queued fire (target slot in `ROOT_SCOPE`).
6. **Policy α survives discard cleanly.** Effects-inside-actions fire on
   action-scope writes, invalidate, schedule re-runs — and the re-runs
   are absorbed by the dispose guard if the scope discards before the
   microtask drains. No spurious effect runs leak past the action.
7. **The microtask-drain-after-dispose race is non-issue.** Synchronous
   `closeScope` completes before any microtask fires; by the time
   `runBody` runs, the effect is disposed and the guard bails.

### Open sub-questions surfaced

1. **Effect chain policy.** **Resolved — Policy α** (per
   [Q11](./questions.md#q11--effect-chain-policy-chain-follows-owner-or-always-root_scope),
   sealed structurally by Q6's scope-centric storage). The trace uses α
   throughout; β is no longer a live alternative.
2. **Effect re-parenting on commit.** Currently the trace disposes
   in-action effects at action close (commit or discard). An alternative:
   on commit _only_, re-parent the effect's owner to `S.parent`, so the
   effect survives. This requires the effect's chain to also update from
   `[S, ROOT_SCOPE]` to `[ROOT_SCOPE]` (or `[S.parent, ROOT_SCOPE]`).
   Probably not worth it — users wanting persistent effects create them
   in the outer scope. But noting as open.
3. **Cleanups during multi-write commits.** Step 4 (alternate) in H3b
   fired the effect's bodyCleanups after dropping S slots but before
   `S.status = 'committed'`. If an effect's bodyCleanup itself calls
   `writeSlot` (re-entrancy during cleanup), the deferred-fires region
   ([Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires)) should absorb that. The trace didn't exercise it. Worth
   tracing if K1-style re-entrancy concerns surface here.
4. **`onCleanup` outside an effect body but inside an action.** What's
   the registration target? Working assumption: `scope.cleanups` of the
   ambient scope, which is the action. Per [Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)
   (commit = success → no scope-cleanup fires), this means an action's
   `onCleanup` only fires on discard. Users wanting "fire on both" use
   the surrounding pattern (try/finally) or an explicit `onSettle`.
5. **Where does an in-action effect's disposer hook live so it runs on
   both commit and discard?** **Dissolved.** The H3b audit surfaced
   this as a real ambiguity. Resolution: in-action effects are now
   forbidden ([Q3](./questions.md#q3--consumer-patterns)). The
   `effect(...)` library helper throws if any ancestor scope has
   `kind === 'speculative'`. No in-action effects means no disposer
   ambiguity to resolve. If a legitimate use case for in-action effects
   emerges, the restriction can be lifted and one of the original
   candidates — (a) library-side cascade, (b) engine `onClose` list,
   or (c) last-edge-removal trigger — picked then.

### Framings status after H3

All four framings held:

- _Node-as-recipe_: effects are Nodes with bodies-as-recipes. Same shape.
- _Walks-first-class_: `get` inside the body forms edges with the right
  chain (per Policy α, the chain is the effect's owner's chain).
- _Slim engine + thick library_: all the cleanup-chain composition is
  library code. The engine fires `scope.cleanups` on discard; the
  library composes effect teardown on top.
- _Scope/owner unification holds, structurally via Q6 + Q11_: an
  effect's owner is its ambient scope at creation; the effect's edges
  live in `ownerScope.edges`; the engine's walk of `S.edges` in
  `closeScope` removes them from `node.subs` automatically (Policy α
  falls out of the storage shape).

**No falsifications**, but H3b surfaced a clarification under the
resolved Q12: scope cleanups fire on discard only, so the "effect's
disposer registered into `S.cleanups`" pattern needs a second hook to
cover the commit path. Captured as a new sub-question (effect-disposer
hook on commit). The architecture supports either resolution; the call
is library-shape.

---

## C2e — post-yield derived read (async K1b analogue)

The canonical async coherence probe. An action body awaits a Promise via
`yield* get`, then synchronously reads a downstream derived whose recipe
depends on the awaited signal. Tests whether the derived sees the resolved
value or the still-Promise-cached value when the action body resumes.

### Setup

```ts
let resolveUser: (v: string) => void
const userPromise = new Promise<string>(r => {
	resolveUser = r
})
const [user, setUser] = signal<string | Promise<string>>(userPromise)

// Derived computed — stage form (canonical for pulse computeds).
// The stage callback sees the unwrapped value (string); output is Promise<string>.
const greeting = compute(
	() => get(user), // stage 0: source — returns Promise<string>
	u => `Hello, ${u}!`, // stage 1: u is string (auto-unwrapped)
)
// greeting: Computed<Promise<string>>

action(function* () {
	const name = yield* get(user) // park until userPromise resolves
	const g = yield* get(greeting) // park until greeting resolves
	console.log(g) // expect: "Hello, Alice!"
})

// later: resolveUser("Alice")
```

**State at start:** `user.subs = ∅`, `greeting.subs = ∅`,
`ROOT.slots = ∅`, `ROOT.edges = ∅`. The Promise is pending.

Note: previous iterations of this trace used a generator-form `greeting`
(`compute(function*() { const u = yield* get(user); return ... })`) —
that form is now superseded by stages for computeds (see the "Stages: a
memoized node + a promise auto-unwrap" framing). Generators are retained
for action bodies only, where multi-yield + commit/discard semantics are
needed.

### What `yield* get` does for a Promise-valued slot

`get(node)` is sync — it returns whatever's cached, which may be `T` or
`Promise<T>`. Inside a generator body (recipe or action body), `yield*
get(node)` parks the generator if the slot's cached value is a Promise,
resuming with the resolved value once it settles:

```ts
function* read<T>(node: Node<T>): Generator<ParkCommand, T, T> {
	const scope = getCurrentScope()
	if (currentTracker) link(node, currentTracker)
	const cached = invoke(node, scope) as T | Promise<T>
	if (cached instanceof Promise) {
		const state = promiseState(cached)
		if (state.status === 'fulfilled') return state.value as T
		if (state.status === 'rejected') throw state.reason
		return (yield { kind: 'park', promise: cached } as ParkCommand) as T
	}
	return cached as T
}
```

`use(node)` is the _leaf-only_ sibling of this: it throws-to-suspend
inside a restartable context (computed recipe — but per the "Unwrap at
the leaf" framing, computed recipes should use `yield* get` or stage
form instead), or peeks-and-throws-on-pending in non-restartable
contexts. The trace below uses `yield* get` throughout, leaf and
intermediate.

### Step-by-step trace

**Step 1: open scope.** `openScope()` → `S = { parent: ROOT, children: ∅,
slots: ∅, edges: ∅, writeSet: ∅, readSet: ∅, cleanups: [], status:
'open' }`. `ROOT.children.add(S)`. Push ambient.

**Step 2: `yield* get(user)` parks.**

- Library `get(user)`:
  - `getCurrentScope()` → `S`. `S.readSet.add(user)`. `currentTracker = null`
    (action body).
  - `invoke(user, S)`:
    - Engine: `S.slots.has(user)`? No. Create `slot_U_S = { recipe:
      user.defaultRecipe, deps: [] }`. Run recipe → `userPromise`. Library
      wraps via `makeAwaitable`: `slot_U_S.cached =
      Awaitable<U, pending>` (an Awaitable instance whose internal state is
      currently `{ status: 'pending' }`). `S.slots.set(user, slot_U_S)`.
      Per [Q4](./questions.md#q4--async-at-the-engine-level), the engine
      attaches nothing — resolution is consumer-handled.
    - Return the Awaitable.
  - `get` sees a pending Awaitable → yields
    `{ kind: 'park', promise: awaitable }`.
- Action driver receives park. **Driver `.then` attach:** attaches
  `awaitable.then(name => step(name), …)`. This is the **sole** `.then`
  on this Awaitable — the consumer that received the Awaitable from `get`
  is the only thing that needs to react to its resolution.
- Driver returns. Sync portion done. Ambient popped.

**State after Step 2:**

```
user.subs   = ∅
S.slots     = { user → slot_U_S(cached: Awaitable<U, pending>) }
S.readSet   = { user }
S.writeSet  = ∅
S.edges     = ∅                        # action body doesn't track
Awaitable<U>.then queue: [driver-handler]
```

**Step 3: `resolveUser("Alice")`.**

The underlying promise resolves. The Awaitable's instance state flips to
`{ status: 'fulfilled', value: "Alice" }` (class-instance state, populated
by the executor pulse owns — see the Awaitable framing). Microtask queue
drains the Awaitable's `.then` handlers:

- _Driver handler runs:_
  - Driver `step("Alice")`. Push ambient = S. `gen.next("Alice")`.

There is no separate engine-level event. The Awaitable's own resolution is
the only signal; the consumer that held it (the driver) handles it. No
edges fire — the action body's `yield* get` didn't track and `greeting`
hasn't been read yet, so there are no subscribers regardless.

**Step 4: generator resumes; `const g = yield* get(greeting)` runs.**

- `gen.next("Alice")` resumes the action body. `name = "Alice"`. Continues
  to `yield* get(greeting)`.
- Library `get(greeting)` (sub-generator):
  - `getCurrentScope()` → `S`. `S.readSet.add(greeting)`.
    `currentTracker = null` (action body).
  - `invoke(greeting, S)`:
    - Engine: `S.slots.has(greeting)`? No. Create `slot_G_S = { recipe:
      greeting.defaultRecipe, deps: [] }`. `S.slots.set(greeting, slot_G_S)`.
      Push `currentTracker = slot_G_S`. Run greeting's stage chain:
      - Stage 0 (source): `get(user)`.
        - `link(user, slot_G_S)` →
          `edge1 = { source: user, target: slot_G_S, targetScope: S }`.
          `user.subs.add(edge1)`; `S.edges.add(edge1)`;
          `slot_G_S.deps.push(edge1)`.
        - `invoke(user, S)` → hit, `cached = Awaitable<U, fulfilled>`
          (already resolved from Step 3).
        - `get` sees Awaitable → checks `.status` → `'fulfilled'`. Returns
          the Awaitable. Stage machinery unwraps to `.value` = `"Alice"`
          before passing to stage 1 (synchronous unwrap since already
          fulfilled).
      - Stage 1: receives `"Alice"`, returns `"Hello, Alice!"`.
    - Stage chain wraps the final value in a resolved Awaitable:
      `slot_G_S.cached = Awaitable<G, fulfilled, "Hello, Alice!">`. This
      preserves type-level async-ness — `greeting` is
      `Computed<Promise<string>>`.
    - Pop tracker. Return the Awaitable.
  - `get` sees Awaitable → `.status === 'fulfilled'` → returns the
    Awaitable. `yield*` machinery unwraps to `.value` = `"Hello, Alice!"`
    **synchronously** (no park).
- `g = "Hello, Alice!"`. `console.log(g)` → prints `"Hello, Alice!"`. ✓

**State after Step 4:**

```
user.subs    = { edge1 }
greeting.subs = ∅

S.slots      = { user → cached: Awaitable<U, fulfilled, "Alice">,
                 greeting → cached: Awaitable<G, fulfilled, "Hello, Alice!">,
                            deps: [edge1] }
S.readSet    = { user, greeting }
S.writeSet   = ∅
S.edges      = { edge1 }

edge1 = { source: user, target: slot_G_S, targetScope: S }
```

Both slots' `cached` values are Awaitables with `status: 'fulfilled'`.
Reads of either node return the Awaitable; consumers in generator contexts
unwrap via `yield*`, sync consumers query `.value` directly. Type-level
async-ness preserved through the graph.

**Step 5: action body returns. `closeScope(S, 'commit')`.**

Per [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires)
+ [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally):

1. Open deferred-fires region.
2. **Promote `S.writeSet`.** `S.writeSet = ∅` — nothing to promote.
   Both `user` and `greeting` are in `S.readSet` only.
3. **Walk `S.edges`, remove from `node.subs`.** `S.edges = { edge1 }`.
   Remove `edge1` from `user.subs`. `user.subs = ∅`.
4. **Drop `S.slots`** for `S.readSet ∪ S.writeSet = { user, greeting }`.
   `S.slots = ∅`.
5. Close children (none).
6. Drain deferred-fires region (empty).
7. `S.status = 'committed'`. `ROOT.children.delete(S)`. Pop ambient.

**Final state:**

```
user.subs     = ∅
greeting.subs = ∅
ROOT.slots    = ∅                    # action never wrote to ROOT
S             : committed (fully disposed)
console output: "Hello, Alice!"
```

The action prints `"Hello, Alice!"` — the resolved value. ✓ The
architecture handles C2e correctly.

### Why there's no timing dependency in the main trace

The main trace has **one `.then` handler** on `user`'s Awaitable — the
action driver's. When the underlying promise resolves, the Awaitable's
instance state flips first (synchronously inside the executor), then the
driver handler runs in the microtask. By the time the driver resumes the
body and the body reaches `yield* get(greeting)`, `user`'s slot already
holds a fulfilled Awaitable. Greeting's stage chain runs synchronously
against it. No race, no ordering invariant.

The previous version of this trace had an "engine `.then` vs driver
`.then`" ordering subtlety because it assumed the engine attached its own
resolution handler to fire `'resolved'` edge events. Under the revised
[Q4](./questions.md#q4--async-at-the-engine-level) framing, that engine
handler doesn't exist — the Awaitable carries its own resolved state and
the consumer that received the Awaitable handles its own resumption. The
ordering question dissolves.

A different ordering question *does* appear in the pre-yield walkthrough
below, but it's library-level (stage-chain vs driver), not engine-level.

### What if the action body had also read `greeting` _before_ the yield?

A subtly different scenario worth noting. If:

```ts
action(function* () {
	const g0 = get(greeting) // BEFORE the yield — sync read
	const name = yield* get(user)
	const g1 = yield* get(greeting) // AFTER the yield — parking read
})
```

Under the corrected setup (stage-form `greeting`):

- _At (A) — `const g0 = get(greeting)` while `user` is pending:_
  `invoke(greeting, S)` runs the stage chain. Stage 0's `get(user)` returns
  a *pending* Awaitable. The stage machinery cannot continue synchronously,
  so it constructs a new Awaitable for `slot_G_S.cached` and chains:
  `userAwaitable.then(u => runStage1(u))`, where `runStage1` resolves the
  new Awaitable with `'Hello, ${u}!'` once `user` settles.

  Now `user`'s Awaitable has **two** `.then` handlers in attach order:
  1. The stage-chain handler (attached just now, during this `get(greeting)`).
  2. (Not yet attached — the action driver hasn't yielded yet.)

  `get(greeting)` returns the pending Awaitable. **`g0` is
  `Awaitable<string>`, pending.** Sync read of an async slot is
  type-honest: the slot's cached value is `Awaitable<string>`, and `get`
  returns exactly that.

- _At (B) — `yield* get(user)` parks:_ the driver attaches its own
  `.then` to `user`'s Awaitable. Attach order is now
  `[stage-chain-handler, driver-handler]`.

- _At (C) — `const g1 = yield* get(greeting)` after the yield:_
  `userPromise` resolves. Microtask drains handlers in attach order:
  1. **Stage-chain handler runs first.** Runs stage 1 against `"Alice"`,
     resolves `greeting`'s Awaitable to `"Hello, Alice!"`. `slot_G_S.cached`
     is now `Awaitable<G, fulfilled, "Hello, Alice!">`.
  2. **Driver handler runs second.** Resumes the action body with
     `name = "Alice"`. Body proceeds to `yield* get(greeting)` → reads
     greeting's slot → fulfilled → returns `"Hello, Alice!"` synchronously.

So in this corrected setup:

| Read site                              | Returns                     | Type              |
| -------------------------------------- | --------------------------- | ----------------- |
| (A) `get(greeting)` before yield       | `Promise<string>` (pending) | `Promise<string>` |
| (C) `yield* get(greeting)` after yield | `"Hello, Alice!"`           | `string`          |

The types are _different at each site by construction_, not by surprise.
`get(greeting)` always returns `Promise<string>` (the static type tells
you so); `yield* get(greeting)` always returns `string` after parking
as needed. The user chooses sync-with-Promise vs park-with-unwrap
explicitly.

### The earlier (anti-pattern) ergonomic surprise — dissolved

The original [C2e trace](#c2e--post-yield-derived-read-async-k1b-analogue) setup used:

```ts
const greeting = computed(() => `Hello, ${use(user)}!`) // ⚠ anti-pattern
```

`use()` mid-graph collapses `Promise<string>` into `string` at the
callsite, hiding async-ness from greeting's type. Then `get(greeting)`
in the action body had a _misleading_ sync-looking type but could
actually return a suspension Promise when `user` was pending. The same
expression returned different types at different times — the surprise.

**Under the corrected setup** (generator-form or stage-form for
`greeting`):

- `greeting` is honestly typed `Computed<Promise<string>>`.
- `get(greeting)` always returns `Promise<string>`. Type is stable.
- `yield* get(greeting)` always returns `string` (parking as needed).
  Type is stable.
- The user chooses by syntax. No surprise.

The earlier surprise was an **artifact of the `use()` mid-graph
anti-pattern**, not an architectural problem with C2e itself. Per the
"Unwrap async at the leaf" framing: intermediate computeds propagate
async-ness through the type; `use()` is reserved for leaf consumption.
With that rule honoured, C2e's coherence story is clean.

### Architecture exposed

C2e traced cleanly. No falsifications. The key findings:

1. **Engine does nothing on Promise resolution.** Consumers that hold an
   Awaitable (the action body's driver, or a stage chain that parked)
   attach their own `.then`. The main trace has a single handler; the
   pre-yield variant has two, ordered naturally by library call sequence.
2. **Stage chains park cleanly on pending upstream Awaitables** by
   constructing a new Awaitable for their own slot and chaining via
   `.then`. The slot's `cached` is always an Awaitable; its `status`
   reflects whether the stage chain has completed.
3. **The action body's post-yield `get(greeting)` is uneventful** —
   greeting's slot is fulfilled by the time the body reads it, so the
   `yield*` unwrap is synchronous. The async dance lives in the stage
   chain, not at the read site.
4. **Q9 is load-bearing.** Nothing promoted on commit because all slots
   were read-populated. This is correct — the action didn't _write_
   anything; it just performed reads with side effects (the
   `console.log`). The action's only purpose was awaiting + observing.
   [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally) distinguishes this from a write-and-commit action cleanly.
5. **Q10 commit-as-transaction is uneventful** here. Nothing to promote;
   the deferred-fires region opens and closes with no fires.

### Sub-questions surfaced (small)

- **What if the action body had reads-before-yield that fall through to
  unresolved Promises?** The "Before the yield" walkthrough above shows
  the type-honest behaviour: `g0` is a pending `Awaitable<string>`. The
  user can inspect `.status`, `.then` it manually, or pass it along. If
  imperative parking-aware reads are desired, `yield* get(node)` already
  provides that — the question is whether a non-yielding `awaitGet(node)`
  helper is worth shipping. **Library ergonomics, not architecture.**
- **Stage-chain `.then` attach order vs driver `.then` attach order.**
  Only matters in the pre-yield-read variant. Natural call sequence
  (stage chain attaches during `get(greeting)` at line 1, driver
  attaches during `yield* get(user)` at line 2) gives the right order
  for free. A library author who manually attaches handlers between
  these calls could disrupt it; the architecture doesn't enforce
  ordering, but no realistic code path violates it.

### Framings status after C2e

All four framings still hold. C2e was a _successful coherence trace_: the
architecture composes correctly across `yield* get` → stages → Awaitable.
The audit's worry — "does the engine's `'resolved'` event have to fire
before resume?" — dissolved entirely under the revised
[Q4](./questions.md#q4--async-at-the-engine-level) framing: there is no
`'resolved'` engine event. Consumers that hold the Awaitable handle their
own resumption; the main trace has a single handler with no race, and the
pre-yield variant has a library-level attach order that's preserved by
the natural call sequence.

**Two framings the trace validated, the second new:**

1. _Derivation kind matches reactivity scope (computed vs effect)._ H5's
   sibling: derivations that depend on async signals don't compose
   cleanly inside imperative action bodies without explicit awaits.
2. _Unwrap async at the leaf, not in the middle of the graph._ The
   original C2e setup used `use()` mid-graph (an anti-pattern); the
   corrected setup uses generator-form or stage-form for intermediate
   computeds, with `use()` / `yield* get` reserved for leaf
   consumption. This dissolves the ergonomic surprise into a clean
   sync-vs-park-by-syntax choice.

---

## H1d — effect-body coherence on commit

Probes commit-promotion ordering through the effect's lens: when an effect's
body reads both a primitive signal _and_ a derived computed that depends on
it, and an action commit promotes the primitive, does the effect's re-run see
the (X, f(X)) pair coherently?

### Setup

```ts
const [count, setCount] = signal(0)
const doubled = computed(() => get(count) * 2)
const observations: Array<{ c: number; d: number }> = []

effect(() => {
	const c = get(count)
	const d = get(doubled)
	observations.push({ c, d })
})
// Initial: observations = [{ c: 0, d: 0 }]

action(function* () {
	setCount(5)
})
// Expected: observations = [{ c: 0, d: 0 }, { c: 5, d: 10 }]
```

### Initial state (after effect registration)

The effect's body ran once at registration under `ROOT_SCOPE`, forming
edges. Per [Q6](./questions.md#q6--what-is-a-scope-as-a-value),
slots live on the scope and `node.subs` is an edge index:

```
count.subs   = { edge_C_D, edge_C_E }
doubled.subs = { edge_D_E }
effect.subs  = ∅

ROOT.slots   = { count   → slot_C_R(cached: 0, deps: []),
                 doubled → slot_D_R(cached: 0, deps: [edge_C_D]),
                 effect  → slot_E_R(cached: undefined,
                                    deps: [edge_C_E, edge_D_E]) }
ROOT.edges    = { edge_C_D, edge_C_E, edge_D_E }
ROOT.readSet  = { count, doubled }   (effect body read both)
ROOT.writeSet = ∅                   (effect was registered, no write yet)

edge_C_D = { source: count,   target: slot_D_R, targetScope: ROOT }
edge_C_E = { source: count,   target: slot_E_R, targetScope: ROOT }
edge_D_E = { source: doubled, target: slot_E_R, targetScope: ROOT }

observations = [{ c: 0, d: 0 }]
```

### Step 1: open scope

`openScope()` → `S = { parent: ROOT, children: ∅, slots: ∅, edges: ∅,
writeSet: ∅, readSet: ∅, cleanups: [], status: 'open' }`.
`ROOT.children.add(S)`.

### Step 2: `setCount(5)` inside the action

- `getCurrentScope()` → `S`. `writeSlot(count, S, { recipe: () => 5,
  cached: 5, deps: [] })`. `S.writeSet.add(count)`. `S.slots.set(count,
  slot_C_S)`.
- Engine fires chain-match for each `edge ∈ count.subs`:
  - `edge_C_D`: `chainFor(ROOT) = [ROOT]`. `writeScope = S` not in chain.
    **Don't fire.**
  - `edge_C_E`: same. **Don't fire.**

**State after Step 2:**

```
count.subs    = { edge_C_D, edge_C_E }   (unchanged)
S.slots       = { count → slot_C_S(cached: 5) }
S.writeSet    = { count }
S.readSet     = ∅
S.edges       = ∅
ROOT unchanged. observations still [{ c: 0, d: 0 }].
```

Committed state untouched per H1a-c (the chain doesn't include `S`).

### Step 3: action returns. `closeScope(S, 'commit')`

Per [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires):
commit is a deferred-fires region. Per
[Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally):
promote `S.writeSet` only; drop slots in `S.readSet ∪ S.writeSet`.

1. **Open deferred-fires region.** Subsequent fires queue.

2. **Promote writeSet.** `S.writeSet = { count }`. Promote:
   `writeSlot(count, ROOT, { recipe: () => 5, cached: 5, deps: [] })`.
   `ROOT.slots.set(count, slot_C_R_new)`. `ROOT.writeSet.add(count)`.
   Fire chain-match for each `edge ∈ count.subs`:
   - `edge_C_D`: `chainFor(ROOT) = [ROOT]`. `writeScope = ROOT` at index 0;
     no more-specific check needed. **Queue fire** for `slot_D_R`. The
     consumer pattern attached to `slot_D_R` (Computed-cache-propagate)
     marks it dirty and walks `doubled.subs = { edge_D_E }` to cascade
     dirty to `slot_E_R`. The effect's scheduler tries to
     `scheduleMicrotask(runBody)` — but we're in a deferred-fires region,
     and the per-Node "scheduled" flag dedups.
   - `edge_C_E`: same chain. **Queue fire** for `slot_E_R`. Mark dirty
     (already dirty — no-op). Scheduler tries again — deduplicated.

3. **Walk `S.edges`, remove from `node.subs`.** `S.edges = ∅` — nothing
   to remove.

4. **Drop S's slots.** `S.readSet ∪ S.writeSet = { count }`.
   `S.slots.delete(count)`. `S.slots = ∅`.

5. **Close child scopes.** None.

6. **Drain deferred-fires region.** Dedupe by `(node, targetSlot)`. One
   logical re-run scheduled: `runBody` for the effect. (Both `edge_C_E`
   and the cascade through `edge_D_E` target `slot_E_R`; dedupe collapses
   them.)

7. `S.status = 'committed'`. `ROOT.children.delete(S)`. Pop ambient.

**State after Step 3:**

```
count.subs   = { edge_C_D, edge_C_E }
doubled.subs = { edge_D_E }

ROOT.slots = { count   → slot_C_R_new(cached: 5),
               doubled → slot_D_R(cached: undefined, dirty,
                                  deps: [edge_C_D]),
               effect  → slot_E_R(dirty, deps: [edge_C_E, edge_D_E]) }
ROOT.writeSet = { count }
microtask queue: [runBody]
observations still [{ c: 0, d: 0 }]
```

All invalidations are now in place. The effect hasn't actually run yet —
microtasks fire after the current sync task (the commit's synchronous
portion) completes.

### Step 4: microtask runs `runBody`

- Guard: `effect.disposed === false`. Proceed.
- Fire previous bodyCleanups (none in this trace).
- Unlink stale deps: `slot_E_R.deps = [edge_C_E, edge_D_E]`. For each,
  remove from `node.subs` and from `ROOT.edges`. Set `deps = []`.
- Push `currentTracker = slot_E_R`, `currentScope = ROOT`.
- Invoke body:
  - `get(count)`:
    - `ROOT.readSet.add(count)`.
    - `link(count, slot_E_R)` →
      `edge_C_E' = { source: count, target: slot_E_R, targetScope: ROOT }`.
      `count.subs.add(edge_C_E')`; `ROOT.edges.add(edge_C_E')`.
    - `invoke(count, ROOT)`: hit. Return cached `5`.
  - `c = 5`.
  - `get(doubled)`:
    - `ROOT.readSet.add(doubled)`.
    - `link(doubled, slot_E_R)` → `edge_D_E'`.
    - `invoke(doubled, ROOT)`: hit, but **dirty**. Recompute.
      - Push `currentTracker = slot_D_R`. Unlink doubled's stale deps.
        Run recipe.
      - Recipe: `get(count) * 2`. Inside: `link(count, slot_D_R)` →
        `edge_C_D'`. `invoke(count, ROOT)` → `5`. Recipe returns `10`.
        `slot_D_R.cached = 10`. Clear dirty. Pop tracker.
    - Return `10`.
  - `d = 10`.
  - `observations.push({ c: 5, d: 10 })`.
- Pop tracker, pop scope.

**Final state:**

```
count.subs   = { edge_C_D', edge_C_E' }
doubled.subs = { edge_D_E' }

ROOT.slots = { count   → cached 5,
               doubled → cached 10, deps: [edge_C_D'],
               effect  → deps: [edge_C_E', edge_D_E'] }

observations = [{ c: 0, d: 0 }, { c: 5, d: 10 }]   ✓ coherent
```

The effect's re-run saw `c = 5` and `d = 10` — both reflecting the
committed state. **Coherent.**

### Why coherence is automatic here

The audit framed H1d as "could the effect see (X=5, f=stale) because the
derived's slot at ROOT_SCOPE wasn't invalidated in dep-order during commit
promotion?" The trace shows: **the architecture makes this impossible by
two compounding mechanisms:**

1. _Cascading invalidation is synchronous._ When `count → doubled` fires,
   doubled's slot is marked dirty _immediately_. Doubled's consumer
   pattern (Computed-cache) walks doubled's subs and propagates dirty
   transitively (also synchronously). By the time `closeScope` returns,
   every consumer downstream of count has been marked dirty.
2. _Consumer re-runs are microtask-scheduled (per H1a-c)._ The effect's
   `runBody` doesn't fire until the next microtask, _after_ the
   synchronous commit completes. By that time, all dirty flags are set;
   any read inside the body invalidates against the dirty flag and
   recomputes (per Position C from K1+K1b — synchronous reads pick up
   dirty state).

So the effect body, when it runs, sees both:

- `ROOT.slots[count].cached = 5` (set during commit promotion).
- `ROOT.slots[doubled]` dirty → recomputes → 10 (recipe reads the
  committed count).

**Q10's commit-region deduplication** is what makes this _efficient_
(one re-run instead of N for an effect that depends on N commit-promoted
signals) — but the coherence itself doesn't depend on [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires). Even with N
re-runs, each one sees coherent state because all invalidations land
before the first microtask.

### Architecture exposed

H1d traced cleanly with no new design calls. The trace validates that:

1. **Position C (synchronous fires) + microtask-scheduled consumers =
   automatic post-commit coherence.** No clever ordering needed at the
   commit-fire level for effect-body correctness.
2. **Computed-cache propagation is synchronous and transitive.** Marking
   doubled dirty cascades to effect through `subs` walking. Standard
   reactive bookkeeping.
3. **Q10's deduplication is an efficiency win, not a correctness
   requirement.** Even without dedup, repeated re-runs see coherent
   state.
4. **The [doubleName trace](#doublename-under-scope-s) open question #1 (commit ordering) is
   non-load-bearing for consumer correctness.** Ordering matters for
   chain-match correctness at writeSlot time (the original concern in
   doubleName), but post-commit consumer reads are always coherent
   because invalidations are synchronous and consumers are async-
   scheduled.
5. **Q9 (writeSet vs readSet) is load-bearing.** `count` is in
   `S.writeSet` → promotes. Any slots in `doubled` or `effect` created
   under `S` (if the effect had been read inside the action) would have
   landed in `S.readSet` and been dropped without promotion. In this
   trace no such slots were created — the effect runs at `ROOT_SCOPE`
   and was never invoked under `S`.

### Sub-questions surfaced (small)

- _Multi-write commits with overlapping consumers._ If the action wrote
  to N signals all depending on the same effect, [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires)'s dedupe ensures
  one re-run. But this trace only had one write. Worth a follow-up
  trace if pulse ever finds itself debugging "why does my effect run 5
  times after a commit." Probably absorbed into [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires)'s existing scope.
- _What if `doubled`'s recipe were async?_ Then the recompute inside
  `invoke(doubled, ROOT)` would yield a park command. The effect body's
  `get(doubled)` would return a Promise; the effect would have to
  `yield* get(doubled)` instead. Crosses into H5 + C2e territory; not
  a new issue.

### Framings status after H1d

All four framings still hold. Position C from K1+K1b is reconfirmed at
the commit-fire level. [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires)'s deferred-fires region works as designed for
deduplication. The "Derivation kind matches reactivity scope" framing is
implicit here — `doubled` is a Computed (synchronously fresh on read);
if it had been an effect-driven signal (H5), the trace would have
returned stale.

**No falsifications. No new design calls.** H1d is a clean validation
trace.

---
