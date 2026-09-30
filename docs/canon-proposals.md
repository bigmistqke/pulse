# Canon proposals

[`CANON.md`](../CANON.md) describes what pulse does now, written backwards from the code, the tests and the design documents. Where a document said nothing, or said something the code does not do, the canon follows the code. This file lists those places, so that a later review can decide whether each behaviour is the one pulse should have. It is deleted once it is empty.

## Stated from the code, with no document behind it

- `axiom-teardown-unwinds`. Closing runs callbacks in reverse order of registration, and one that throws stops nothing else. Both `onSettled` and owner cleanups work this way. No design document states it as a principle.
- `rule-overlapping-writes-resolve-by-commit-order`. ADR 0009 says overlapping speculations resolve last-commit-wins. A new test confirms it: the action that commits last decides the value, whatever order the writes happened in. Whether commit order is the right tie-breaker, rather than write order or an error, is a question for the review.
- `rule-the-handle-reports-its-newest-attempt` sits under `axiom-a-speculation-commits-or-is-discarded-whole`. That `retry()` opens a fresh speculation follows from the axiom. That the handle reports only the newest attempt, and that a superseded attempt changes nothing, is the code's choice rather than something the axiom forces.

## Where the code contradicts a document

- `rule-an-effect-created-in-an-action-misses-what-the-action-wrote`. ADR 0010 says effects are forbidden inside a speculation, and `docs/pulse/CONTEXT.md` says `effect(...)` throws when an ancestor scope is speculative. Neither is true. Creating an effect inside an action does not throw. The effect's first run reads the action's writes, and it then stops following a source the action wrote, until it re-runs for another reason. This looks unintended. The canon records it as it is, with three tests that pin it, so that a fix shows up as a change to the canon.
- ADR 0009 describes an opt-in `onConflict: 'reject'` for an action whose premise went stale. It is not implemented, so the canon says nothing about it.

## Tests left for a later area

Untagged for now, because their rules belong to areas the canon does not cover yet.

- `test/async-action.test.ts`: the five tests on which error boundary a failed action registers with. They belong with error boundaries.
- `test/optimistic.test.ts`: the six tests on reading through an optimistic node (`use`, `isPending`, `error`, the construction-time fallback, a background refresh of the wrapped node), and on a live prediction masking pending and failed state. They belong with reads and loading.
