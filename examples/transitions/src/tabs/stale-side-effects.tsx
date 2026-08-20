import { computed, Loading, onCleanup, signal, use } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function StaleSideEffects() {
  const log = createEventLog()
  const knob = latencyKnob('save', 600)
  const [version, setVersion] = signal(0)
  const [sideEffectsRan, setSideEffectsRan] = signal(0)

  const save = computed<Promise<{ version: number; text: string }>>(() => {
    const v = version()
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    return mockFetch({
      log,
      knob,
      generation: `v${v}`,
      signal: controller.signal,
      produce: () => {
        setSideEffectsRan((n) => n + 1)
        return { version: v, text: `saved #${v}` }
      },
    })
  })

  function doSave() {
    setVersion((v) => {
      const next = v + 1
      log.emit('action', `save → v${next}`, `v${next}`)
      return next
    })
  }

  const scenario = (
    <div class="scenario">
      <button attr:data-testid="save" on:click={doSave}>save</button>
      <Loading initial={<div class="payload">no save yet</div>}>
        <div class="payload" attr:data-testid="committed" attr:data-gen="current">
          {use(save).text}
        </div>
      </Loading>
      <div class="counter">
        side effects executed: <span attr:data-testid="side-effect-count">{sideEffectsRan()}</span>
      </div>
    </div>
  )

  return (
    <TabFrame
      title="E1 · Stale side effects"
      quality="When a computed run is superseded, its in-flight work should be cancellable — onCleanup should fire on re-run so a wired AbortController can abort it."
      actual="Oracle: counts whether a superseded save's side effect still runs. Passes only if pulse fires onCleanup when a computed re-runs."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
