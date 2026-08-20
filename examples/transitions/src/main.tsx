import { render, Show, signal } from 'pulse'
import { LostInteractivity } from './tabs/lost-interactivity'
import { SpinnerFlash } from './tabs/spinner-flash'
import { TornState } from './tabs/torn-state'
import { UncommittableSpeculation } from './tabs/uncommittable-speculation'
import { StaleSideEffects } from './tabs/stale-side-effects'
import { TornAcrossBoundaries } from './tabs/torn-across-boundaries'
import { OptimisticClobbered } from './tabs/optimistic-clobbered'
import { Entanglement } from './tabs/entanglement'
import './style.css'

type TabId =
  | 'torn-state'
  | 'spinner-flash'
  | 'lost-interactivity'
  | 'uncommittable'
  | 'stale-side-effects'
  | 'torn-across-boundaries'
  | 'optimistic-clobbered'
  | 'entanglement'

type TabGroup = 'failure-mode' | 'edge-case'

const TABS: Array<{ id: TabId; label: string; group: TabGroup }> = [
  { id: 'torn-state', label: 'FM1 · torn state', group: 'failure-mode' },
  { id: 'spinner-flash', label: 'FM2 · spinner flash', group: 'failure-mode' },
  { id: 'lost-interactivity', label: 'FM3 · lost interactivity', group: 'failure-mode' },
  { id: 'uncommittable', label: 'FM4 · uncommittable speculation', group: 'failure-mode' },
  { id: 'stale-side-effects', label: 'E1 · stale side effects', group: 'edge-case' },
  { id: 'torn-across-boundaries', label: 'E2 · torn across boundaries', group: 'edge-case' },
  { id: 'optimistic-clobbered', label: 'E3 · optimistic clobbered', group: 'edge-case' },
  { id: 'entanglement', label: 'E4 · entanglement', group: 'edge-case' },
]

const GROUPS: Array<{ group: TabGroup; label: string }> = [
  { group: 'failure-mode', label: 'the four failure modes' },
  { group: 'edge-case', label: 'edge cases — where it falls short' },
]

const [active, setActive] = signal<TabId>('torn-state')

function App() {
  return (
    <div class="app">
      <header class="app-head">
        <h1>transitions — failure modes &amp; edge cases</h1>
        <nav class="tabs">
          {GROUPS.map((g) => (
            <div class="tab-group">
              <span class="tab-group-label">{g.label}</span>
              <div class="tab-group-buttons">
                {TABS.filter((t) => t.group === g.group).map((tab) => (
                  <button
                    class:active={active() === tab.id}
                    attr:data-testid={`tab-${tab.id}`}
                    on:click={() => setActive(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </header>
      <main class="tab-host">
        <Show when={active() === 'torn-state'}><TornState /></Show>
        <Show when={active() === 'spinner-flash'}><SpinnerFlash /></Show>
        <Show when={active() === 'lost-interactivity'}><LostInteractivity /></Show>
        <Show when={active() === 'uncommittable'}><UncommittableSpeculation /></Show>
        <Show when={active() === 'stale-side-effects'}><StaleSideEffects /></Show>
        <Show when={active() === 'torn-across-boundaries'}><TornAcrossBoundaries /></Show>
        <Show when={active() === 'optimistic-clobbered'}><OptimisticClobbered /></Show>
        <Show when={active() === 'entanglement'}><Entanglement /></Show>
      </main>
    </div>
  )
}

render(() => <App />, document.getElementById('app')!)
