import { For, signal } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

interface Comment { id: string; text: string; optimistic: boolean }

const SERVER_LIST: Comment[] = [
  { id: 's1', text: 'first comment', optimistic: false },
  { id: 's2', text: 'second comment', optimistic: false },
]

export function OptimisticClobbered() {
  const log = createEventLog()
  const addKnob = latencyKnob('add', 1200)
  const refreshKnob = latencyKnob('refresh', 300)
  const [comments, setComments] = signal<Comment[]>(SERVER_LIST.map((c) => ({ ...c })))
  let tempSeq = 0

  async function addComment() {
    const tempId = `temp-${tempSeq++}`
    const text = `optimistic comment ${tempId}`
    log.emit('action', `add (optimistic) ${tempId}`, 'stale')
    setComments((c) => [...c, { id: tempId, text, optimistic: true }])
    const saved = await mockFetch({
      log,
      knob: addKnob,
      generation: 'stale',
      produce: (): Comment => ({ id: `srv-${tempId}`, text, optimistic: false }),
    })
    setComments((c) => {
      const had = c.some((x) => x.id === tempId)
      return had ? c.map((x) => (x.id === tempId ? saved : x)) : [...c, saved]
    })
  }

  async function refresh() {
    log.emit('action', 'refresh', 'current')
    const list = await mockFetch({
      log,
      knob: refreshKnob,
      generation: 'current',
      produce: (): Comment[] => SERVER_LIST.map((c) => ({ ...c })),
    })
    setComments(list)
  }

  const scenario = (
    <div class="scenario">
      <div class="btn-row">
        <button attr:data-testid="add" on:click={addComment}>add comment</button>
        <button attr:data-testid="refresh" on:click={refresh}>refresh</button>
      </div>
      <ul class="list-card" attr:data-testid="comments">
        <For each={comments()}>
          {(c) => (
            <li attr:data-gen={c.optimistic ? 'stale' : 'current'} attr:data-comment-id={c.id}>
              {c.text}
            </li>
          )}
        </For>
      </ul>
    </div>
  )

  return (
    <TabFrame
      title="E3 · Optimistic value clobbered by refetch"
      quality="An optimistic write must survive a refetch of the underlying data — the refetch sets committed truth; the optimistic entry stays on top until its own request settles."
      actual="Fails as written — optimistic overlay and committed truth share one signal cell, so a refetch that lands first overwrites the list and the optimistic comment vanishes. Solvable in userland: hold the overlay in its own signal and merge it with committed truth via a computed. The gap is an ergonomic optimistic primitive, not a missing capability."
      scenario={scenario}
      controls={<LatencyControls knobs={[addKnob, refreshKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
