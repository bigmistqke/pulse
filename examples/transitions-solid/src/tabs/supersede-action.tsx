import { action, createSignal } from 'solid-js'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function SupersedeAction() {
  const log = createEventLog()
  const knob = latencyKnob('save', 600)
  const [committed, setCommitted] = createSignal('nothing saved yet')
  const [sideEffects, setSideEffects] = createSignal(0)
  let gen = 0
  let inflight: AbortController | null = null

  // E1 re-done with action(). action() does NOT auto-supersede concurrent
  // invocations the way an async createMemo discards stale results — each call
  // is its own transition. So cancellation is wired explicitly: a new save
  // aborts the previous one's request. The aborted fetch rejects, the
  // superseded action throws, and its commit + side effect never run.
  const save = action(function* () {
    const myGen = ++gen
    inflight?.abort()
    const ctrl = (inflight = new AbortController())
    log.emit('action', `save → #${myGen}`, `v${myGen}`)
    const result: { text: string } = yield mockFetch({
      log,
      knob,
      generation: `v${myGen}`,
      signal: ctrl.signal,
      produce: () => ({ text: `saved #${myGen}` }),
    })
    // Reached only by the save that was not superseded.
    setCommitted(result.text)
    setSideEffects((n) => n + 1)
    log.emit('action', `committed ${result.text}`, `v${myGen}`)
  })

  function doSave() {
    // A superseded save rejects when its request is aborted — expected.
    save().catch(() => {})
  }

  const scenario = (
    <div class="scenario">
      <button data-testid="save" onClick={doSave}>
        save
      </button>
      <div class="payload" data-testid="committed" data-gen="current">
        {committed()}
      </div>
      <div class="counter">
        side effects executed: <span data-testid="side-effect-count">{sideEffects()}</span>
      </div>
    </div>
  )

  return (
    <TabFrame
      title="P3 · Supersession"
      quality="When saves are fired faster than they settle, only the latest may commit — a superseded save must not commit its result nor run its side effect."
      actual="Solid 2.x: action() has no built-in supersession; an AbortController per call cancels the prior request, so the superseded action throws before it can commit."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
