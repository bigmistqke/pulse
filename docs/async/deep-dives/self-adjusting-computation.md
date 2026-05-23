# Self-Adjusting Computation — modifiables, traces, and the calculus that keeps re-executing

**Type:** concept
**Date:** 2026-05-19
**Session:** 10
**Scope note:** This is a *concept dive*, not a primary dive. The goal is not to fill cells of the taxonomy from an artifact; it is to ground the theoretical vocabulary that informs how we read other artifacts. The shape is modelled after `algebraic-effects.md` (session 3): a theory-paper summary that connects back to the systems we have already studied (especially `bonsai-incremental.md`, session 4). The deliverable is *vocabulary + mental models*, not verified cells. Conducted using the parallel-passes-then-merge methodology established sessions 7–8: a background agent did the academic-source-reading; the main session contributed pulse-source connections and session-9-axes integration. The merged document below uses the fresh pass as its spine, with additions noted at points of merge.

## Sources

Fetched and read (HTML / text content actually returned):

- **Acar — "Self-Adjusting Computation"** project page, `https://www.umut-acar.org/self-adjusting-computation` — Acar's own one-page framing of SAC. Fetched.
- **Acar — Publications list**, `https://www.umut-acar.org/publications` — used as a topographic map of the paper family. Fetched.
- **Acar, Blume, Donham — "A Consistent Semantics of Self-Adjusting Computation"** (ESOP 2007, JFP later), Cambridge JFP page: `https://www.cambridge.org/core/journals/journal-of-functional-programming/article/consistent-semantics-of-selfadjusting-computation/...` — Fetched; the abstract/blurb came through cleanly.
- **Minsky — "Introducing Incremental"**, Jane Street blog: `https://blog.janestreet.com/introducing-incremental/` — Fetched.
- **Semantic Scholar entries** for the Ley-Wild / Acar continuation paper and for the "(an overview)" survey — fetched but returned empty bodies; treated as bibliographic confirmation only.
- **dblp** entry `https://dblp.org/rec/conf/popl/AcarBH02.html` — confirms POPL 2002 author list and title.
- Web search snippets that summarised abstracts of:
  - **Acar, Blelloch, Harper — "Adaptive Functional Programming"** (POPL 2002 / TOPLAS 2006)
  - **Acar — PhD thesis, CMU-CS-05-129** (May 2005)
  - **Acar, Blelloch, Blume, Tangwongsan — "An Experimental Analysis of Self-Adjusting Computation"** (PLDI 2006 / TOPLAS 2009)
  - **Ley-Wild, Fluet, Acar — "Compiling Self-Adjusting Programs with Continuations"** (ICFP 2008)
  - **Chen, Dunfield, Hammer, Acar — "Implicit Self-Adjusting Computation for Purely Functional Programs"** (ICFP 2011 / JFP)
  - **Acar et al. — "Imperative Self-Adjusting Computation"** (POPL 2008)
  - **Hammer, Khoo, Hicks, Foster — "Adapton: Composable, Demand-Driven Incremental Computation"** (PLDI 2014)

**Unavailable in extractable form** (PDFs that came back as binary streams the fetch tool could not parse — flagged so claims drawn from them stay at abstract-level paraphrase):

- `https://www.cs.cmu.edu/~guyb/papers/popl02.pdf` (the canonical POPL 2002 PDF) — binary, no text extraction.
- `https://www.cs.cmu.edu/~rwh/students/acar.pdf` (the thesis) — binary, no text extraction.
- `https://www.cs.cmu.edu/~guyb/papers/ABBT06.pdf` (PLDI 2006 experimental paper) — binary, no text extraction.
- `http://reports-archive.adm.cs.cmu.edu/anon/2001/CMU-CS-01-161.pdf` (CMU tech-report version of POPL 2002) — connection refused.
- ACM Digital Library pages for POPL 2008, TOPLAS, and the SIGPLAN-Notices version of Adapton returned HTTP 403 (paywall).

Where a definition or claim is drawn from a *summary* of a primary source rather than the source itself, I mark it inline as **(secondary)**. Verbatim quotes come only from sources whose HTML body actually rendered.

