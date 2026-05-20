import { createSignal } from 'solid-js'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function Entanglement() {
  const log = createEventLog()
  const bioKnob = latencyKnob('update-bio', 1000)
  const renameKnob = latencyKnob('rename', 300)
  const [displayName, setDisplayName] = createSignal('alice')
  const [bio, setBio] = createSignal('bio for alice')
  let renameSeq = 0

  async function updateBio() {
    log.emit('action', 'update-bio started', 'user')
    await mockFetch({ log, knob: bioKnob, generation: 'user', produce: () => null })
    const current = displayName()
    setBio(`bio for ${current}`)
    log.emit('action', `update-bio wrote bio for "${current}"`, current)
  }

  async function rename() {
    const next = `user-${++renameSeq}`
    log.emit('action', `rename → "${next}"`, next)
    await mockFetch({ log, knob: renameKnob, generation: next, produce: () => null })
    setDisplayName(next)
    log.emit('action', `rename committed "${next}"`, next)
  }

  const scenario = (
    <div class="scenario">
      <div class="btn-row">
        <button data-testid="update-bio" onClick={updateBio}>update bio</button>
        <button data-testid="rename" onClick={rename}>rename</button>
      </div>
      <div class="pane" data-testid="display-name" data-gen="current">
        name: {displayName()}
      </div>
      <div class="pane" data-testid="bio" data-gen="stale">
        {bio()}
      </div>
    </div>
  )

  return (
    <TabFrame
      title="E4 · Entanglement"
      quality="If an in-flight action read a value another action then changed, the committed result must stay coherent — the reader should re-run, block, or be flagged."
      actual="Solid 2.x: read committed values at write time (not capture at call time) — displayName is re-read after mockFetch resolves, so bio always references the current name."
      scenario={scenario}
      controls={<LatencyControls knobs={[bioKnob, renameKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
