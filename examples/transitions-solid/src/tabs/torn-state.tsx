import { createMemo, createSignal, For, Loading } from 'solid-js'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

type UserId = 'alice' | 'bob'

const DATA: Record<UserId, { name: string; count: number; titles: string[] }> = {
  alice: { name: 'Alice Alpha', count: 128, titles: ['alice: hello world', 'alice: on signals'] },
  bob: { name: 'Bob Beta', count: 57, titles: ['bob: first post', 'bob: async woes', 'bob: redux rant'] },
}

export function TornState() {
  const log = createEventLog()
  const profileKnob = latencyKnob('profile', 200)
  const followersKnob = latencyKnob('followers', 600)
  const postsKnob = latencyKnob('posts', 1200)

  const [userId, setUserId] = createSignal<UserId>('alice')

  const profile = createMemo(async () => {
    const u = userId()
    return mockFetch({ log, knob: profileKnob, generation: u, produce: () => ({ user: u, name: DATA[u].name }) })
  })
  const followers = createMemo(async () => {
    const u = userId()
    return mockFetch({ log, knob: followersKnob, generation: u, produce: () => ({ user: u, count: DATA[u].count }) })
  })
  const posts = createMemo(async () => {
    const u = userId()
    return mockFetch({ log, knob: postsKnob, generation: u, produce: () => ({ user: u, titles: DATA[u].titles }) })
  })

  function navigate() {
    const next: UserId = userId() === 'alice' ? 'bob' : 'alice'
    log.emit('action', `navigate → ${next}`, next)
    setUserId(next)
  }

  const scenario = (
    <div class="scenario">
      <button data-testid="navigate" onClick={navigate}>navigate alice ⇄ bob</button>
      <Loading fallback={<div class="profile-card">loading…</div>}>
        <div class="profile-card" data-testid="profile-card">
          <div class="pane pane-header" data-gen={profile().user}>
            {profile().name}
          </div>
          <div class="pane pane-followers" data-gen={followers().user}>
            {`${followers().count} followers`}
          </div>
          <ul class="pane pane-posts" data-gen={posts().user}>
            <For each={posts().titles}>{(title) => <li>{title()}</li>}</For>
          </ul>
        </div>
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="FM1 · Torn state"
      quality="One logical change fans out into several fetches; the page must move from one coherent state to the next, never a frame that mixes them."
      actual="Solid 2.x <Loading> boundary catches NotReadyError from any child and shows fallback until all settle — atomic within one boundary."
      scenario={scenario}
      controls={<LatencyControls knobs={[profileKnob, followersKnob, postsKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
