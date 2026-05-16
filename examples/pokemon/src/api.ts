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

function get<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined
  if (p === undefined) {
    p = fetch(url).then((r) => {
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
