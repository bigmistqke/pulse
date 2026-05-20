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
    log.emit('action', 'update-bio started', 'user')
    await mockFetch({ log, knob: bioKnob, generation: 'user', produce: () => null })
    // Read displayName at write time, not capture time — the committed name as
    // it stands now, so a concurrent rename mid-flight is reflected, not lost.
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
        <button attr:data-testid="update-bio" on:click={updateBio}>update bio</button>
        <button attr:data-testid="rename" on:click={rename}>rename</button>
      </div>
      <div class="pane" attr:data-testid="display-name" attr:data-gen="current">
        name: {() => displayName()}
      </div>
      <div class="pane" attr:data-testid="bio" attr:data-gen="current">
        {() => bio()}
      </div>
    </div>
  )

  return (
    <TabFrame
      title="E4 · Entanglement"
      quality="An action that embeds another value into its result must reflect that value as it stands when the write lands — not a snapshot taken before the action's async work began."
      actual="Handled by reading displayName at write time — after the await — instead of capturing it up front. A concurrent rename mid-flight is reflected: the committed bio references the current name. (Capturing before the await would embed the stale name.)"
      scenario={scenario}
      controls={<LatencyControls knobs={[bioKnob, renameKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
