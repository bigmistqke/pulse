import { computed, For, Loading, signal, use } from 'pulse'
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

  const [userId, setUserId] = signal<UserId>('alice')

  const profile = computed<Promise<{ user: UserId; name: string }>>(() => {
    const u = userId()
    return mockFetch({ log, knob: profileKnob, generation: u, produce: () => ({ user: u, name: DATA[u].name }) })
  })
  const followers = computed<Promise<{ user: UserId; count: number }>>(() => {
    const u = userId()
    return mockFetch({ log, knob: followersKnob, generation: u, produce: () => ({ user: u, count: DATA[u].count }) })
  })
  const posts = computed<Promise<{ user: UserId; titles: string[] }>>(() => {
    const u = userId()
    return mockFetch({ log, knob: postsKnob, generation: u, produce: () => ({ user: u, titles: DATA[u].titles }) })
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
      <Loading initial={<div class="profile-card">loading…</div>}>
        {() => (
          <div class="profile-card" attr:data-testid="profile-card">
            <div class="pane pane-header" attr:data-gen={() => use(profile).user}>
              {() => use(profile).name}
            </div>
            <div class="pane pane-followers" attr:data-gen={() => use(followers).user}>
              {() => `${use(followers).count} followers`}
            </div>
            <ul class="pane pane-posts" attr:data-gen={() => use(posts).user}>
              <For each={() => use(posts).titles}>{(title) => <li>{title}</li>}</For>
            </ul>
          </div>
        )}
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="FM1 · Torn state"
      quality="One logical change fans out into several fetches; the page must move from one coherent state to the next, never a frame that mixes them."
      actual="Handled. The <Loading> boundary gathers all three fetches and commits them together — the card never shows mixed-generation panes."
      scenario={scenario}
      controls={<LatencyControls knobs={[profileKnob, followersKnob, postsKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
