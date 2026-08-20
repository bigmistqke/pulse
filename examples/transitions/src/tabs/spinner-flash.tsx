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
    setVersion((v) => {
      const next = v + 1
      log.emit('action', `refetch → v${next}`, `v${next}`)
      return next
    })
  }
  function remount() {
    log.emit('action', 'remount boundary')
    setMounted(false)
    setTimeout(() => {
      log.emit('action', 'boundary re-mounted')
      setMounted(true)
    }, 30)
  }

  const panes = () => (
    <div class="pane-row">
      <Loading initial={<div class="pane is-fallback" attr:data-testid="fallback-use">loading…</div>}>
        <div class="pane" attr:data-testid="payload-use">
          <p class="pane-label">use(data)</p>
          {() => use(data).text}
        </div>
      </Loading>
      <Loading initial={<div class="pane is-fallback" attr:data-testid="fallback-use-latest">loading…</div>}>
        <div class="pane" attr:data-testid="payload-use-latest">
          <p class="pane-label">use.latest(data)</p>
          {() => use.latest(data).text}
        </div>
      </Loading>
    </div>
  )

  const scenario = (
    <div class="scenario">
      <div class="btn-row">
        <button attr:data-testid="refetch" on:click={refetch}>refetch</button>
        <button attr:data-testid="remount" on:click={remount}>remount boundary</button>
      </div>
      <Show when={mounted()}>{panes}</Show>
    </div>
  )

  return (
    <TabFrame
      title="FM2 · Spinner flash"
      quality="A boundary should hold prior content across a refetch — no fallback flash for content already shown — regardless of when the boundary was mounted."
      actual="use(data) always throws while data is pending, by design — on a fresh boundary that means a fallback flash, even for a refetch of data shown before the remount. use.latest(data) only throws while latest(data) has genuinely never resolved anything, so it survives the remount and never flashes."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
