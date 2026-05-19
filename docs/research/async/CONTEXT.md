# Research Conventions — Async Strategies

This document governs how the async-strategies research is conducted. It is read-only for any individual session: changes to the conventions themselves should be discussed and committed deliberately, not in passing during a deep-dive. The conventions exist so each session inherits the prior session's discipline rather than re-litigating it.

See the main research log at `./README.md` for the framing, taxonomy table, session chronology, and deep-dive index. This file is the *meta*: how the work is done.

## Purpose

To inform pulse's async-coordination API choices (transactions, actions, the reactive/effect-layer boundary) by understanding the broader async-coordination design space across programming. The research is **broader than pulse** because:

- Trade-offs aren't local. Picking one model closes doors on adjacent ones; we need to understand the adjacent doors before walking through any.
- pulse's available primitives are a fraction of what's been explored elsewhere; the research is about what an *encoding* of richer models into JS can and cannot recover.
- The output isn't "the right answer." It's enough understanding to articulate what we're sacrificing with any given choice.

This is not a survey for publication. It's working knowledge for design decisions. Every entry should pay rent toward an eventual choice pulse will make about its async surface.

## Framing (the immovable constraint)

JavaScript does not provide the primitives most async-coordination traditions assume:

- No first-class continuations (one-shot or multi-shot).
- No native effect handlers.
- No channels as a language primitive.
- No actors as a language primitive.
- No STM.
- No linear / affine / capability typing for static resource control.
- No effect rows in the type system.
- No structured concurrency as a language feature.

What JS does give us: Promises, generators, ambient mutable slots (module-level vars), owner trees (via convention), try/catch, microtask scheduling, WeakMaps, AbortController. Any model pulse ends up with is an **encoding** of one of the richer models into these tools. **Every encoding loses something.** The research is about understanding each model's full shape well enough to choose which losses are acceptable.

This framing applies to every deep-dive: when summarizing a model, the question isn't just "what does it do" but **"what would an encoding of this into JS lose, and what would it gain over what we have now."**

## Process

### Cadence

Research is slow. Time-box per session, not per-domain. A deep-dive may take multiple sessions to complete properly; that is fine. Don't truncate a deep-dive to fit a session boundary.

The order of deep-dives is not predetermined. Pick based on:

- Which axis of the taxonomy is most ambiguous and which deep-dive would clarify it.
- Which system is most foundational to multiple other systems (e.g. algebraic-effects theory is upstream of effect-ts, OCaml 5, React Suspense, Koka, all at once).
- Which thread the previous session opened.
- Pragmatic interest. Don't force-march through an alphabetical list.

### Per-session shape

Every session should:

1. Read the session log ([`./LOG.md`](./LOG.md)) to recall where the last session left off (open threads, unresolved questions).
2. Pick *one* concrete piece of work for the session — a single deep-dive (or a continuation), or a taxonomy refinement, or a sourcing pass.
3. Do the work with primary sources where possible (see sourcing discipline).
4. Update the relevant artifact (deep-dive doc, taxonomy table, axes list).
5. Append a session-log entry to [`./LOG.md`](./LOG.md): what was done, what was learned, what open questions emerged, what the next session might pick up.

Sessions should NOT:

- Skip the log entry. The chronology is the only record of *why* the taxonomy looks the way it does.
- Make sweeping changes to the conventions in passing. Convention changes belong in their own commit with a rationale.
- Draw cross-cutting conclusions before three or more deep-dives have provided the evidence.

### Deep-dive sourcing discipline

Each deep-dive should have an explicit sources list. Acceptable sources, in order of preference:

1. **Primary** — the system's official documentation, papers by the original authors, the source code if applicable, official tutorials.
2. **Secondary** — talks by the original authors, blog posts by core contributors, well-cited textbooks.
3. **Tertiary** — community summaries, blog posts by outsiders, framework comparisons.

When a claim is from memory and unverified, mark it explicitly with `[unverified]` or `[from-memory]`. The goal is not to forbid synthesis from memory — that's how working knowledge accumulates — but to keep the distinction visible so future readers know which parts have been checked.

When a deep-dive contradicts memory-based content in the taxonomy table, the deep-dive wins; update the cells.

Web search and `WebFetch` are appropriate for verifying URLs and pulling primary sources. When fetching, prefer the official site / repo / paper PDF over secondary summaries.

### Status indicators

