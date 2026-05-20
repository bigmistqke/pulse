import { render } from '@solidjs/web'
import { createSignal, Show } from 'solid-js'
import { TornState } from './tabs/torn-state'
import { SpinnerFlash } from './tabs/spinner-flash'
import { LostInteractivity } from './tabs/lost-interactivity'
import { UncommittableSpeculation } from './tabs/uncommittable-speculation'
import { StaleSideEffects } from './tabs/stale-side-effects'
import { TornAcrossBoundaries } from './tabs/torn-across-boundaries'
import { OptimisticClobbered } from './tabs/optimistic-clobbered'
import { Entanglement } from './tabs/entanglement'
import { OptimisticAction } from './tabs/optimistic-action'
import { AtomicSteps } from './tabs/atomic-steps'
import { SupersedeAction } from './tabs/supersede-action'
import { Debug } from './tabs/debug'
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
  | 'optimistic-action'
  | 'atomic-steps'
  | 'supersede-action'
  | 'debug'

type TabGroup = 'failure-mode' | 'edge-case' | 'transition-primitive' | 'sanity'

const TABS: Array<{ id: TabId; label: string; group: TabGroup }> = [
  { id: 'torn-state', label: 'FM1 · torn state', group: 'failure-mode' },
  { id: 'spinner-flash', label: 'FM2 · spinner flash', group: 'failure-mode' },
  { id: 'lost-interactivity', label: 'FM3 · lost interactivity', group: 'failure-mode' },
  { id: 'uncommittable', label: 'FM4 · uncommittable speculation', group: 'failure-mode' },
  { id: 'stale-side-effects', label: 'E1 · stale side effects', group: 'edge-case' },
  { id: 'torn-across-boundaries', label: 'E2 · torn across boundaries', group: 'edge-case' },
  { id: 'optimistic-clobbered', label: 'E3 · optimistic clobbered', group: 'edge-case' },
  { id: 'entanglement', label: 'E4 · entanglement', group: 'edge-case' },
  { id: 'optimistic-action', label: 'P1 · optimistic action', group: 'transition-primitive' },
  { id: 'atomic-steps', label: 'P2 · atomic transaction', group: 'transition-primitive' },
  { id: 'supersede-action', label: 'P3 · supersession', group: 'transition-primitive' },
  { id: 'debug', label: 'DBG · async memo in Loading', group: 'sanity' },
]

const GROUPS: Array<{ group: TabGroup; label: string }> = [
  { group: 'failure-mode', label: 'the four failure modes' },
  { group: 'edge-case', label: 'edge cases — where it falls short' },
  { group: 'transition-primitive', label: 'transition primitives — done right' },
  { group: 'sanity', label: 'sanity checks' },
]

function App() {
  const [active, setActive] = createSignal<TabId>('torn-state')

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
                    class={`${active() === tab.id ? 'active' : ''}`}
                    data-testid={`tab-${tab.id}`}
                    onClick={() => setActive(tab.id)}
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
        <Show when={active() === 'torn-state'}>{(_: any) => <TornState />}</Show>
        <Show when={active() === 'spinner-flash'}>{(_: any) => <SpinnerFlash />}</Show>
        <Show when={active() === 'lost-interactivity'}>{(_: any) => <LostInteractivity />}</Show>
        <Show when={active() === 'uncommittable'}>{(_: any) => <UncommittableSpeculation />}</Show>
        <Show when={active() === 'stale-side-effects'}>{(_: any) => <StaleSideEffects />}</Show>
        <Show when={active() === 'torn-across-boundaries'}>{(_: any) => <TornAcrossBoundaries />}</Show>
        <Show when={active() === 'optimistic-clobbered'}>{(_: any) => <OptimisticClobbered />}</Show>
        <Show when={active() === 'entanglement'}>{(_: any) => <Entanglement />}</Show>
        <Show when={active() === 'optimistic-action'}>{(_: any) => <OptimisticAction />}</Show>
        <Show when={active() === 'atomic-steps'}>{(_: any) => <AtomicSteps />}</Show>
        <Show when={active() === 'supersede-action'}>{(_: any) => <SupersedeAction />}</Show>
        <Show when={active() === 'debug'}>{(_: any) => <Debug />}</Show>
      </main>
    </div>
  )
}

render(() => <App />, document.getElementById('app')!)
