import {
  computed,
  For,
  isPending,
  Loading,
  render,
  Show,
  signal,
  use,
} from "pulse";
import { fetchList, fetchPokemon, type Pokemon, type PokemonRef } from "./api";
import "./style.css";

const [page, setPage] = signal(0);
const [expanded, setExpanded] = signal<string | null>(null);

// Plan 6 fixed `computed(() => Promise)` to preserve dep tracking and
// stale-while-revalidate cleanly. Reading via `use(list)` (widened accessor
// form) throws NotReadyYet on initial pending, returns the array once settled.
const list = computed(() => fetchList(page()).then((r) => r.results));

function TopBar() {
  // Stale-while-revalidate: list keeps its prior array during refetch, so the
  // Loading boundary doesn't re-trip. isPending(list) is the SWR-aware probe.
  const refreshing = () => isPending(list);
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
  // Wrap the fetch in a signal so pulse's write-back flips Promise → Pokemon
  // once settled. Calling use() on a raw Promise would stay suspended forever
  // (the same Promise identity persists; the .then-rerun fires only once).
  const [pokemon] = signal(fetchPokemon(props.name));
  // `p` resolves the signal at the leaf — use's widened-accessor form unwraps
  // the signal call and the Promise transparently.
  const p = (): Pokemon => use(pokemon);
  return (
    <Loading initial={<div class="detail-spinner">loading details…</div>}>
      {() => (
        <div class="details">
          {/* sprite: hidden until p resolves; each prop binding is reactive */}
          {() =>
            p().sprites.front_default && (
              <img
                attr:src={() => p().sprites.front_default!}
                attr:alt={() => p().name}
              />
            )
          }
          <div class="meta">
            <div class="types">
              <For each={() => p().types}>
                {(t) => <span class="type">{t.type.name}</span>}
              </For>
            </div>
            <table class="stats">
              <For each={() => p().stats}>
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
          <ul class="list">
            {/* `each` is a function → mapArray re-runs reactively. use(list) (widened
                accessor form) throws NotReadyYet while pending; pulse's signal
                write-back flips list's value Promise → array, ending the suspension. */}
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
            <span>page {() => page() + 1}</span>
            <button on:click={() => setPage((p) => p + 1)}>next →</button>
          </nav>
        </div>
      )}
    </Loading>
  );
}

render(() => <App />, document.getElementById("app")!);