The taxonomy rows carry status indicators:

- 🟡 **draft** — populated from prior conversational notes or synthesis from memory. Needs verification.
- ⚪ **pending** — row exists as inventory marker; minimal one-line characterization only.
- 🟢 **verified** — a deep-dive doc exists, primary sources are cited, and cells reflect what the dive found.

A row may only be promoted to 🟢 when:

- A deep-dive doc exists at `deep-dives/<slug>.md`.
- The deep-dive cites at least one primary source.
- All cells in the row have been considered (cells marked `n/a` are fine; cells marked `—` are NOT — they mean "axis hasn't been thought through for this system yet").
- The deep-dive's session-log entry is added to the chronology.

Promoting to 🟢 is the formal close-out of researching a system. It is allowed (and expected) to demote 🟢 → 🟡 if a later deep-dive reveals contradictions; this is information, not failure.

### When a deep-dive promotes a row

When a deep-dive completes:

1. The deep-dive doc itself is committed to `deep-dives/<slug>.md`.
2. The corresponding row's status moves 🟡 → 🟢 (or ⚪ → 🟢 if the row was a pending stub).
3. Cells that the deep-dive revealed to be wrong or imprecise are updated.
4. Any new axes the deep-dive surfaced are added to the open questions section (with the proposing deep-dive cited), but NOT immediately added to the table without explicit decision (see Taxonomy Maintenance).
5. Cross-references are added: the deep-dive should link to other deep-dives it relates to, and the main README should link to the new deep-dive in the index.
6. The session log gets an entry describing what was learned, what changed in the taxonomy, and what threads the dive opened.

## Taxonomy maintenance

### Adding axes

A new axis is added only when:

- A deep-dive (or multiple) reveals that existing axes flatten a meaningful distinction between systems.
- The distinction matters for pulse's eventual design decisions (i.e. would pulse make a different choice if it landed on different sides of this axis).
- At least two systems differ meaningfully on the proposed axis.

Adding an axis is a structural change; commit it separately from any deep-dive that motivated it. Update existing rows (most will be ⚪ for the new axis until further dives address them).

Axes should NOT be added preemptively from theoretical interest. Let them emerge.

### Updating cells

Cells can be updated:

- During a deep-dive on that row's system.
- During a deep-dive on a *different* system that revealed something about this one (e.g. studying effect-ts may sharpen our understanding of Haskell STM).
- During a taxonomy-only session where existing cells are reviewed against the current axis definitions.

