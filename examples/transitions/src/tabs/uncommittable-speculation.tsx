import { computed, For, Loading, signal, use } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

const ACTIVE = ['active: draft a', 'active: draft b']
const ARCHIVED = ['archived: old one', 'archived: old two', 'archived: old three']

export function UncommittableSpeculation() {
  const log = createEventLog()
  const knob = latencyKnob('list', 800)
  const [archived, setArchived] = signal(false)

  const list = computed<Promise<{ archived: boolean; items: string[] }>>(() => {
    const a = archived()
    return mockFetch({
      log, knob, generation: a ? 'archived' : 'active',
      produce: () => ({ archived: a, items: a ? ARCHIVED : ACTIVE }),
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
      <button attr:data-testid="toggle" on:click={toggle}>
        {`showing: ${archived() ? 'archived' : 'active'}`}
      </button>
      <Loading initial={<div class="list-card">loading…</div>}>
        <ul
          class="list-card"
          attr:data-testid="list"
          attr:data-gen={use(list).archived ? 'archived' : 'active'}
        >
          <For each={use(list).items}>{(item) => <li>{item}</li>}</For>
        </ul>
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="FM4 · Uncommittable speculation"
      quality="A superseded in-flight change must be discardable — when the user toggles again before the first fetch lands, the committed list must match the latest toggle, never the abandoned one."
      actual="Observe: toggle rapidly and watch whether a superseded fetch commits and briefly contradicts the toggle. The spec is the oracle."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
