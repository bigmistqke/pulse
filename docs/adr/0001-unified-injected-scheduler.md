# Unified injected scheduler; `stabilize()` is internal

r3 is a computation core with no scheduler: `setSignal` only marks the dirty
heap, and `stabilize()` must be called explicitly to drain it. pulse abstracts
this away — `stabilize()` is never user-facing.

pulse uses **one injectable scheduler** that flushes the effect graph and
resumes suspended generator computeds. It is triggered identically by a
synchronous `setSignal` and by an async promise settling — same queue, same
drain, one mental model. The default scheduler batches on a microtask; tests can
inject a synchronous-drain scheduler.

We considered an **async-only** scheduler (sync stays manual `stabilize()`,
scheduler covers only async re-entry). Rejected: it forces every consumer —
including the DOM layer — to hand-roll a re-stabilize loop, so the "manual
purity" is illusory, and it splits scheduling across two mechanisms for no gain.

The objection to unifying — "sync writes would become stale until a tick" — does
not hold, because of a separate invariant: **reads are always synchronously
correct via pull-on-read**. Reading any signal or computed walks it up to date
synchronously, with or without a flush having run. The scheduler only batches
*effects*; it never gates *read correctness*. This invariant is load-bearing for
the unified model and applies to every read, including top-level reads outside
any tracked context.