Cell updates that demote 🟢 → 🟡 (because the cell no longer matches the deep-dive's finding) require a session-log entry explaining what changed and why.

### Splitting / merging / renaming rows

If a deep-dive reveals that what we treated as one system is actually two (e.g. "Postgres MVCC" with different isolation levels has fundamentally different cells per level), split the row. The split should be in its own commit with a session-log entry.

If two systems turn out to be encodings of the same model with cosmetic differences only, they can be merged. But this is rare and should require evidence in the deep-dives, not just intuition.

Renaming rows happens when the deep-dive reveals the system is properly called something else (e.g. "React useEffect+useState" → "React modern" or specifically "React Suspense + transitions + lanes" — see the session-1 correction).

### When the taxonomy itself changes

Structural changes (new axes, row splits, axis renames, deletions) should be committed in their own commit, separate from content updates. The commit message should explain the structural change so reviewing git log gives a coherent picture of how the framework evolved.

## Deep-dive structure

A template should live at `deep-dives/_template.md` once it exists. Until then, deep-dives should at minimum include:

1. **System / topic name** — what's being studied.
2. **Source list** — citations to primary docs, papers, source files, talks. Each citation should be linkable.
3. **What it is** — one-paragraph description in our vocabulary (not the system's).
4. **The async-coordination model** — how it handles each of our scenarios where applicable (S1–S8 in `../scenarios/concurrent-flows.md`).
5. **Taxonomy cells** — explicit per-axis claims with evidence (citing source list).
6. **What an encoding of this into JS loses or gains** — the central framing applied.
7. **Open questions raised** — what this dive surfaced for the broader research.
8. **Cross-references** — to other deep-dives, to taxonomy rows, to scenarios.
9. **Date + session** — when the dive was conducted.

Deep-dives are not papers. They can be short if the system is simple; they can be long if it's not. Length is governed by what's needed to support the taxonomy cells with evidence, not by a target.

## Vocabulary specific to this research

Terms used precisely in this research; their use elsewhere in pulse may be looser.

- **Encoding** — a JS implementation that approximates a primitive from another language/system. Always lossy. The set of "encodings of model X into JS" is the design space we explore.
- **Transferable lesson** — an insight from a domain or system that informs pulse's design even if pulse won't adopt the system itself. Cross-domain deep-dives exist to extract these.
- **Verified cell** — a taxonomy cell whose content has been checked against primary sources in a deep-dive. Marked by the row's 🟢 status.
- **Axis** — one column of the taxonomy table. A dimension along which async-coordination strategies meaningfully differ. New axes emerge from deep-dives; they are not declared up front.
- **System** — one row of the taxonomy table. An async-coordination strategy that competes in pulse-adjacent design space.
- **Cross-domain** — a system or mechanism that does NOT compete in pulse's design space (because it's a different problem, layer, or scale) but has transferable lessons.
- **Concept** — a theoretical framework that affects how we interpret systems (algebraic effects theory, delimited continuations, CSP, etc.). Concept deep-dives don't taxonomize systems; they sharpen the lens.
- **Open question** — a known unresolved issue in the framework or in our understanding. Documented in the README's open-questions section; resolved as deep-dives provide evidence.

## Anti-patterns

Mistakes we want to avoid (some learned from prior sessions, some flagged preemptively).

- **Don't describe a system by its historical workaround.** When picking what to put in a system's row, identify what the system's *current* primary primitive is, not what people did before the system shipped a proper answer. Example: React's async story is the fiber reconciler's lane-based Suspense / transitions / `use()` / `useOptimistic`, NOT `useEffect + useState`.
- **Don't conflate "not in the taxonomy" with "not researched."** Many systems are worth deep-diving even though they don't compete in pulse's design space. The cross-domain section of the deep-dive index exists for exactly this reason.
- **Don't synthesize trade-offs before three deep-dives.** Cross-cutting conclusions ("the right answer is X") require evidence from multiple systems. Until the evidence is there, treat trade-off claims as hypotheses, not conclusions.
- **Don't add taxonomy axes preemptively.** New axes should emerge from deep-dives revealing that existing axes flatten meaningful distinctions. Adding axes from theoretical interest produces empty columns that bias future deep-dives.
- **Don't guess URLs or paper IDs.** When citing, fetch or search. A wrong citation is worse than a vague one.
- **Verify upstream files before citing them as upstream evidence.** Finding a file at the root of an external repo is not evidence that the project's team produced or endorses it. Run `git status` / `git log` on the file before quoting it as the project's roadmap or design intent. Untracked files, locally-modified files, and forks all look like upstream code at a glance. Session 7 learned this the hard way — a pulse design draft accidentally written into the Solid repo was momentarily cited as "Solid's roadmap." Always check tracking and authorship.
- **Don't truncate a deep-dive to fit a session.** Research isn't a sprint. If a dive needs three sessions, take three sessions.
- **Don't update CONTEXT.md in passing.** Convention changes deserve their own commit and rationale. This file is meta; changing it should be deliberate.
- **Don't promote a row to 🟢 without a deep-dive doc.** The status indicator is meaningful only if the rules are followed.
- **Don't treat the taxonomy table as the deliverable.** The table is a working artifact; the deliverable is the cumulative understanding that informs pulse's design decisions. The table organizes what we know; the deep-dives ARE what we know.

## See also

- `./README.md` — the main research log with framing, taxonomy table, deep-dive index. Stable structural document.
- `./LOG.md` — append-only session chronology. Where each session records what was done, learned, and left for next time.
- `./deep-dives/` — individual system / cross-domain / concept deep-dives.
- `../scenarios/concurrent-flows.md` — the scenarios and policy questions that motivate the research. Scenarios S1–S8 are acceptance tests any candidate async strategy must address; policy questions Q1–Q5 are decisions the research informs.
- `../../CONTEXT.md` (root) — pulse's project conventions and language. The Conceptual model section there is what this research feeds back into.
- `../superpowers/specs/2026-05-17-pulse-transitions-redesign.md` — the design history that motivated starting this research.
- `../../README.md` — the comparative analysis against Solid 2.x. Should be revisited and refined as the research matures.

---

Changes to this file should be made in their own commits with a rationale in the commit message. Linked from the main README; updated when conventions change.
