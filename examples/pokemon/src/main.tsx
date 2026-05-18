import {
  computed,
  For,
  Loading,
  render,
  Show,
  signal,
  use,
  useLoading,
} from "pulse";
import { fetchList, fetchPokemon, type PokemonRef } from "./api";
import "./style.css";

const [page, setPage] = signal(0);
const [expanded, setExpanded] = signal<string | null>(null);

const list = computed(
  () => fetchList(page()),
  (r) => r.results,
);

function TopBar() {
  return (
    <header class="top-bar">
      <h1>pokédex</h1>
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
    <div class="app">
      <TopBar />
      {/* One Loading boundary covers page label + list. Initial first load
          shows the spinner via `initial`. Subsequent transitions hold the
          prior committed tree (no fallback set), with a small `.indicator`
          chip surfacing via useLoading() for the in-flight cue. */}
      <Loading initial={<div class="spinner">loading…</div>}>
        {() => (
          <div class="loaded">
            {/* Wrapped in a static <div> on purpose: top-level component
                children in the Fragment lose their useLoading() scope (see
                docs/follow-ups.md — KNOWN BUG). Nesting in a static element
                works because h() wraps the function child under the right
                ambient owner. */}
            <Show when={() => useLoading()()}>
              {() => <span class="indicator">refreshing…</span>}
            </Show>
            <ul class="list">
              <For each={() => use(list)}>
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
              <span>page {() => use(page) + 1}</span>
              <button on:click={() => setPage((p) => p + 1)}>next →</button>
            </nav>
          </div>
        )}
      </Loading>
    </div>
  );
}

render(() => <App />, document.getElementById("app")!);
