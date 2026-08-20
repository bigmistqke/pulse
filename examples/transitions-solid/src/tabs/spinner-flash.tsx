import { createMemo, createSignal, latest, Loading, Show } from 'solid-js'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function SpinnerFlash() {
  const log = createEventLog()
  const knob = latencyKnob('data', 400)
  const [version, setVersion] = createSignal(0)
  const [mounted, setMounted] = createSignal(true)

  const data = createMemo(async () => {
    const v = version()
    return mockFetch({
      log, knob, generation: `v${v}`,
      produce: () => ({ version: v, text: `payload #${v}` }),
    })
  })

  function refetch() {
    const next = version() + 1
    log.emit('action', `refetch → v${next}`, `v${next}`)
    setVersion(next)
  }
  function remount() {
    log.emit('action', 'remount boundary')
    setMounted(false)
    setTimeout(() => {
      log.emit('action', 'boundary re-mounted')
      setMounted(true)
    }, 30)
  }

  const boundary = () => (
      <Loading fallback={<div class="payload is-fallback" data-testid="fallback">loading…</div>}>
        <div class="payload" data-testid="payload" data-gen="current">
          {latest(data).text}
        </div>
      </Loading>
  )

  const scenario = (
    <div class="scenario">
      <div class="btn-row">
        <button data-testid="refetch" onClick={refetch}>refetch</button>
        <button data-testid="remount" onClick={remount}>remount boundary</button>
      </div>
      <Show when={mounted()}>{(_: any) => boundary()}</Show>
    </div>
  )

  return (
    <TabFrame
      title="FM2 · Spinner flash"
      quality="A boundary should hold prior content across a refetch — no fallback flash for content already shown — regardless of when the boundary was mounted."
      actual="Fails on remount, same as pulse — verified empirically, not assumed. latest() correctly holds the stale value across a plain refetch, but <Loading>'s own fallback-vs-hold-prior state is still scoped to the boundary instance: a genuine unmount+remount re-triggers the fallback even though the data settled before. Not addressed in the 2.0 RFCs or docs."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
