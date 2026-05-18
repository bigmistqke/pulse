const BASE = 'https://pokeapi.co/api/v2'

export type PokemonRef = { name: string; url: string }
export type PokemonListResponse = { count: number; results: PokemonRef[] }

export type Pokemon = {
  id: number
  name: string
  sprites: { front_default: string | null }
  types: Array<{ type: { name: string } }>
  stats: Array<{ base_stat: number; stat: { name: string } }>
}

const cache = new Map<string, Promise<unknown>>()

// Artificial delay so transitions are observable during manual testing and
// reliably visible in Playwright assertions. Set to 0 in production.
const FETCH_DELAY_MS = 500

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()
}

function get<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined
  if (p === undefined) {
    p = delay(FETCH_DELAY_MS)
      .then(() => fetch(url))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json() as Promise<T>
      })
    cache.set(url, p)
  }
  return p
}

export function fetchList(page: number): Promise<PokemonListResponse> {
  return get<PokemonListResponse>(`${BASE}/pokemon?offset=${page * 20}&limit=20`)
}

export function fetchPokemon(name: string): Promise<Pokemon> {
  return get<Pokemon>(`${BASE}/pokemon/${name}`)
}
