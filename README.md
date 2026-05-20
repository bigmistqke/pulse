# pulse

A small fine-grained reactive UI framework, built on the
[`r3`](https://github.com/bigmistqke/r3) reactive core. Pulse is a **research
vehicle** exploring an alternative to Solid 2.x's
async direction — the same no-VDOM, compile-to-DOM foundation, with different
choices about how async data, suspension, and atomic commit interact.

The central bet: **async coordination should be explicit and local**. You opt a
read into suspension and transition coordination with `use(...)` at the call
site; `<Loading>` is the atomic-commit boundary; pending state is exposed as
plain reactive accessors (`isPending`, `promiseOf`). No hidden async coloring.

> **Status:** the v1 core has shipped — signals, multi-stage and generator
> computeds, stale-while-revalidate, the DOM layer, error boundaries, the
> `<Loading>` atomic-commit boundary, and staged effects. It is young and not
> published to npm. See [Status & maturity](#status--maturity).

## Contents

- [Why pulse](#why-pulse)
- [Setup](#setup)
- [Quickstart](#quickstart)
- [Core API](#core-api)
- [Async & Loading](#async--loading)
- [Examples](#examples)
- [Project layout](#project-layout)
- [Status & maturity](#status--maturity)
- [Prior art](#prior-art)

## Why pulse

- **Fine-grained, no VDOM.** JSX compiles to direct DOM operations; reactive
  expressions become per-binding "holes." Components run once.
- **Async is a computation property, not a separate primitive.** A `computed`
  body can be sync, `async`, or a generator — there is no `createResource`.
- **Explicit opt-in for suspension.** `use(x)` is the visible, grep-able marker
  that a read may suspend and participate in transition coordination. Plain
  reads never suspend.
- **`<Loading>` is the atomic-commit boundary.** It gathers per-binding commits
  and flushes them in one pass once nothing inside is pending — that *is* the
  transition mechanism.
- **Pending state is just reactive data.** `isPending(x)()` and
  `promiseOf(x)()` read from an external registry; no branded signals.

For the full design rationale and a point-by-point comparison with Solid 2.x,
see [`docs/solid-2x-comparison.md`](./docs/solid-2x-comparison.md) and
[`CONTEXT.md`](./CONTEXT.md).

## Setup

Pulse is not published to npm yet — clone the repo and install. Its reactive
core, [`r3`](https://github.com/bigmistqke/r3), is pulled automatically as a git
dependency (built on install via a `prepare` script), so no sibling checkout is
needed:

```sh
git clone https://github.com/bigmistqke/pulse
cd pulse
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → dist/
```

Pulse uses the automatic JSX runtime. Point JSX at pulse in `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "pulse"
  }
}
```

…and in your bundler. For Vite:

```ts
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'pulse' },
})
```

The runnable apps under [`examples/`](./examples) carry a complete config
(`tsconfig.json` + `vite.config.ts`) you can copy.

## Quickstart

```tsx
import { signal, render } from 'pulse'

function Counter() {
  const [count, setCount] = signal(0)
  return (
    <button on:click={() => setCount((n) => n + 1)}>
      count: {count}
    </button>
  )
}

render(() => <Counter/>, document.getElementById('app')!)
```

A component runs **once**. Reactivity lives in the holes it returns — `{count}`
is a reactive binding, not a re-render. Pass an accessor (`count`) or a thunk
(`() => count() + 1`) wherever you want a value to stay live.

## Core API

### Signals

```ts
const [count, setCount] = signal(0)
count()                      // read (tracks in reactive contexts)
setCount(5)                  // write
setCount((prev) => prev + 1) // updater form
```

A signal stores exactly what you put in it — Promise values are not
auto-resolved.

### Computeds

A `computed` is a derived signal defined as a **pipeline** of one or more
stages. Each stage receives the previous stage's (unwrapped) value; a stage may
be sync, `async`, or a generator.

```ts
const doubled = computed(() => count() * 2)

// multi-stage: each stage consumes the prior stage's resolved value
const profile = computed(
  () => fetchUser(userId()),
  (res) => res.profile,
)
```

Async stages publish **stale-while-revalidate**: the prior resolved value stays
visible during a refetch.

### Effects

```ts
effect(() => console.log('count is', count()))   // single-arg
effect([() => fetchX(id())], (x) => mount(x))    // staged: pipeline → commit
```

### Control flow

`Show`, `Switch` / `Match`, and `For` are ordinary components.

```tsx
<Show when={() => todos().length > 0} fallback={<p>empty</p>}>
  <ul>…</ul>
</Show>

<For each={visibleTodos}>{(todo) => <li>{todo.text}</li>}</For>

<Switch>
  <Match when={() => remaining() === 0}>all done</Match>
  <Match when={() => remaining() === 1}>1 left</Match>
</Switch>
```

### JSX binding prefixes

| Prefix   | Purpose                       | Example                      |
| -------- | ----------------------------- | ---------------------------- |
| `on:`    | event listener                | `on:click={handler}`         |
| `prop:`  | DOM property                  | `prop:value={text}`          |
| `attr:`  | HTML attribute                | `attr:placeholder="…"`       |
| `class:` | toggle a class reactively     | `class:done={todo.done}`     |
| `style:` | set a style property reactively | `style:color={color}`      |

### Ownership & lifecycle

`createRoot`, `getOwner`, `runWithOwner`, `onCleanup`, and `catchError` manage
the owner tree — lifecycle scopes for effects and computeds; disposal cascades.
`render(component, target)` creates a root and returns a dispose function.

### Scheduler

Writes batch on a microtask by default. `flush()` drains synchronously;
`setScheduler(syncScheduler(flush))` swaps in a synchronous scheduler (used by
tests).

## Async & Loading

`use(x)` is the explicit opt-in. It does two things on every call: marks the
surrounding binding for transition coordination, and throws `NotReadyYet` if
`x` is pending — suspending that binding until the value settles.

`<Loading>` is the boundary that catches those suspensions and commits the
subtree atomically:

```tsx
function Pokemon(props: { name: string }) {
  const pokemon = computed(() => fetchPokemon(props.name))
  return (
    <Loading initial={<div>loading…</div>}>
      {() => (
        <div>
          <h2>{() => use(pokemon).name}</h2>
          <For each={() => use(pokemon).types}>
            {(t) => <span>{t.type.name}</span>}
          </For>
        </div>
      )}
    </Loading>
  )
}
```

- `initial` — shown on first load, when nothing has committed yet.
- `fallback` — shown on subsequent transitions if set; otherwise the prior
  committed tree is held.
- `useLoading()` — a reactive boolean for the nearest boundary's pending state,
  for in-flight cues (`class:loading={useLoading()}`).

Related helpers: `latest(x)` (last resolved value, never throws),
`isPending(x)()`, `promiseOf(x)()`, and `read(x)` for `yield* read(x)` inside
generator stages.

See [`CONTEXT.md`](./CONTEXT.md) for the full language and transition model.

## Examples

Runnable apps in [`examples/`](./examples):

| Example                          | Demonstrates                                                       |
| -------------------------------- | ------------------------------------------------------------------ |
| [`todo`](./examples/todo)        | signals, `Show` / `For` / `Switch`, JSX binding prefixes — no async |
| [`pokemon`](./examples/pokemon)  | async `computed`, `<Loading>` atomic commit, `use()`, transitions  |

```sh
cd examples/pokemon
pnpm dev
```

## Project layout

```
src/         framework source (signal, computed, effect, dom/, async, pending, …)
test/        vitest suites
examples/    runnable Vite apps
docs/
  adr/                    architecture decision records
  solid-2x-comparison.md  full Pulse vs Solid 2.x analysis
  follow-ups.md           known issues & follow-up work
  research/               async-design research log
CONTEXT.md   project language, conventions, conceptual model
```

## Status & maturity

Pulse is a young research framework. The v1 core has shipped, but several
genuine bugs surfaced during development — owner ambient-context losses, dep
tracking through suspension, ordering races — addressed, but indicative that
the per-binding model has sharp edges. Known issues and workarounds are tracked
in [`docs/follow-ups.md`](./docs/follow-ups.md).

It is not published to npm and offers no stability guarantees. Use it to study
the design, not in production.

## Prior art

Pulse stands on the shoulders of the fine-grained reactive community. It is a
study, not an invention — the ideas below belong to the projects that proved
them.

- **[SolidJS](https://github.com/solidjs/solid)** — pulse's direct lineage. The
  no-VDOM, compile-to-DOM model, components-run-once, and the "async is a
  computation property, not a separate primitive" direction all come from
  Solid. Pulse exists specifically to explore an alternative to Solid 2.x's
  async design; the whole framework is framed against it (see
  [`docs/solid-2x-comparison.md`](./docs/solid-2x-comparison.md)).
- **[Voby](https://github.com/vobyjs/voby)** — Fabio Spampinato's
  high-performance observable framework. Pulse follows voby in passing props as
  destructurable plain values (rather than Solid-style prop getters), and
  borrows voby's approach to context providers.
- **[Pota](https://github.com/potahtml/pota)** — Tito Bouzout's small, pluggable
  reactive renderer. Pulse's JSX binding model — explicit namespaced prefixes
  (`on:`, `prop:`, `attr:`, `class:`, `style:`) with no heuristics — is
  pota-style.

The reactive core is [`r3`](https://github.com/bigmistqke/r3) — a fork of
[milomg/r3](https://github.com/milomg/r3) with a few framework-author exports
added — descending from milomg's `reactively` / `r2` research, shared with
Solid's signals lineage.
