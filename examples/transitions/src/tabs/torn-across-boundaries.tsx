import { computed, For, Loading, signal, use } from 'pulse'
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
  const [userId, setUserId] = signal<UserId>('alice')

  const headerData = computed<Promise<{ user: UserId; name: string }>>(() => {
    const u = userId()
    return mockFetch({ log, knob: headerKnob, generation: u, produce: () => ({ user: u, name: DATA[u].name }) })
  })
  const countData = computed<Promise<{ user: UserId; count: number }>>(() => {
    const u = userId()
    return mockFetch({ log, knob: bodyKnob, generation: u, produce: () => ({ user: u, count: DATA[u].count }) })
  })
  const postsData = computed<Promise<{ user: UserId; posts: string[] }>>(() => {
    const u = userId()
    return mockFetch({ log, knob: bodyKnob, generation: u, produce: () => ({ user: u, posts: DATA[u].posts }) })
  })

  function navigate() {
    setUserId((u) => {
      const next: UserId = u === 'alice' ? 'bob' : 'alice'
      log.emit('action', `navigate → ${next}`, next)
      return next
    })
  }

  const scenario = (
    <div class="scenario">
      <button attr:data-testid="navigate" on:click={navigate}>navigate alice ⇄ bob</button>
      <Loading initial={<div class="pane">loading header…</div>}>
        {() => (
          <div class="pane pane-header" attr:data-testid="header" attr:data-gen={() => use(headerData).user}>
            {() => use(headerData).name}
          </div>
        )}
      </Loading>
      <Loading initial={<div class="pane">loading body…</div>}>
        {() => (
          <div class="pane pane-body" attr:data-testid="body" attr:data-gen={() => use(countData).user}>
            <div>{() => `${use(countData).count} followers`}</div>
            <ul>
              <For each={() => use(postsData).posts}>{(p) => <li>{p}</li>}</For>
            </ul>
          </div>
        )}
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="E2 · Torn across boundaries"
      quality="One logical change spanning multiple <Loading> boundaries should commit as a whole — header and body must never show different generations at once."
      actual="Fails. Each boundary gathers correctly on its own, but the two commit independently — the header flips to the new user while the body still holds the old."
      scenario={scenario}
      controls={<LatencyControls knobs={[headerKnob, bodyKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
