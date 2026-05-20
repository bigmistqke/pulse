import { createEffect, createMemo, createSignal, Loading } from 'solid-js'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function StaleSideEffects() {
  const log = createEventLog()
  const knob = latencyKnob('save', 600)
  const [version, setVersion] = createSignal(0)
  const [sideEffectsRan, setSideEffectsRan] = createSignal(0, { ownedWrite: true })

  const save = createMemo(async () => {
    const v = version()
    return mockFetch({
      log, knob, generation: `v${v}`,
      produce: () => ({ version: v, text: `saved #${v}` }),
    })
  })

  createEffect(
    () => save(),
    () => {
      // Block body: the effect must return void (or a cleanup fn), not the
      // number that setSideEffectsRan would otherwise hand back.
      setSideEffectsRan((n) => n + 1)
    },
  )

  function doSave() {
    // Read-modify-write via the functional updater. Reading `version()` here
    // directly would return the committed value — a write that feeds an async
    // memo is transition-scoped and not committed until the memo settles, so a
    // second rapid click would recompute the same `next`. The updater receives
    // the latest lane-aware value instead.
    setVersion((v) => {
      const next = v + 1
      log.emit('action', `save → v${next}`, `v${next}`)
      return next
    })
  }

  const scenario = (
    <div class="scenario">
      <button data-testid="save" onClick={doSave}>save</button>
      <Loading fallback={<div class="payload">no save yet</div>}>
        <div class="payload" data-testid="committed" data-gen="current">
          {save().text}
        </div>
      </Loading>
      <div class="counter">
        side effects executed: <span data-testid="side-effect-count">{sideEffectsRan()}</span>
      </div>
    </div>
  )

  return (
    <TabFrame
      title="E1 · Stale side effects"
      quality="When a computed run is superseded, its in-flight work should be cancellable — onCleanup should fire on re-run so a wired AbortController can abort it."
      actual="Solid 2.x: identity-based async-write discard rejects superseded memo results; createEffect's apply only fires on committed values."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
