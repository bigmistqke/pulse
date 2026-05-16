import { For, Loading, render, Show, signal, use, useLoading } from 'pulse'
import { fetchList, fetchPokemon, type Pokemon, type PokemonRef } from './api'
import './style.css'

const [page, setPage] = signal(0)
const [expanded, setExpanded] = signal<string | null>(null)

// Reactive list: depends on page signal
const list = (): Promise<PokemonRef[]> => fetchList(page()).then((r) => r.results)

function TopBar() {
  const pending = useLoading()
  return (
    <header class="top-bar">
      <h1>pokédex</h1>
      <Show when={pending}>{() => <span class="indicator">refreshing…</span>}</Show>
    </header>
  )
}

function PokemonDetails(props: { name: string }) {
  // Kick off fetch once; the promise is stable.
  const pokemonPromise = fetchPokemon(props.name)
  // `p` is a thunk that calls use() — wrap each access at the leaf to keep
  // bindings fine-grained. Each `() => p()…` is its own binding-effect.
  const p = (): Pokemon => use(pokemonPromise)
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
  )
}

function PokemonRow(props: { ref: PokemonRef }) {
  const isExpanded = () => expanded() === props.ref.name
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
  )
}

function App() {
  return (
    <Loading initial={<div class="spinner">loading…</div>}>
      {() => (
        <div class="app">
          <TopBar />
          <ul class="list">
            {/* `each` is a function → mapArray re-runs reactively when page() changes.
                use() inside re-throws on the new pending promise; mapArray's
                binding-effect catches and registers with Loading's scope. */}
            <For each={() => use(list())}>{(ref) => <PokemonRow ref={ref} />}</For>
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
  )
}

render(() => <App />, document.getElementById('app')!)
