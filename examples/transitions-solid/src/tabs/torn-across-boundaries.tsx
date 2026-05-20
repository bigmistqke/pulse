import { createMemo, createSignal, For, Loading } from 'solid-js'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

type UserId = 'alice' | 'bob'

const DATA: Record<UserId, { name: string; count: number; posts: string[] }> = {
  alice: { name: 'Alice Alpha', count: 128, posts: ['alice one', 'alice two'] },
  bob: { name: 'Bob Beta', count: 57, posts: ['bob one', 'bob two', 'bob three'] },
}

export function TornAcrossBoundaries() {
  const log = createEventLog()
  const headerKnob = latencyKnob('header', 200)
  const bodyKnob = latencyKnob('body', 1000)
  const [userId, setUserId] = createSignal<UserId>('alice')

  const headerData = createMemo(async () => {
    const u = userId()
    return mockFetch({ log, knob: headerKnob, generation: u, produce: () => ({ user: u, name: DATA[u].name }) })
  })
  const countData = createMemo(async () => {
    const u = userId()
    return mockFetch({ log, knob: bodyKnob, generation: u, produce: () => ({ user: u, count: DATA[u].count }) })
  })
  const postsData = createMemo(async () => {
    const u = userId()
    return mockFetch({ log, knob: bodyKnob, generation: u, produce: () => ({ user: u, posts: DATA[u].posts }) })
  })

  function navigate() {
    const next: UserId = userId() === 'alice' ? 'bob' : 'alice'
    log.emit('action', `navigate → ${next}`, next)
    setUserId(next)
  }

  const scenario = (
    <div class="scenario">
      <button data-testid="navigate" onClick={navigate}>navigate alice ⇄ bob</button>
      <Loading fallback={<div class="pane">loading header…</div>}>
        <div class="pane pane-header" data-testid="header" data-gen={headerData().user}>
          {headerData().name}
        </div>
      </Loading>
      <Loading fallback={<div class="pane">loading body…</div>}>
        <div class="pane pane-body" data-testid="body" data-gen={countData().user}>
          <div>{`${countData().count} followers`}</div>
          <ul>
            <For each={postsData().posts}>{(p) => <li>{p()}</li>}</For>
          </ul>
        </div>
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="E2 · Torn across boundaries"
      quality="One logical change spanning multiple <Loading> boundaries should commit as a whole — header and body must never show different generations at once."
      actual="Solid 2.x each <Loading> boundary commits independently; header and body can show different generations."
      scenario={scenario}
      controls={<LatencyControls knobs={[headerKnob, bodyKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
