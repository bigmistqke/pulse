import { For, signal, type Accessor } from 'pulse'

export type EventKind = 'action' | 'request' | 'resolve'

export interface LogEvent {
  seq: number
  t: number
  kind: EventKind
  label: string
  generation: string
}

export interface EventLog {
  events: Accessor<LogEvent[]>
  emit: (kind: EventKind, label: string, generation?: string) => void
  reset: () => void
}

export function createEventLog(): EventLog {
  const [events, setEvents] = signal<LogEvent[]>([])
  let seq = 0
  let start = performance.now()
  return {
    events,
    emit(kind, label, generation = '') {
      const t = Math.round(performance.now() - start)
      setEvents((prev) => [...prev, { seq: seq++, t, kind, label, generation }])
    },
    reset() {
      seq = 0
      start = performance.now()
      setEvents([])
    },
  }
}

export function EventTimeline(props: { log: EventLog }) {
  return (
    <ol class="timeline" attr:data-testid="timeline">
      <For each={() => props.log.events()}>
        {(e) => (
          <li class={`evt evt-${e.kind}`} attr:data-generation={e.generation}>
            <span class="evt-t">{`${e.t}ms`}</span>
            <span class="evt-kind">{e.kind}</span>
            <span class="evt-label">{e.label}</span>
          </li>
        )}
      </For>
    </ol>
  )
}
