import { untrack } from 'r3'
import { isPromise } from '../is-promise'
import {
  createSubOwner,
  disposeOwner,
  getOwner,
  runWithOwner,
  type Owner,
} from '../owner'
import type { Child } from './h'
import { mergeProps } from './merge-props'
import { readDynamic } from './resolve'
import type { Truthy } from './show'

const MATCH: unique symbol = Symbol('Match')

export interface MatchProps<T> {
  when: T | (() => T)
  children: Child | ((value: Truthy<T>) => Child)
}

export interface MatchData<T> extends MatchProps<T> {
  readonly [MATCH]: true
}

/**
 * Tagged data marker consumed by `Switch`. Not a renderer — `Match` does
 * not return a DOM node; its return value is detected by `Switch` via the
 * `MATCH` symbol.
 *
 * The return type is declared as `Node` so TypeScript accepts `<Match>`
 * as a valid JSX element (JSX.Element = Node | Node[] | (() => unknown)).
 * The actual runtime value is a `MatchData<T>` object; `Switch` detects
 * it via the `MATCH` symbol brand.
 */
export function Match<T>(props: MatchProps<T>): Node {
  // Not native spread: {...props} reads every property through its getter
  // once and copies the resulting VALUE as a plain property, permanently
  // flattening a dynamic `when`/`children` (see merge-props.ts). mergeProps
  // copies descriptors instead, so Switch reading `m.when` later still
  // triggers the original live getter.
  return mergeProps(props, { [MATCH]: true }) as unknown as Node
}

export interface SwitchProps {
  fallback?: Child
  children: unknown
}

/**
 * Multi-branch conditional. Evaluates each `Match` child's `when` in
 * document order; the first truthy (non-pending) match wins and its
 * children render. If no Match wins, `fallback` renders.
 *
 * Branch caching by the winner's position among the children: the same
 * position winning across re-runs preserves the rendered subtree (children
 * function not re-called). A different winner disposes the old branch's
 * sub-owner and mounts the new one under a fresh one.
 *
 * Position, not Match-object identity: the compiler turns component children
 * into a getter, so every read of `props.children` builds fresh Match
 * objects, while their positions stay put.
 *
 * Non-Match children are silently ignored (e.g. stray whitespace text).
 */
export function Switch(props: SwitchProps): () => unknown {
  const parentOwner = getOwner()
  let lastKey: number | 'fallback' | null = null
  let cachedNode: unknown
  let branchOwner: Owner | null = null

  return () => {
    const raw = props.children
    const items = Array.isArray(raw) ? raw : [raw]
    let winner: MatchData<unknown> | null = null
    let winnerIndex = -1
    let winnerValue: unknown = undefined
    for (const [index, item] of items.entries()) {
      if (item === null || item === undefined) continue
      if (typeof item !== 'object') continue
      if ((item as MatchData<unknown>)[MATCH] !== true) continue
      const m = item as MatchData<unknown>
      const r = readDynamic(m, 'when')
      if (r && !isPromise(r)) {
        winner = m
        winnerIndex = index
        winnerValue = r
        break
      }
    }

    const key: number | 'fallback' = winner === null ? 'fallback' : winnerIndex
    if (key === lastKey) return cachedNode

    if (branchOwner !== null) disposeOwner(branchOwner)
    branchOwner = createSubOwner(parentOwner)
    cachedNode = untrack(() => runWithOwner(branchOwner!, () => {
      if (winner === null) return props.fallback
      return readDynamic(winner, 'children', winnerValue as Truthy<unknown>)
    }))
    lastKey = key
    return cachedNode
  }
}
