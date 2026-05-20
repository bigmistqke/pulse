import { computed, Loading, Show, signal, use } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function SpinnerFlash() {
  const log = createEventLog()
  const knob = latencyKnob('data', 400)
  const [version, setVersion] = signal(0)
  const [mounted, setMounted] = signal(true)

  const data = computed<Promise<{ version: number; text: string }>>(() => {
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
    setMounted(true)
  }

  const boundary = () => (
    <Loading initial={<div class="payload is-fallback" attr:data-testid="fallback">loading…</div>}>
      {() => (
        <div class="payload" attr:data-testid="payload" attr:data-gen="current">
          {() => use(data).text}
        </div>
      )}
    </Loading>
  )

  const scenario = (
    <div class="scenario">
      <div class="btn-row">
        <button attr:data-testid="refetch" on:click={refetch}>refetch</button>
        <button attr:data-testid="remount" on:click={remount}>remount boundary</button>
      </div>
      <Show when={mounted}>{boundary}</Show>
    </div>
  )

  return (
    <TabFrame
      title="FM2 · Spinner flash"
      quality="A boundary should hold prior content across a refetch — no fallback flash for content already shown — regardless of when the boundary was mounted."
      actual="Fails on remount. <Loading> tracks 'has ever loaded' per-boundary, so a boundary mounted after its data resolved treats the next refetch as a first load and flashes the fallback."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
