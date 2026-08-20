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
 * Branch caching by Match-object identity: same winner across re-runs
 * preserves the rendered subtree (children function not re-called).
 * Winner change disposes the old branch's sub-owner and mounts the new
 * under a fresh one.
 *
 * Non-Match children are silently ignored (e.g. stray whitespace text).
 *
 * Note: branch caching uses Match-object identity. Place `<Match>` children
 * INLINE in the Switch's JSX, not constructed per-render (e.g. don't wrap in
 * a function that rebuilds the Match list each call). Fresh Match objects
 * each render look like winner changes and cause unnecessary remounts.
 */
export function Switch(props: SwitchProps): () => unknown {
  const parentOwner = getOwner()
  let lastKey: MatchData<unknown> | 'fallback' | null = null
  let cachedNode: unknown
  let branchOwner: Owner | null = null

  return () => {
    const raw = props.children
    const items = Array.isArray(raw) ? raw : [raw]
    let winner: MatchData<unknown> | null = null
    let winnerValue: unknown = undefined
    for (const item of items) {
      if (item === null || item === undefined) continue
      if (typeof item !== 'object') continue
      if ((item as MatchData<unknown>)[MATCH] !== true) continue
      const m = item as MatchData<unknown>
      const r = readDynamic(m, 'when')
      if (r && !isPromise(r)) {
        winner = m
        winnerValue = r
        break
      }
    }

    const key: MatchData<unknown> | 'fallback' = winner ?? 'fallback'
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
