import { signal, type Accessor, type Setter } from 'pulse'
import type { EventLog } from './event-log'

export interface LatencyKnob {
  name: string
  ms: Accessor<number>
  setMs: Setter<number>
}

export function latencyKnob(name: string, initialMs: number): LatencyKnob {
  const [ms, setMs] = signal(initialMs)
  return { name, ms, setMs }
}

export interface MockFetchOptions<T> {
  log: EventLog
  knob: LatencyKnob
  generation: string
  produce: () => T
  /** Optional abort signal. If it aborts before the latency timer fires,
   *  `produce` is skipped and the promise rejects. */
  signal?: AbortSignal
}

/**
 * Emit `request`, wait `knob.ms()` (sampled now), emit `resolve`, return
 * `produce()`. If `signal` aborts first: skip `produce`, emit a `(cancelled)`
 * resolve event, and reject.
 */
export function mockFetch<T>(options: MockFetchOptions<T>): Promise<T> {
  const { log, knob, generation, produce, signal } = options
  const ms = knob.ms()
  log.emit('request', `${knob.name} (${ms}ms)`, generation)
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal?.aborted) {
        log.emit('resolve', `${knob.name} (cancelled)`, generation)
        reject(new Error(`${knob.name} aborted`))
        return
      }
      log.emit('resolve', `${knob.name}`, generation)
      resolve(produce())
    }, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          log.emit('resolve', `${knob.name} (cancelled)`, generation)
          reject(new Error(`${knob.name} aborted`))
        },
        { once: true },
      )
    }
  })
}
