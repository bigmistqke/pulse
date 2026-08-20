import { computed, For, Loading, signal, use } from 'pulse'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

function resultsFor(query: string): string[] {
  if (query === '') return []
  return [1, 2, 3].map((n) => `${query} — result ${n}`)
}

export function LostInteractivity() {
  const log = createEventLog()
  const knob = latencyKnob('search', 500)
  const [query, setQuery] = signal('')

  const results = computed<Promise<{ query: string; items: string[] }>>(() => {
    const q = query()
    return mockFetch({
      log, knob, generation: q || '(empty)',
      produce: () => ({ query: q, items: resultsFor(q) }),
    })
  })

  function onInput(e: Event) {
    const q = (e.currentTarget as HTMLInputElement).value
    log.emit('action', `type → "${q}"`, q || '(empty)')
    setQuery(q)
  }

  const scenario = (
    <div class="scenario">
      <input
        class="search-input"
        attr:data-testid="search"
        attr:placeholder="type a query…"
        on:input={onInput}
      />
      <Loading initial={<div class="list-card">type to search…</div>}>
        <ul
          class="list-card"
          attr:data-testid="results"
          attr:data-result-query={use(results).query}
        >
          <For each={use(results).items}>{(item) => <li>{item}</li>}</For>
        </ul>
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="FM3 · Lost interactivity"
      quality="While async work is in flight the committed UI must stay live — the input stays focused, prior results stay visible, and a stale query's results never replace a newer query's."
      actual="Observe: type quickly and watch whether focus survives, whether results strobe, and whether an earlier query's results ever land after a later one. The spec is the oracle."
      scenario={scenario}
      controls={<LatencyControls knobs={[knob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
