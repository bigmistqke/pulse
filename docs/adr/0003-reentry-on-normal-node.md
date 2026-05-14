# Async re-entry: stashed pipeline state on a normal r3 computed node

A pulse `computed` (pipeline) can suspend mid-flight. r3's `recompute` is
synchronous start-to-finish, so something has to carry the suspended state and
get the node re-evaluated when an awaited promise settles.

We chose: **a pulse computed is one ordinary r3 `computed` node.** Its `fn`
wrapper runs the pipeline as far as it can synchronously; on hitting a suspending
stage it returns the in-flight `Promise<T>` as the node's value (so downstream
sees a promise — async color propagates) and stashes the live pipeline state
(current stage, cached segment values, a generation counter) on the node. A
`.then` triggers write-back and asks the scheduler to re-queue the node;
re-evaluation resumes from the stashed state via checkpoint resume.

The alternative was a **distinct node type** for suspendable computeds. Rejected:
it would force r3 (or a fork of it) to know about a second kind of node and a
second scheduling path. Keeping it a normal node means r3 stays entirely
unmodified — async-ness lives wholly inside pulse's `fn` wrapper, and async
re-entry reuses the exact same "scheduler re-queues a dirty node" path as
everything else. The cost is that the wrapper carries real complexity (stash,
resume, stale-run guard); we accept concentrated complexity in one bounded
wrapper over async-awareness spread through the core.
