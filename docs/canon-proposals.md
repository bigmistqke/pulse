# Canon proposals

Open items found while writing [`CANON.md`](../CANON.md) backwards from the tests and documents. Each needs a decision before it enters the canon or leaves this list. This file is deleted once it is empty.

## Axioms no document states yet

### Teardown unwinds, and one failure stops no other

Draft statement: *Whatever is registered to run when something closes runs in reverse order of registration, and a callback that throws does not stop the others or the close itself.*

Evidence: `onSettled` callbacks fire last-in-first-out, and a throwing callback leaves the scope committed and its siblings run (`test/scope.test.ts`, the last two `onSettled` tests). The comment on the settle machinery in `src/scope.ts` says it mirrors the cleanup firing in `src/owner.ts`, so owner cleanups likely follow the same axiom.

Current placement: both tests cite `rule-a-speculation-announces-how-it-closed`, which states only that each callback fires once with the outcome. The order and the isolation are asserted by the tests but stated by no unit.

## Parents I chose, to confirm

These rules sit under `axiom-a-speculation-commits-or-is-discarded-whole`, but the derivation is my reading, not something a document states.

- `rule-a-failed-action-is-reported-not-thrown`. Derived from "both outcomes are ordinary": a discard is not an exception, so it does not reach the caller as one.
- `rule-the-handle-reports-its-newest-attempt`. Weaker. That `retry()` opens a fresh speculation follows from the axiom. That the handle reports only the newest attempt, and that a superseded attempt changes nothing, may want an axiom of its own.

## Claims in the documents that nothing backs

- Effects are forbidden inside a speculation. ADR 0010 states it, and `docs/pulse/CONTEXT.md` says `effect(...)` throws when an ancestor scope is speculative. No check in `src/` enforces it, and no test pins it.
- An action can opt into `onConflict: 'reject'`. ADR 0009 describes it. It is not implemented.
- Overlapping speculations resolve last-commit-wins. ADR 0009 states it, and the commit path suggests it holds, but no test pins it.

## Tests whose title claims more than they assert

- `test/async-action.test.ts`, "two concurrent async actions are isolated from each other". It asserts only that both actions commit. Nothing checks that either action cannot see the other's write while both are open.
- `test/signal-speculation.test.ts`, "a public signal write inside an action is isolated from committed state until commit". It never reads committed state while the action is open. It is cited as `rule-a-speculation-reads-its-own-writes`, which is what it does assert.

## Tests left for a later area

Untagged for now, because their rules belong to areas the canon does not cover yet.

- `test/async-action.test.ts`: the five tests on which error boundary a failed action registers with. They belong with error boundaries.
- `test/optimistic.test.ts`: the six tests on reading through an optimistic node (`use`, `isPending`, `error`, the construction-time fallback, a background refresh of the wrapped node), and on a live prediction masking pending and failed state. They belong with reads and loading.
