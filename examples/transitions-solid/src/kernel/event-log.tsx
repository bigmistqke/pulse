import { createSignal, For, type Accessor } from 'solid-js'

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
  const [events, setEvents] = createSignal<LogEvent[]>([], { ownedWrite: true })
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
    <ol class="timeline" data-testid="timeline">
      <For each={props.log.events()}>
        {(e) => {
          const ev = e()
          return (
            <li class={`evt evt-${ev.kind}`} data-generation={ev.generation}>
              <span class="evt-t">{`${ev.t}ms`}</span>
              <span class="evt-kind">{ev.kind}</span>
              <span class="evt-label">{ev.label}</span>
            </li>
          )
        }}
      </For>
    </ol>
  )
}
