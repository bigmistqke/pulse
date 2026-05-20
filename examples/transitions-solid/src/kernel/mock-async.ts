import { createSignal, type Accessor, type Setter } from 'solid-js'
import type { EventLog } from './event-log'

export interface LatencyKnob {
  name: string
  ms: Accessor<number>
  setMs: Setter<number>
}

export function latencyKnob(name: string, initialMs: number): LatencyKnob {
  const [ms, setMs] = createSignal(initialMs)
  return { name, ms, setMs }
}

export interface MockFetchOptions<T> {
  log: EventLog
  knob: LatencyKnob
  generation: string
  produce: () => T
  signal?: AbortSignal
  /** When true the request rejects after its latency instead of resolving. */
  fail?: boolean
}

export function mockFetch<T>(options: MockFetchOptions<T>): Promise<T> {
  const { log, knob, generation, produce, signal, fail } = options
  const ms = knob.ms()
  log.emit('request', `${knob.name} (${ms}ms)`, generation)
  return new Promise<T>((resolve, reject) => {
    // Once the request settles, a later abort is a no-op — matching real
    // AbortController semantics and keeping the timeline free of spurious
    // "cancelled" entries for work that already finished.
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (signal?.aborted) {
        log.emit('resolve', `${knob.name} (cancelled)`, generation)
        reject(new Error(`${knob.name} aborted`))
        return
      }
      if (fail) {
        log.emit('resolve', `${knob.name} (failed)`, generation)
        reject(new Error(`${knob.name} failed`))
        return
      }
      log.emit('resolve', `${knob.name}`, generation)
      resolve(produce())
    }, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          log.emit('resolve', `${knob.name} (cancelled)`, generation)
          reject(new Error(`${knob.name} aborted`))
        },
        { once: true },
      )
    }
  })
}
