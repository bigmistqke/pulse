import { render, Show, signal } from 'pulse'
import { LostInteractivity } from './tabs/lost-interactivity'
import { SpinnerFlash } from './tabs/spinner-flash'
import { TornState } from './tabs/torn-state'
import { UncommittableSpeculation } from './tabs/uncommittable-speculation'
import './style.css'

type TabId = 'torn-state' | 'spinner-flash' | 'lost-interactivity' | 'uncommittable'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'torn-state', label: 'FM1 · torn state' },
  { id: 'spinner-flash', label: 'FM2 · spinner flash' },
  { id: 'lost-interactivity', label: 'FM3 · lost interactivity' },
  { id: 'uncommittable', label: 'FM4 · uncommittable speculation' },
]

const [active, setActive] = signal<TabId>('torn-state')

function App() {
  return (
    <div class="app">
      <header class="app-head">
        <h1>transitions — the four failure modes</h1>
        <nav class="tabs">
          {TABS.map((tab) => (
            <button
              class:active={() => active() === tab.id}
              attr:data-testid={`tab-${tab.id}`}
              on:click={() => setActive(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main class="tab-host">
        <Show when={() => active() === 'torn-state'}>{() => <TornState />}</Show>
        <Show when={() => active() === 'spinner-flash'}>{() => <SpinnerFlash />}</Show>
        <Show when={() => active() === 'lost-interactivity'}>{() => <LostInteractivity />}</Show>
        <Show when={() => active() === 'uncommittable'}>{() => <UncommittableSpeculation />}</Show>
      </main>
    </div>
  )
}

render(() => <App />, document.getElementById('app')!)
