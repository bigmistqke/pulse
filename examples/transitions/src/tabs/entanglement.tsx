import { signal } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function Entanglement() {
  const log = createEventLog()
  const bioKnob = latencyKnob('update-bio', 1000)
  const renameKnob = latencyKnob('rename', 300)
  const [displayName, setDisplayName] = signal('alice')
  const [bio, setBio] = signal('bio for alice')
  let renameSeq = 0

  async function updateBio() {
    const captured = displayName()
    log.emit('action', `update-bio reads name "${captured}"`, captured)
    await mockFetch({ log, knob: bioKnob, generation: captured, produce: () => null })
    setBio(`bio for ${captured}`)
    log.emit('action', `update-bio wrote bio for "${captured}"`, captured)
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
        <button attr:data-testid="update-bio" on:click={updateBio}>update bio</button>
        <button attr:data-testid="rename" on:click={rename}>rename</button>
      </div>
      <div class="pane" attr:data-testid="display-name" attr:data-gen="current">
        name: {() => displayName()}
      </div>
      <div class="pane" attr:data-testid="bio" attr:data-gen="stale">
        {() => bio()}
      </div>
    </div>
  )

  return (
    <TabFrame
      title="E4 · Entanglement"
      quality="If an in-flight action read a value another action then changed, the committed result must stay coherent — the reader should re-run, block, or be flagged."
      actual="Fails. update-bio captures displayName, awaits, then writes a bio embedding the stale name — a concurrent rename leaves bio referencing the old name."
      scenario={scenario}
      controls={<LatencyControls knobs={[bioKnob, renameKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
