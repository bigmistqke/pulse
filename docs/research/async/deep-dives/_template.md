# [System / topic name]

**Type:** primary | cross-domain | concept
**Taxonomy row(s) affected:** _link to row name(s) in the README table_
**Status after this dive:** 🟢 verified | 🟡 still partial | 🟡 demoted from previous 🟢
**Date:** YYYY-MM-DD
**Session:** N

---

## Sources

Primary sources cited in this dive, in roughly the order of consultation. Each entry should be a working link (verified, not guessed).

1. **[Title](URL)** — what we used it for (e.g. "API reference for STM module").
2. **[Title](URL)** — …

Secondary/tertiary sources (blog posts by core contributors, community summaries) go below in a separate list if used:

- _none_, or:
- [Title](URL) — what we used it for; flag any claims relying on this as `[unverified]`.

---

## What it is

One-paragraph description, **in our research vocabulary** (not the system's own terminology). The goal is to make this dive comparable to other dives. Use terms from [`../CONTEXT.md`](../CONTEXT.md)'s vocabulary section.

If the system's own terminology must be introduced, name it explicitly: "the system calls this X; we treat it as our concept Y."

---

## The async-coordination model

How the system handles each piece of the design space. Not every system addresses every scenario; mark "n/a" with a one-line reason where applicable.

### Conflict handling

What happens when concurrent operations touch the same state. Cite sources for non-obvious claims.

### Cancellation

How in-flight work stops. What runs (finalizers, compensations). What post-cancellation operations look like.

### Suspension / resumption

How work pauses on an async dependency and resumes when it settles. Whether this is re-execution or true continuation resumption.

### Composition

How async work composes into larger units. What combinators / type constructs exist. Whether composition is at the value level or the procedure level.

### Error handling

How errors propagate, where they're caught, what's typed vs untyped.

### Lifecycle / structure

How long an async operation lives, who owns it, what scope it's tied to.

---

## Taxonomy cells

For each axis the system has a meaningful answer on, the cell as claimed in the table, plus the evidence that supports it. This is what promotes the row from 🟡 to 🟢.

### Where async state lives
**Cell:** _value_
**Evidence:** _quote / citation / code snippet_

### Conflict-handling policy
**Cell:** _value_
**Evidence:** …

### Cancellation discipline
**Cell:** _value_
**Evidence:** …

### Async representation
**Cell:** _value_
**Evidence:** …

### Isolation level
**Cell:** _value or n/a_
**Evidence:** …

### Atomicity granularity
**Cell:** _value_
**Evidence:** …

### Discipline location
**Cell:** _value_
**Evidence:** …

### Reactive integration
**Cell:** _value or n/a_
**Evidence:** …

---

## Scenario mapping

Apply the system to scenarios S1–S8 from [`../../scenarios/concurrent-flows.md`](../../scenarios/concurrent-flows.md). For each, note: does the system solve it, partially, or not at all? How?

| Scenario | Solved? | How |
|---|---|---|
| S1 — Like/unlike race | yes / partial / no | _brief explanation_ |
| S2 — Auto-save vs explicit save | … | … |
| S3 — Multi-step server flow with partial failure | … | … |
| S4 — Concurrent independent flows | … | … |
| S5 — Cross-transaction read | … | … |
| S6 — User-cancellable flow | … | … |
| S7 — Optimistic reconciliation | … | … |
| S8 — Preview / what-if mode | … | … |

Also note which of the policy questions Q1–Q5 the system has explicit answers for, and what those answers are.

---

## What an encoding into JS gains or loses

The central framing. If pulse adopted this model (in whole or in part):

**What we'd gain over pulse's current model:**
- _bullet point_ — _why_

**What we'd lose / sacrifice:**
- _bullet point_ — _why_

**What JS-specific constraints would force compromises:**
- _e.g. "single-shot generators force re-execution semantics; we couldn't do true multi-shot resumption"_

---

## Open questions raised

Threads the dive opened. These get rolled up into the main research's open-questions section.

- _Question 1_
- _Question 2_

---

## Cross-references

- **Other deep-dives this connects to:** _list of paths to related deep-dive docs once they exist_
- **Taxonomy axes this dive informed:** _which columns of the table got sharpened by this work_
- **Scenarios this dive addressed directly:** _which S-numbers got concrete answers_
- **Concept dives this builds on / motivates:** _e.g. for effect-ts: builds on algebraic-effects-theory.md_

---

## Notes / aside

Anything that doesn't fit the structure above but is worth recording. Use sparingly.
