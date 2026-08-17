# todo, against a slow and unreliable server

The sibling `todo` example is synchronous: it demonstrates `signal`, `For`, `Show` and `Switch` on local state, and nothing ever has to wait. This one keeps the same familiar shell and puts a fake server behind it, because the coordination pulse does is invisible against a backend that answers instantly and never refuses.

```
pnpm dev      # http://localhost:5181
pnpm test     # the Playwright suite
```

Latency and failure rate are adjustable in the page, and can be seeded from the query string so a test can pin them: `?latency=80&fail=0`. `fail` is a rate between 0 and 1.

## What each part demonstrates

**The load is a generator stage.** `computed(function* () { version(); return yield* read(api.list()) })`. `read` resolves the promise and the stage suspends until it settles. `version` is read before the pause, so it is a dependency — the Refetch button bumps it, which discards any in-flight generator and starts over.

**`use` is the opt-in, per binding.** Both the list and the remaining count call `use(loaded)`. That is what enrols them in the surrounding `<Loading>`, and it is why they commit together rather than the count updating a frame ahead of the rows. Forgetting the call silently opts a binding out, which is the trade pulse makes for having every coordination choice visible at the call site.

**`<Loading>` shows `initial` on a first load and holds the prior list on a refetch.** Click Refetch with the latency turned up: the list stays on screen and a cue appears, rather than the whole thing being replaced by the skeleton. That is stale-while-revalidate — the prior resolved value stays visible, and downstream is only invalidated if the new value differs.

**`optimistic` shows a write before the server has agreed to it.** Every mutation runs inside `action`, writes a speculative list, then waits. The overlay is keyed to that action and dropped when it closes on either face, so a refused write rolls back with no explicit undo — the row simply disappears again. Turn the failure rate up to 1 and add a todo to watch it.

**The server panel is the point of the layout.** It reads canonical truth while the left-hand list reads the overlay, so the two visibly disagree while a write is in flight. Optimistic UI is otherwise hard to see working.

**`committed` builds the overlay from server truth**, not from another in-flight action's guess, which is what keeps two overlapping writes from compounding each other's speculation.

**`onSettle` reports the discard.** It fires once when the action closes, with which face closed it, and the demo uses the discarded case to explain what happened rather than leaving the row's disappearance unexplained.

**`<Failed>` is a selection, not a latch.** Set the failure rate to 1 and reload: the load fails and the boundary renders in place of the subtree. Set it back to 0 and press Try again. The boundary shows its fallback exactly while something beneath it is currently failed, so it also clears on its own when an upstream change makes the stage succeed.

**`latest` is the tolerant read.** The effect that mirrors the server's answer into local state uses `latest`, which returns the last resolved value and never throws — so it neither suspends nor swallows a load failure. The failure is the bindings' business, and they route it to `<Failed>`.

**`isPending`** drives the loading cue, and the third value `optimistic` returns drives the saving cue.

## Two things the code works around deliberately

Both are recorded in `docs/follow-ups.md`, and the demo does what those entries recommend rather than hiding the seam.

A component sitting directly inside the function child of `<Loading>` or `<Failed>` is wrapped under the *outer* hole's owner and never finds the boundary's scope, so there is a static `<div>` between the boundary and its children.

The fake server reads its latency and failure rate from plain module variables rather than signals. They are read inside the request helper, which runs while a reactive computation is on the stack, and reading a signal there would make every request a dependency of the stage that issued it — so moving the latency slider would trigger a refetch.
