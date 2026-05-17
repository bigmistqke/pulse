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
    <Loading initial={<div class="spinner">loading…</div>}>
      {() => (
        <div class="app">
          <TopBar />
          {/* Inner boundary: page label and list commit atomically.
              While a new page is in-flight, the prior tree stays visible.
              use(list) and use(page) throw NotReadyYet while pending,
              keeping the boundary in collecting state until both settle. */}
          <Loading>
            {() => (
              <>
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
              </>
            )}
          </Loading>
        </div>
      )}
    </Loading>
  );
}

render(() => <App />, document.getElementById("app")!);
