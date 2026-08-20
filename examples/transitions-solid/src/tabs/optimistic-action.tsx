import { action, createOptimistic, createSignal, For } from 'solid-js'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

interface Comment {
  id: string
  text: string
  pending: boolean
}

const SERVER_LIST: Comment[] = [
  { id: 's1', text: 'first comment', pending: false },
  { id: 's2', text: 'second comment', pending: false },
]

export function OptimisticAction() {
  const log = createEventLog()
  const knob = latencyKnob('save', 900)
  let tempSeq = 0

  const [serverComments, setServerComments] = createSignal<Comment[]>(
    SERVER_LIST.map((c) => ({ ...c })),
  )
  const [comments, setComments] = createOptimistic(() => serverComments())

  const addComment = action(function* (fail: boolean) {
    const tempId = `temp-${tempSeq++}`
    const text = `${fail ? 'doomed' : 'optimistic'} comment ${tempId}`
    log.emit('action', `add (optimistic) ${tempId}`, fail ? 'fail' : 'ok')
    setComments((c) => [...c, { id: tempId, text, pending: true }])
    const saved: Comment = yield mockFetch({
      log,
      knob,
      generation: fail ? 'fail' : 'ok',
      fail,
      produce: (): Comment => ({ id: `srv-${tempId}`, text, pending: false }),
    })
    setServerComments((c) => [...c, saved])
    log.emit('action', `add committed ${saved.id}`, 'ok')
    return saved
  })

  function add() {
    addComment(false)
  }
  function addFailing() {
    addComment(true).catch(() => log.emit('action', 'add reverted (failed)', 'fail'))
  }

  const scenario = (
    <div class="scenario">
      <div class="btn-row">
        <button data-testid="add" onClick={add}>
          add comment
        </button>
        <button data-testid="add-failing" onClick={addFailing}>
          add (request fails)
        </button>
      </div>
      <ul class="list-card" data-testid="comments">
        <For each={comments()}>
          {(c) => {
            const item = c()
            return (
              <li
                data-gen={item.pending ? 'stale' : 'current'}
                data-comment-id={item.id}
                data-pending={item.pending ? 'true' : 'false'}
              >
                {item.text}
                {item.pending ? ' — saving…' : ''}
              </li>
            )
          }}
        </For>
      </ul>
    </div>
  )

  return (
    <TabFrame
      title="P1 · Optimistic action"
      quality="An optimistic write shows immediately, commits atomically when the action's request settles, and rolls back on its own if the request fails."
      actual="Solid 2.x: createOptimistic writes inside an action() are a tentative overlay — kept when the action resolves, auto-reverted when it rejects."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
