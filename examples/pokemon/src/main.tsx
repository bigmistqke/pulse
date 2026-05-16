import { computed, For, Loading, render, Show, signal, use, useLoading } from 'pulse'
import { fetchList, fetchPokemon, type Pokemon, type PokemonRef } from './api'
import './style.css'

const [page, setPage] = signal(0)
const [expanded, setExpanded] = signal<string | null>(null)

// `list` is a computed whose value transitions Promise → array via pulse's
// write-back. Re-runs when `page` changes (kicks off a new fetch); the prior
// result stays visible during reload thanks to per-binding stale-but-stable.
// Reading `use(list)` (widened accessor form) suspends while pending and
// returns the array once settled.
const list = computed(() => fetchList(page()).then((r) => r.results))

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
  // Wrap the fetch in a signal so pulse's write-back flips Promise → Pokemon
  // once settled. Calling use() on a raw Promise would stay suspended forever
  // (the same Promise identity persists; the .then-rerun fires only once).
  const [pokemon] = signal<Pokemon | Promise<Pokemon>>(fetchPokemon(props.name))
  // `p` resolves the signal at the leaf — use's widened-accessor form unwraps
  // the signal call and the Promise transparently.
  const p = (): Pokemon => use(pokemon)
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
            {/* `each` is a function → mapArray re-runs reactively. use(list) (widened
                accessor form) throws NotReadyYet while pending; pulse's signal
                write-back flips list's value Promise → array, ending the suspension. */}
            <For each={() => use(list)}>{(ref) => <PokemonRow ref={ref} />}</For>
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
