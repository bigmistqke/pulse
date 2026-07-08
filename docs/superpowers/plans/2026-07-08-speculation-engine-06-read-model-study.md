# Speculation Engine — Plan 6: Read-Model Migration Study & Decision (uniform `Awaitable`)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. A **study-and-decide** plan (not TDD code): two tasks produce a findings doc and an ADR that unblock the code plans (7 and 8). Checkbox steps.

**Goal:** Decide *how* to migrate the shipped async read model to the uniform-`Awaitable` model from [`async-reads-and-coordination.md`](../../pulse/async-reads-and-coordination.md) (which supersedes [ADR 0002](../../adr/0002-pending-model.md)'s write-back), because the public `computed()` rewire depends on it — `computed.ts` is built on the model being replaced. No engine code is written here.

**Architecture:** Two tasks. Task 1 studies `src/computed.ts` + `src/async.ts` and writes a findings doc pinning exactly what surfaces the migration touches. Task 2 evaluates the migration approaches against "lean on what's shipped," picks one, and records it as ADR 0011 — including the **sequencing decision**: read-model migration (Plan 7, code) *before* speculation-in-computed (Plan 8, code).

**Tech Stack:** Reading TypeScript (`computed.ts`, `async.ts`, `signal.ts`). No tests run (no code changes).

**Why a study plan (again).** The target read model is *designed* (uniform `Awaitable`; `s()` async → `Awaitable<T>`, no write-back; `.value` is the SWR read; `committed` is the isolation read; `use` suspends). What is *undecided* is how that lands in `computed.ts`'s existing async pipeline (per-stage r3 computeds, an out-of-band `publishedValue` signal, SWR via a `lastResolvedValue` closure, `NotReadyYet` suspension, fast-forward/reuse-value resumption) and `async.ts`'s `latest`/`track`/`use`/`states`/`lastResolved`. Deciding first, then writing real TDD tasks, is the honest order — the same call made for the r3 integration in Plan 2.

---

## Seed findings (from a full read of `computed.ts` + `async.ts` — Task 1 verifies + deepens)

**Where the ADR-0002 pending model lives today:**

- **`async.ts`.** `latest(s)` = the SWR/readiness read: reads `s()`, and if it's a promise, `track()`s it and returns the fulfilled value or the last resolved value from a `lastResolved` WeakMap (SWR). `use(x)` = the opt-in throw: returns the value or throws `NotReadyYet(promise)`. `track(p)` maintains a `states` WeakMap (`pending`/`fulfilled`/`rejected`) by attaching `.then`. `read(x)` = the generator-side `yield*` resolver. So the *promise state* lives in two WeakMaps (`states`, `lastResolved`) keyed off the promise / accessor — **not** on the value object.
- **`computed.ts`.** Each stage is an r3 computed (`makeStageNode`) with: an out-of-band `publishedValue` signal (the view value — a resolved `T`, or the pending `Promise` on first load, or the prior value under SWR); a `lastResolvedValue` closure (SWR sentinel `UNRESOLVED`); `suspendOn` + settle handlers; `pendingSig` (feeds `isPending`); and two resumption modes (`fast-forward` for generators via a `kick` signal, `reuse-value` for sync/async via a stash). Value-change is gated by `Object.is` against `lastResolvedValue`.
- **`signal.ts`.** A signal stores `T | Promise<T>` as-is (no write-back — that was already removed); `track` is installed on promise values so `latest`/`isPending`/`use` see settled state.

**The load-bearing implication:** the uniform-`Awaitable` model moves the promise *state* (`status`/`value`/`reason`) and the *SWR prior value* **onto the `Awaitable` object itself**, replacing the `states` + `lastResolved` WeakMaps and the `publishedValue`/`lastResolvedValue` machinery. `s()` async returns that `Awaitable` uniformly (no flip to bare `T`). `.value` becomes the SWR read (subsuming `latest`); `committed` becomes the isolation read; `use` still suspends (reads `.status`). The *semantics* pulse already implements (SWR, pending, suspend) largely survive — what changes is *where the state lives* (on the object, not in side WeakMaps + an out-of-band signal).

---

## Task 1: Study the read model and write the findings doc

**Files:**
- Create: `docs/pulse/read-model-migration-notes.md`
- Read (do not modify): `src/computed.ts`, `src/async.ts`, `src/signal.ts`, `src/pending.ts`, `docs/pulse/async-reads-and-coordination.md`, `docs/adr/0002-pending-model.md`

- [ ] **Step 1: Read the source + the target design.** All of `computed.ts` and `async.ts`; the relevant parts of `signal.ts`/`pending.ts`; and the target model in `async-reads-and-coordination.md` + `ADR 0002`.

- [ ] **Step 2: Answer these probe questions in `docs/pulse/read-model-migration-notes.md`** (cite the code each rests on; verify/correct the seed findings):

  1. **State relocation.** Exactly which state moves from side-storage onto an `Awaitable`? Map each of `async.ts`'s `states` WeakMap and `lastResolved` WeakMap, and `computed.ts`'s `publishedValue` signal + `lastResolvedValue` closure, to its `Awaitable` equivalent (`.status`/`.value`/`.reason`), or note if it must stay.
  2. **Where the `Awaitable` is created.** For a signal written a promise (`signal.ts` setter) and for a stage returning a promise (`computed.ts` `runStage` outcome), where does the `T | Promise<T>` become an `Awaitable<T>`? Is it one wrap point (a `toAwaitable`) or several?
  3. **`.value` subsumes `latest`.** Can every current `latest(s)` caller be replaced by `s().value` (or `committed` where isolation is meant)? List the callers (grep `latest(`) and classify each as readiness (`→ .value`) or isolation (`→ committed`).
  4. **`use` under `Awaitable`.** Does `use(x)` still throw `NotReadyYet`, now reading `.status === 'pending'` off the `Awaitable` instead of the `states` WeakMap? Any behavior change for the JSX/Loading suspension path?
  5. **`computed.ts` pipeline survival.** Which of `makeStageNode`'s parts survive as-is (dep-tracking r3 computed, `pendingSig`, the two resumption modes) and which are replaced (the `publishedValue` out-of-band signal, `lastResolvedValue` SWR, `Object.is` change-gating) when the view value is an `Awaitable`?
  6. **`stabilize`/glitch interactions.** Does moving state onto the `Awaitable` change anything about r3 scheduling or the existing SWR/pending tests? Which existing test files (grep `test/async`, `test/pending`, `test/computed`, `test/effect-stages`) most constrain the migration?
  7. **Speculation dependency (scoping only).** Confirm that making public computeds *scope-aware* (Plan 8) is cleaner *after* this read-model migration than before, and note why (so the sequencing decision in Task 2 is grounded).

- [ ] **Step 3: Commit.**

```bash
git add docs/pulse/read-model-migration-notes.md
git commit -m "docs(pulse): read-model migration study (uniform Awaitable vs shipped model)"
```

---

## Task 2: Decide the migration approach + sequencing; record ADR 0011

**Files:**
- Create: `docs/adr/0011-<slug>.md`
- Modify: `docs/pulse/read-model-migration-notes.md` (append the decision)

- [ ] **Step 1: Evaluate the approaches** against the findings, in the notes doc:

  - **A — Awaitable adapter (minimal delta).** Introduce `Awaitable<T>` as a thin `Promise` subclass carrying `{status, value, reason}` (and the SWR prior value); add one `toAwaitable` wrap point at the signal-setter and stage-outcome boundaries; retarget `.value`/`committed`/`use` and `computed.ts`'s view to read the `Awaitable`, retiring the `states`/`lastResolved` WeakMaps and `publishedValue`/`lastResolvedValue`. Keep the r3 dep-tracker + resumption modes. *Pro:* smallest change; preserves the proven pipeline. *Con:* the `Awaitable` must faithfully reproduce SWR + pending, and both the old and new state homes may briefly coexist during the migration.
  - **B — Native rewrite.** Rebuild `makeStageNode` so the stage's view value *is* an `Awaitable` end to end (pending = `.status`, SWR = `.value`), removing the out-of-band `publishedValue` signal entirely. *Pro:* one coherent model, less indirection. *Con:* larger blast radius across the async/pending/effect-stages tests.
  - **C — Parallel surface, gradual migrate.** Keep the current model, add `Awaitable` + `.value`/`committed` as a new surface, migrate callers over time. *Pro:* low risk per step. *Con:* two models coexisting indefinitely — the exact "honest types" muddle the uniform model is meant to end.

- [ ] **Step 2: Pick one + decide sequencing; write ADR 0011.** Criteria: (1) lean on the shipped pipeline (its SWR/pending/resumption are hard-won and tested); (2) end state is the single uniform `Awaitable` model (rules out C as an end state); (3) keeps the existing async/pending/effect-stages suite green through the migration. Record: the chosen approach; that the read-model migration is **Plan 7 (code)** and speculation-in-computed is **Plan 8 (code)**, in that order; and cross-links to `async-reads-and-coordination.md`, `ADR 0002` (superseded-in-part), and `ADR 0008` (Object.is dedup, which the change-gating interacts with).

  *Author's lean (not binding — Task 1 decides):* **A**, then **B**-style cleanup later if the adapter leaves too much indirection. The pipeline's SWR/pending/resumption is exactly the semantics the `Awaitable` needs; relocating state onto the object is a smaller, safer delta than a native rewrite, and it keeps the big async test suite as the behavior spec.

- [ ] **Step 3: Commit.**

```bash
git add docs/adr/0011-*.md docs/pulse/read-model-migration-notes.md
git commit -m "docs(adr): 0011 — uniform-Awaitable read-model migration approach + sequencing"
```

---

## After this plan

- **Plan 7 (code): adopt the uniform `Awaitable` read model** per ADR 0011 — introduce `Awaitable`, retarget `.value`/`committed`/`use`, rework `computed.ts`'s view, retire `latest`/`states`/`lastResolved`/`publishedValue` as the ADR directs. Tests: the existing async/pending/effect-stages suite (behavior-preserving) + the `Awaitable` faces from `async-reads-and-coordination.md` (`.value`/`yield*`/`use`, `.status` disambiguation).
- **Plan 8 (code): speculation in public computeds** — make `computed()` scope-aware on the new read model (route stage reads through the overlay; speculative recompute of the pipeline). Tests: a public computed reflecting an action's speculative writes; C2/C2e async-under-action.
- Then **`reject`** (Q15/D1 — version counters + `discardCause: 'conflict'`), **`settled([...])`** barrier, and optimistic/standing-state surfaces.

## Self-review

**Coverage:** understand the shipped read model (Task 1, findings doc, seven source-cited questions) → decide the uniform-`Awaitable` migration approach + sequencing (Task 2, ADR 0011). Produces exactly what Plans 7–8 need; no migration code claimed here (it cannot be written honestly before the approach is fixed — the same reasoning as Plan 2).

**Placeholder scan:** no fabricated code or "TBD" steps. Deliverables are concrete (a findings doc answering seven specific questions; an ADR choosing among three described approaches + fixing the Plan 7/8 order). `<slug>` in the ADR filename is named-after-decision, not a placeholder.

**Consistency:** the three approaches (A/B/C) in Task 2 map onto the state-relocation findings in Task 1 (probe 1/5); the sequencing decision rests on probe 7. Seed findings are flagged *to verify*, not settled.
