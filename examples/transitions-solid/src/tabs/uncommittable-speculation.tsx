import { createMemo, createSignal, For, latest, Loading } from 'solid-js'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

const ACTIVE = ['active: draft a', 'active: draft b']
const ARCHIVED = ['archived: old one', 'archived: old two', 'archived: old three']

export function UncommittableSpeculation() {
  const log = createEventLog()
  const knob = latencyKnob('list', 800)
  const [archived, setArchived] = createSignal(false)

  const list = createMemo(async () => {
    const a = archived()
    return mockFetch({
      log, knob, generation: a ? 'archived' : 'active',
      produce: () => ({ archived: a, items: a ? ARCHIVED : ACTIVE, generation: a ? 'archived' : 'active' }),
    })
  })

  function toggle() {
    setArchived((a) => {
      const next = !a
      log.emit('action', `toggle → ${next ? 'archived' : 'active'}`, next ? 'archived' : 'active')
      return next
    })
  }

  const scenario = (
    <div class="scenario">
      <button data-testid="toggle" onClick={toggle}>
        {`showing: ${archived() ? 'archived' : 'active'}`}
      </button>
      <Loading fallback={<div class="list-card">loading…</div>}>
        <ul
          class="list-card"
          data-testid="list"
          data-gen={latest(list).generation}
        >
          <For each={latest(list).items}>{(item) => <li>{item()}</li>}</For>
        </ul>
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="FM4 · Uncommittable speculation"
      quality="A superseded in-flight change must be discardable — when the user toggles again before the first fetch lands, the committed list must match the latest toggle, never the abandoned one."
      actual="Solid 2.x: latest() holds the committed generation across re-fetches; identity-based async-write discard never commits the superseded archived result."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
