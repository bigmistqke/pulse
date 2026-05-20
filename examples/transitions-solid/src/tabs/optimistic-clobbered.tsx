import { createMemo, createSignal, For } from 'solid-js'
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
  const [committed, setCommitted] = createSignal<Comment[]>(SERVER_LIST.map((c) => ({ ...c })))
  const [overlay, setOverlay] = createSignal<Comment[]>([])
  let tempSeq = 0

  const comments = createMemo(() => {
    const base = committed()
    const ov = overlay()
    if (ov.length === 0) return base
    const overlayIds = new Set(ov.map((x) => x.id))
    return [...base.filter((x) => !overlayIds.has(x.id)), ...ov]
  })

  async function addComment() {
    const tempId = `temp-${tempSeq++}`
    const text = `optimistic comment ${tempId}`
    log.emit('action', `add (optimistic) ${tempId}`, 'stale')
    setOverlay((c) => [...c, { id: tempId, text, optimistic: true }])
    const saved = await mockFetch({
      log, knob: addKnob, generation: 'stale',
      produce: (): Comment => ({ id: `srv-${tempId}`, text, optimistic: false }),
    })
    setCommitted((c) => [...c, saved])
    setOverlay((c) => c.filter((x) => x.id !== tempId))
  }

  async function refresh() {
    log.emit('action', 'refresh', 'current')
    const list = await mockFetch({
      log, knob: refreshKnob, generation: 'current',
      produce: (): Comment[] => SERVER_LIST.map((c) => ({ ...c })),
    })
    setCommitted(list)
  }

  const scenario = (
    <div class="scenario">
      <div class="btn-row">
        <button data-testid="add" onClick={addComment}>add comment</button>
        <button data-testid="refresh" onClick={refresh}>refresh</button>
      </div>
      <ul class="list-card" data-testid="comments">
        <For each={comments()}>
          {(c) => {
            const item = c()
            return (
              <li data-gen={item.optimistic ? 'stale' : 'current'} data-comment-id={item.id}>
                {item.text}
              </li>
            )
          }}
        </For>
      </ul>
    </div>
  )

  return (
    <TabFrame
      title="E3 · Optimistic value clobbered by refetch"
      quality="An optimistic write must survive a refetch of the underlying data — the refetch sets committed truth; the optimistic entry stays on top until its own request settles."
      actual="Solid 2.x: creating an explicit overlay signal that's merged with committed state preserves the optimistic entry across a refetch."
      scenario={scenario}
      controls={<LatencyControls knobs={[addKnob, refreshKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
