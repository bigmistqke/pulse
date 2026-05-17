import {
  computed,
  For,
  isPending,
  Loading,
  read,
  render,
  Show,
  signal,
  use,
} from "pulse";
import { fetchList, fetchPokemon, type PokemonRef } from "./api";
import "./style.css";

const [page, setPage] = signal(0);
const [expanded, setExpanded] = signal<string | null>(null);

const list = computed(
  () => fetchList(page()),
  (r) => r.results,
);

// Coherent display snapshot: page label and items commit atomically when the
// new page settles. yield* read(list) is brand-aware — suspends the generator
// while list is mid-refetch, resumes with the new items. SWR keeps the prior
// snapshot visible to consumers throughout.
const view = computed(function* () {
  return {
    page: yield* read(page),
    items: yield* read(list),
  };
});

function TopBar() {
  const refreshing = () => isPending(view)();
  return (
    <header class="top-bar">
      <h1>pokédex</h1>
      <Show when={refreshing}>
        {() => <span class="indicator">refreshing…</span>}
      </Show>
    </header>
  );
}

function PokemonDetails(props: { name: string }) {
  const pokemon = fetchPokemon(props.name);
  return (
    <Loading initial={<div class="detail-spinner">loading details…</div>}>
      {() => (
        <div class="details">
          {/* sprite: hidden until p resolves; each prop binding is reactive */}
          {() =>
            use(pokemon).sprites.front_default && (
              <img
                attr:src={() => use(pokemon).sprites.front_default!}
                attr:alt={() => use(pokemon).name}
              />
            )
          }
          <div class="meta">
            <div class="types">
              <For each={() => use(pokemon).types}>
                {(t) => <span class="type">{t.type.name}</span>}
              </For>
            </div>
            <table class="stats">
              <For each={() => use(pokemon).stats}>
                {(s) => (
                  <tr>
                    <td>{s.stat.name}</td>
                    <td>{s.base_stat}</td>
                  </tr>
                )}
              </For>
            </table>
          </div>
        </div>
      )}
    </Loading>
  );
}

function PokemonRow(props: { ref: PokemonRef }) {
  const isExpanded = () => expanded() === props.ref.name;
  return (
    <li class:expanded={isExpanded}>
      <button
        class="name"
        on:click={() =>
          setExpanded((c) => (c === props.ref.name ? null : props.ref.name))
        }
      >
        {props.ref.name}
      </button>
      <Show when={isExpanded}>
        {() => <PokemonDetails name={props.ref.name} />}
      </Show>
    </li>
  );
}

function App() {
  return (
    <Loading initial={<div class="spinner">loading…</div>}>
      {() => (
        <div class="app">
          <TopBar />
          <ul class="list" class:loading={() => isPending(view)()}>
            <For each={() => use(view).items}>
              {(ref) => <PokemonRow ref={ref} />}
            </For>
          </ul>
          <nav class="paging">
            <button
              on:click={() => setPage((p) => Math.max(0, p - 1))}
              prop:disabled={() => page() === 0}
            >
              ← prev
            </button>
            <span class:loading={() => isPending(view)()}>
              page {() => use(view).page + 1}
            </span>
            <button on:click={() => setPage((p) => p + 1)}>next →</button>
          </nav>
        </div>
      )}
    </Loading>
  );
}

render(() => <App />, document.getElementById("app")!);