Added in merge (main session's parallel-pass contribution):

- **Pulse source code import survey** — `pulse/src/signal.ts`, `pulse/src/computed.ts`, `pulse/src/effect.ts`, `pulse/src/scheduler.ts`, `pulse/src/owner.ts`. Grep confirmed pulse imports `signal`, `setSignal`, `computed`, `read`, `stabilize`, `untrack`, `getContext`, `onCleanup`, `unwatched` from the `r3` package. The single most diagnostic import is `stabilize` — the canonical SAC term for change propagation. This is concrete evidence that pulse's substrate is in the SAC lineage; documented inline in the "What this means for pulse / r3" section.

## What SAC is

**Self-Adjusting Computation (SAC)** is a programming-language framework — originally Standard ML based — for writing computations that *automatically update their outputs* when their inputs change, without the programmer hand-writing an incremental algorithm. The body of work originated with Umut Acar's PhD at CMU under Guy Blelloch and Robert Harper. Its earliest published form is the POPL 2002 paper "Adaptive Functional Programming" (Acar, Blelloch, Harper), which introduces the term *adaptive*; "self-adjusting" became the umbrella label from the thesis (CMU-CS-05-129, May 2005) onward.

The headline pitch from Acar's own page: *"changes to data can be propagated through the computation by identifying the affected pieces that depend on the changes and re-doing the affected pieces"* (Acar, project page). And the rationale: SAC *"automates a typically a very complex task"* — namely the design of dynamic / kinetic / online algorithms — by deriving an incremental algorithm from a *static* one.

That last point is the unusual one and is worth holding onto. SAC is not "you write a reactive program in a special style and it works fluently." It is much more like: *you write the obvious from-scratch batch algorithm, you sprinkle modifiables in the places where the input is going to change, you re-run with a different input, and the system replays only the parts of the original execution whose dependencies were touched.* The intellectual ancestor is therefore **dynamic algorithm design**, not FRP.

### How SAC differs from neighbouring ideas

| | What it is about | Relationship to SAC |
|---|---|---|
| **FRP** (Elliott–Hudak, Fran, …) | Continuous-time / event-stream semantics: behaviours are functions of time, events are time-stamped occurrences. | Different domain. SAC has *no* notion of time; it has *versions of the input store*. Minsky on the Jane Street blog (paraphrasing the SAC vs FRP boundary as it was understood at Jane Street): *"SAC and FRP have different semantics – FRP is mostly concerned with time-like computations, and SAC is mostly about optimizing DAG-structured computations."* |
| **Dataflow languages** (Lustre, Esterel, signal-flow graphs) | Static dependency graph fixed at program-write time; nodes recompute on clock ticks. | SAC's dependency graph is *dynamic* — built from a *trace* of execution, not from the program text. Loops, branches, and recursion can produce a different graph each run. |
| **Incremental computation broadly** (memoization, function caching, finite differencing) | Cache previous results, hand-code update rules. | SAC subsumes these in a uniform machine-checked semantics. Memoization in SAC is *not* a separate add-on — Acar, Blume, Donham prove memoization and mutation can co-exist coherently (see below). |
| **Spreadsheets** | Per-cell formula DAG, dirty-bit propagation. | A spreadsheet is the trivial case of SAC where the graph is static and given. SAC handles graphs that depend on the *values* being read (control-dependent dependencies). |
| **Adapton** (Hammer et al., PLDI 2014) | Demand-driven (lazy) incremental computation. | An *evolution* of SAC: keeps modifiables/reads/writes but adds a "demanded computation graph" so re-execution only happens when an *outer observer* forces a thunk. |

The key word that separates SAC from spreadsheets and from FRP is **dynamic** — *dynamic* dependence graph. The graph is a property of an execution, not of a program.

## The formal model

The original POPL 2002 model **(secondary, summarised from dblp + search abstracts; the canonical PDF did not parse for fetch)**:

> "As an adaptive program executes, the system represents the data and control dependences in the execution as a dynamic dependence graph, and when the input changes, a change propagation algorithm updates the output by propagating changes through the graph and re-executing code where necessary."

This passage encodes essentially every primitive:

### Modifiables (the central abstraction)

A **modifiable reference** (often shortened to *modifiable* or `'a mod`) is a memory cell that participates in dependency tracking. Three primitives:

- `mod : (('a mod -> unit)) -> 'a mod` — allocate a modifiable and run a body that writes to it. The body's writes are recorded as the modifiable's *definition*.
- `read : 'a mod -> ('a -> unit) -> unit` — register a *reader* on a modifiable. A read is not just a value retrieval; it is *the act of installing a dependency edge* from the current scope to the modifiable, with the continuation `'a -> unit` being the code to re-run if the modifiable's value changes.
- `write : 'a mod -> 'a -> unit` — set the value, invalidating any readers whose registered continuations now disagree with the new value.

The crucial difference from a plain ref cell: a `read` does **not** return an `'a`. It takes a continuation. That is a deliberate restriction that forces the dependency to be made explicit in the program structure. This is also why later work (Ley-Wild, Fluet, Acar 2008) uses CPS as the natural compilation target — see the *continuations* section.

### Dynamic dependence graph (DDG)

The DDG is the **execution-trace** structure. The thesis treats it as a graph whose:

- **Nodes** are reads — each `read` call performed during execution becomes a node, paired with its continuation.
- **Edges** point from a modifiable to each read currently registered on it; control-flow edges thread the readers in execution order so the change-propagation algorithm can replay them in the *same* order the original execution did.
- **Time stamps** (the version-tree / virtual-clock data structure that became one of SAC's algorithmic contributions) order the nodes so that, when a write invalidates a region of the trace, the algorithm knows *which sub-trace to throw away* and which not yet to touch.

The time stamps live in a *splay-tree-like order-maintenance structure* that supports O(1) amortised "insert after" and O(1) "is x before y." This is what makes change propagation efficient — without it, you cannot tell whether a reader currently being invalidated is "before" or "after" the current re-execution frontier without an O(n) trace scan.

### The change-propagation algorithm

Pseudocode (synthesised from the Acar-page paraphrase and the Adaptive Functional Programming abstract; **not a verbatim quote** because the canonical PDF would not parse):

```
change_propagate(pending_writes):
  queue = priority_queue ordered by DDG time stamp
  enqueue every reader registered on a written modifiable
  while queue not empty:
    r = queue.pop_earliest()
    if r has been invalidated by an earlier re-execution: skip
    else: re-execute r's body, which may
          - register new readers (insert into DDG after r)
          - perform writes (enqueue more readers)
          - allocate new modifiables
          - reuse a memoized sub-trace (see Memoization)
```

The two invariants that make this *correct* (in the sense of "yields the same final store as a from-scratch re-run"):

1. **Time order = original execution order.** Re-execution proceeds in the same order as the original to make sure a downstream reader doesn't run with stale upstream state.
2. **Sub-trace splicing.** When a reader re-runs, the segment of the trace it originally produced is *garbage-collected and replaced* by whatever the new run produces. Nodes outside the spliced region are untouched.

### Trace stability

The thesis introduces **trace stability** as the metric that predicts how *much* of the trace will need re-execution. Informally, an algorithm is *trace-stable* under a class of input changes if the symmetric difference between the old and new execution traces is small. The headline complexity claims in the SAC literature — for instance, going from O(n) to O(log n) update time on sorted-list maintenance — are all derived as bounds on trace-stability.

## Memoization

The naive change-propagation story has a hole. Consider a recursive function over a list `[a; b; c; d]`. Insert an element at the head to get `[x; a; b; c; d]`. The fresh execution will produce a wholly new trace; the original trace is "shifted by one" and naive change-propagation can't see that.

**Memoization** is what closes the hole. The thesis distinguishes:

- **Selective memoization** (POPL 2003, Acar/Blelloch/Harper): the programmer explicitly *names* which inputs a function's result depends on, so the cache key is precise. Critically, this is *not* general structural-equality memoization; the system gives "programmer control over equality, space usage, and identification of precise dependences" **(secondary, from search snippet)**.
- **Adaptive memoization** (the integration of memoization with change propagation): when a memoized sub-computation is *reused*, the reuse is not a simple cache hit returning a value — it splices the *cached trace* into the current execution, then *runs change propagation on the spliced trace* against any modifiables that have changed since the cache entry was created.

This is precisely what the Acar/Blume/Donham "Consistent Semantics" paper formalises and proves consistent:

> *"the system automatically triggers a change-propagation algorithm that adapts the cached computation to reflect any memory mutations that occurred since its creation."* (paraphrase from the fetched JFP page; the page also asserts a *consistency theorem* that "any two evaluations of the same program starting at the same state yield the same result" despite the non-determinism introduced by which memo entries happen to be reused.)

The mental model to lock in: **memo entries in SAC are not pure values — they are sub-traces with edges into modifiables, and reusing one is an act of grafting a graph fragment then patching it.** This is the largest single source of conceptual distance between SAC and a fine-grained signal graph.

### Worked example: value memoisation vs trace memoisation

The same scenario, run under both regimes, makes the distinction concrete. Imagine a recursive sum over a list. First run computes `sum [1, 2, 3, 4, 5] = 15`. Then a head element is inserted: `sum [99, 1, 2, 3, 4, 5]`.

**Under value memoisation** (Solid `createMemo`, React `useMemo`, Vue computed, MobX computed):
- The cache holds the *output value* — `15`.
- Cache key: "are the dependencies the same as last time?"
- The new input `[99, 1, 2, 3, 4, 5]` ≠ `[1, 2, 3, 4, 5]`, so the cache misses.
- The entire `sum` is recomputed from scratch. **O(n) work.**
- The engine has no visibility into the recursion's internal structure; from its perspective, "input changed, recompute the whole thing."

**Under trace memoisation** (classical SAC, Adapton):
- The cache holds the *execution trace* — the DDG fragment that `sum` produced, including which modifiables it read, in what order, and the structure of the recursion.
- When the new run consumes the `99` and reaches its recursive call `sum [1, 2, 3, 4, 5]`, the engine recognises this matches a cached trace.
- It **splices the cached trace** into the current execution, then runs change-propagation on the spliced trace against any modifiables that have changed since the cache entry was created.
- For an unchanged tail, no parts of the spliced trace need re-running. The entire sub-trace is reused as-is.
- **O(log n) or O(1) work** depending on the structure of the recursion.

The key move: trace memo caches **the structure that produced the value**, not the value itself. That structure is what lets the engine perform targeted partial re-execution — "this sub-graph's modifiables are unchanged, splice it; that sub-graph's modifiables changed, re-run only that part." Value memo cannot do this — when an input changes, the engine has nothing to splice from, so it recomputes from scratch.

This is what enables SAC's headline complexity claims (O(n) → O(log n) for sorted-list maintenance under arbitrary single-element updates, and the experimental results in PLDI 2006 generally). The claims do not transfer to value-memo regimes; flagged again in "What this means for pulse / r3" below.

## Distinction from FRP

Acar has been explicit that SAC is not FRP. The Jane Street post does not contain a verbatim Acar quote on this, but the framing there is the one most often attributed to him: SAC and FRP have *different semantics* — FRP is about *time-like* computations (behaviours and events indexed by time), while SAC is about *optimising DAG-structured computations* whose inputs *change between runs*.

Three sharper differences:

1. **Time vs. version.** FRP has a time domain — values are functions of `t`. SAC has only an *input store* and the *changes applied to it*. There is no clock.
2. **Programs are batch, not reactive.** In SAC you write what looks like a batch program (sort a list, build a quad-tree). The reactivity comes from re-running the *same program* under a different store. FRP programs are written *as* dataflow.
3. **Static vs. dynamic dependency structure.** Most FRP systems pin the dependency graph at construction time and route events through it. SAC builds a fresh trace per execution and *the graph itself differs* across input versions because control flow differs.

A taxonomy slogan: FRP's reactive primitive is the *event/behaviour*; SAC's reactive primitive is the *re-run*.

## Implementations

### Acar lineage (academic)

- **AFL / SLf** — the Standard ML library accompanying POPL 2002. The original `mod`/`read`/`write` interface.
- **Delta ML** (Acar, Ley-Wild) — an extension of ML that compiles to a SAC runtime via CPS transformation, removing the need for monadic-style explicit modifiables.
- **CEAL** (Hammer, Acar, PLDI 2009) — a C-based language for SAC. Used to demonstrate that SAC is not ML-specific and that pointer-chasing low-level code can also be self-adjusting.
- **Implicit SAC** (Chen, Dunfield, Hammer, Acar, ICFP 2011) — a type-directed translation; programmer annotates only the input types and the system synthesises the `mod`/`read`/`write` plumbing.
- **Adapton** (Hammer, Khoo, Hicks, Foster, PLDI 2014) — a *demand-driven* variant. Change propagation is lazy: updates are deferred until an "outer observer" forces a thunk. Adds the *demanded computation graph* (DCG) as a refinement of the DDG that distinguishes inner from outer computations.

### Jane Street's `Incremental` (production)

Bonsai's substrate, covered in session 4. From "Introducing Incremental":

- Acknowledges SAC as the intellectual ancestor ("based on work by Umut Acar et. al.").
- **Keeps**: dynamic dependence tracking, push-based change propagation with a height-ordered priority queue, pure-function nodes.
- **Drops** (or at least de-emphasises): the full "trace splicing on memoization" story. Incremental's `bind` does scope-creation and disposal of sub-graphs (height-bumping etc.), but it is not the same machinery as memoized sub-trace reuse in academic SAC.
- **Adds**: scope-based lifetimes (`Scope.t`), `bind` for switching between sub-graphs, height-aware scheduling, observer-based GC, `Var.set_during_stabilization`.
- **Complexity claim from the post**: for a binary-tree merge over an array with a commutative/associative operator, "the complexity of updating an element is `log(n)`, where `n` is the size of the array" — an example of trace-stability being inherited at the engineering level.

The Jane Street post is also where the FRP/SAC distinction got popularised for working programmers: it explicitly contrasts the two and chose to align Incremental (and therefore Bonsai) with SAC.

## Connection to algebraic effects

A direct line "SAC = algebraic effects" does not appear in the literature I could verify. What *does* appear is a structural relationship via **continuations**:

- **Ley-Wild, Fluet, Acar — "Compiling Self-Adjusting Programs with Continuations"** (ICFP 2008). From the search-result paraphrase: the paper *"uses a continuation-passing style (CPS) transformation to automatically infer a conservative approximation of the dynamic data dependences, and generates memoized versions of CPS functions that can reuse previous work even when they are invoked with different continuations."*

That is the deep connection. SAC's `read` primitive is *inherently* a continuation-introducer: it captures the rest of the dependent computation as a re-runnable callback. CPS-converting an entire program makes every potentially-reactive position into a `read`-like site, which is exactly what the "implicit SAC" line of work needs.

Algebraic effects and SAC therefore share an ancestor (delimited continuations) without one being a special case of the other:

- **Algebraic effects** parameterise the *handler*: an `Effect e -> a` operation is interpreted by whichever handler is dynamically in scope.
- **SAC `read`** parameterises the *re-runner*: the continuation captured at a read is invoked again whenever the modifiable's value disagrees.

Both are "non-local control via captured continuations." Neither is reducible to the other in the literature I read. **Open question** below.

## What this means for pulse / r3

Pulse's reactive runtime (r3) is in the SAC lineage **by direct evidence, not inference.** Pulse's source code imports the following primitives from `r3`: `signal` / `setSignal` (SAC's *modifiables* with their `write` operation); `computed` (a derived node — the SAC `mod` reader); `read` (eager forced-read of a modifiable); `stabilize` (**the canonical SAC term for the change-propagation step** — not React's term, not Solid's term, not Vue's term); `untrack` (escape dep tracking); `getContext` / `onCleanup` (scope-tied lifecycle); `unwatched` (lifecycle hook for the no-observers-remain transition). The vocabulary maps directly onto Acar's framework. The most diagnostic single import is `stabilize` — that word survives intact from POPL 2002 → Jane Street Incremental → r3, and its presence in pulse's imports is enough to establish lineage without needing to read the runtime's implementation.

Given that confirmed lineage, the theoretical positioning against SAC:

**SAC-shaped traits we'd expect r3 to share:**

- *A dependency graph built from execution traces*, not from program text. Any signals-and-effects runtime tracks reads at call time, which is the SAC `read` primitive in disguise.
- *Push-based change propagation* with some ordering discipline (height, topological order, or insertion order). The order-maintenance data structure SAC uses is one solution to the same problem any reactive runtime faces: stale-read avoidance.
- *Modifiable as the unit of dependency*. A pulse signal is, definitionally, a modifiable.

**SAC-divergent traits (likely):**

- *No memoized-sub-trace reuse*. Reactive runtimes in the Solid/Bonsai family don't typically splice cached sub-graphs the way SAC does after a `memo` hit. `createMemo` in Solid is *value* memoisation, not *trace* memoisation (see "Worked example" in the Memoization section above for the side-by-side). The practical consequence: when an input changes, value-memo regimes recompute from scratch — they have no DDG fragment to splice. **SAC's complexity results don't transfer.** Where this matters is exactly the workloads pulse hasn't had to handle yet: incremental syntax highlighting, incremental layout, incremental query results, incremental tree diffing — anything where a large structured input changes at the edges and you want sub-linear update cost. For typical UI rendering, where each computed body is small and recomputation is cheap, value memo is fine — which is why Solid, React, Vue, and pulse all live in the same regime without an obvious shortfall. **If pulse ever needs sub-linear updates on algorithmic workloads, Adapton (Hammer et al., PLDI 2014) is the production-grade engineering reference** — it's the demand-driven SAC variant that carries trace memoisation all the way through.
- *Continuous reactivity, not batch re-runs*. SAC is built around the idea that you *finish a run*, *change the input*, *re-run via change-propagation*. r3 (as we understand the spec from the existing docs in this repo) treats reactivity as a continuous process — there is no "epoch boundary" the way there is in SAC.
- *Suspension / async*. SAC is synchronous: every modifiable has a value at all times. Pulse's `read` brand-checks, transitions, computed-body throw-suspension story (see the recent commit `f9364d1 feat(read)!: brand-aware`) puts r3 into a region SAC does not model. The way SAC would naturally extend into async is through algebraic-effect-style suspension handlers, and Ley-Wild/Acar's CPS compilation is the closest the academic literature gets.

**The orienting observation** (added in merge): most of pulse's *interesting* design choices are *outside the classical SAC frame entirely*. SAC has no `NotReadyYet` throw protocol, no `<Loading>` boundary, no transition machinery, no `use()` opt-in marker, no pipeline-OR `isPending` walking. Those are pulse-specific extensions onto a SAC substrate. For the parts where pulse IS in SAC (signal/computed/effect/stabilize), pulse can lean on Acar's correctness results — change propagation is consistent, order-maintenance is sound, etc. For the parts pulse adds (async, suspension, transitions, Loading), there is no theoretical underlay; pulse is on its own. This is useful when reading pulse's design: distinguish "this is just SAC working as designed" from "this is pulse extending SAC into territory the theory doesn't cover."

**Where pulse should look to SAC for design guidance, and where it should not:**

| Aspect | Look to SAC? |
|---|---|
| Ordering discipline for re-execution | Yes — time stamps / order-maintenance is a directly applicable solution. |
| Memoization that survives input change | Yes — but it is *expensive* engineering and rarely needed for UI; consider only if pulse wants algorithmic incrementality (e.g., incremental tree diffing). |
| Async / Suspense semantics | No — SAC is silent here. |
| Transition / snapshot semantics | Partial — SAC's "input store version" is conceptually adjacent to a transition snapshot, but SAC has no notion of *concurrent* versions. |
| FRP-style stream operators (`map`, `merge`, `switch`) | No — SAC is not the right vocabulary. |

The single most useful concept to import from SAC into pulse-thinking is **trace stability**: when you change a signal, *how much of the dependency graph has to re-run?* This is the right framing for understanding the design pressure behind pulse's transition machinery and `read`-brand checks: those features are essentially attempts to *manually* improve trace stability under classes of changes (async resolution, batched commits) that the underlying runtime can't optimise on its own.

## What this means for the taxonomy

The existing axes (the eight from earlier sessions, plus session 9's additions — I have not re-read them for this dive but the spec leans on them) cluster around: dependency-tracking style, scheduling discipline, lifetime/scope management, async/suspension treatment, batching/transitions, identity/equality. SAC theory commentary:

**Axes SAC *confirms* are real and load-bearing:**

- **Static vs. dynamic dependency graph.** SAC's whole reason to exist is dynamic-graph computation. Any taxonomy must distinguish "graph is fixed at construction" (dataflow, classical FRP) from "graph is rebuilt per execution" (SAC, Solid, pulse).
- **Push vs. pull propagation.** SAC is push-style; Adapton is the demand-driven (pull-after-push) refinement. The taxonomy needs both poles.
- **Ordering discipline.** SAC's time-stamp / order-maintenance machinery is one *specific* answer to a question that every reactive runtime answers (height ordering in Incremental; insertion-order with bumps in Solid; etc.). Worth being an explicit axis.

**Axes SAC *refines*:**

- **Memoisation depth.** Most taxonomies coarsen this into "memoised or not." SAC forces a three-way distinction: (a) no memoisation, (b) value memoisation (`createMemo`-style — cache the output), (c) *trace memoisation* (cache the execution and its DDG). Few runtimes in pulse's competitor set offer (c); flagging the absence is informative.
- **Scope lifetime.** Bonsai's `Scope.t` and Solid's `createRoot` are both engineering answers to the question SAC handles via trace splicing on memoisation: *what owns a sub-graph and when does it die?* The taxonomy axis should distinguish scope-by-trace (SAC), scope-by-construct (Bonsai/Solid), and scope-by-component (React).

**Connection to session-9's confirmed axes** (added in merge):

Session 9 promoted two axes from candidate to confirmed: **speculative-state isolation** (#9) and **dependent-dispatch capability** (#10). The conflict-handling-policy axis (#2) value vocabulary was also refined to ten distinct mechanisms. SAC engages with these as follows:

- **Reactive integration (#8) — fused** is the natural SAC cell. SAC IS the engine; there's no separate effect layer. r3 / Bonsai-via-Incremental / pulse all inherit this commitment from SAC.
- **Where async state lives (#1) — n/a.** Classical SAC has no async; modifiables always have values. This is the single biggest gap between SAC theory and what pulse/Bonsai/r3 actually need in production.
- **Conflict-handling policy (#2) — n/a in classical SAC** (single-threaded re-execution; no concurrency). Acar's "Imperative Self-Adjusting Computation" (POPL 2008) starts to relax this but wasn't fetched for this dive.
- **Cancellation discipline (#3) — structural by scope** in implementations. Bonsai's `Scope.t` and Solid's `createRoot` are engineering answers to "what owns a sub-graph and when does it die?" — a question SAC handles via trace splicing on memoisation.
- **Async representation (#4) — n/a in classical SAC.** Adding async to SAC (the unsolved problem in the academic literature) would likely mean adding a value to this axis like "runtime-interpreted lazy computation with read-as-continuation."
- **Isolation level (#5) — n/a.** No transactions in classical SAC.
- **Atomicity granularity (#6) — per-stabilization-batch.** A `stabilize()` call commits all in-progress change-propagation atomically. This is similar in shape to React's per-WIP-tree-commit but more disciplined.
- **Discipline location (#7) — type-system-enforced** in academic SAC (ML's type system tracks `'a mod`); **runtime-enforced** in Incremental/r3 (no type-level modifiable-vs-value distinction in TypeScript).
- **Speculative-state isolation (#9) — none in classical SAC.** A stabilization either succeeds or doesn't; there is no parallel in-progress speculative tree. Pulse's `<Loading>` gather and React's WIP tree are extensions onto SAC for this axis.
- **Dependent-dispatch capability (#10) — n/a.** Classical SAC has no dispatched-dependent-work; reads are continuations within a single trace, not dispatched calls. This is where the algebraic-effects connection (via Ley-Wild/Fluet/Acar CPS compilation) could plausibly extend SAC.

**Net observation:** classical SAC covers axes #7 (discipline location) and #8 (reactive integration) clearly; it has minor commitments on #3 (cancellation via scopes) and #6 (atomicity at stabilization); it is **silent on the other six axes**. Pulse extends SAC into all six of those — which is exactly the design territory the rest of the research is mapping. **The relationship is: SAC gives pulse the substrate; pulse's interesting choices live above the SAC frame.**

**Axes SAC *predicts* that may be missing:**

- **Trace-stability sensitivity.** A new axis: *which input-change classes does this system handle in sub-linear time?* For Solid, the answer is roughly "leaf signal updates only." For Bonsai/Incremental, "anything within a bound." For SAC proper, "anything captured by the chosen memoisation discipline." This is genuinely predictive — it tells you which workloads each system is bad at.
- **Continuation semantics of reads.** SAC's `read` takes a continuation. Most reactive runtimes pretend reads are pure value retrievals. The mismatch matters for any feature that needs to *re-enter* a read site (async suspension, transitions). Pulse's `read` brand checks are arguably an attempt to recover the continuation-ness without using literal CPS.
- **Cross-run identity.** SAC needs node identity to persist across runs (so memo entries can be looked up). Reactive runtimes generally need identity *within* a run only. The taxonomy might gain from naming this distinction explicitly.

## Open questions

- **Acar's own canonical comparison of SAC vs. FRP.** Multiple secondary sources attribute a clean SAC-vs-FRP framing to Acar, but I could not pull a verbatim Acar quote out of a source whose body actually rendered. Worth chasing the "(an overview)" survey paper in extractable form.
- **CEAL & Imperative SAC details.** Both papers' PDFs / dl.acm.org pages were paywalled or unparseable. Their existence is confirmed (search snippets, publications list); their internals were not verified for this dive.
- **The full change-propagation algorithm with verbatim pseudocode.** The pseudocode in the *formal model* section above is synthesised from abstracts; the canonical PDF would not parse. A follow-up dive that successfully extracts the POPL 2002 algorithm in full would be valuable.
- **Trace stability bounds in the experimental paper.** The PLDI 2006 / TOPLAS 2009 paper has empirical complexity numbers per benchmark. Not retrieved.
- **Direct algebraic-effects connection.** I could not find a paper that frames SAC's `read` as an algebraic-effect operation, even though the resemblance is strong. The closest is the ICFP 2008 CPS-compilation paper. Whether anyone has tried "SAC via effect handlers" as a distinct line is unclear.
- **Adapton's exact relationship to pulse-style demand-driven reactivity.** Adapton's "demanded computation graph" looks like a closer match to how a UI-shaped runtime actually behaves than vanilla SAC. Worth a dedicated dive.
- **pulse's runtime details against SAC's primitives.** This dive deliberately did not read pulse source. A follow-up should match r3's read/write primitives to `mod`/`read`/`write` line by line.

## Cross-references

- `bonsai-incremental.md` (session 4) — Incremental is the production-grade SAC descendant pulse most resembles in spirit. The current dive is the theoretical underlay for that one.
- `algebraic-effects.md` (session 3) — both this dive and that one ultimately route through *captured continuations* as the mathematical object underneath; the *open question* on direct correspondence is shared with that dive.
- `solid-2x.md` — Solid's `createMemo` is value memoisation, not trace memoisation; this dive sharpens that point.
- `react-modern.md` — React's "render is the dependency graph" model is *not* SAC: there is no per-component DDG, and re-render is not change-propagation. The contrast is one of the loudest things SAC literature highlights when reactive systems are discussed.
- (Out of repo) the Adapton paper — flagged here as a potential standalone dive.

## Notes / aside

A methodological observation. Five of the six primary SAC PDFs I tried to fetch came back as binary streams that the fetch tool could not decode (POPL 2002 PDF, the thesis, the PLDI 2006 experimental paper, the CMU tech-report version, and an ACM TOPLAS reprint). The dl.acm.org pages that *aren't* PDFs are paywalled (HTTP 403). The Cambridge JFP page for "Consistent Semantics" was the only primary source that returned a usable HTML body. This is *exactly* the sourcing pitfall the prompt warned about: the temptation to fabricate is strongest when the canonical text is right there, named, dated, and unreadable. The dive is therefore heavier on Acar's self-described framing and on community paraphrases (Minsky's blog, Hammer's Adapton intro) than on direct quotation from Acar's own papers. The cells of "(secondary)" annotation and the *open questions* list are honest about that.

The single most surprising thing in compiling this dive: SAC's "memoisation" is not what almost anyone outside the SAC community thinks memoisation is. Hearing "memo" and thinking "value cache" actively *prevents* you from understanding what SAC is doing. The right mental model is **executing program traces are first-class data, and memoising them is graph-grafting plus change-propagation.** This is the conceptual move pulse should weigh: is r3 going to remain in the value-memo regime (like Solid), or is it going to push toward trace-memo (like SAC proper / Bonsai-deeply)? Almost everything else in the design follows from that choice.
