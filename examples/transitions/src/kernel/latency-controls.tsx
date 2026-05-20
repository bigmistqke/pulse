import { For } from 'pulse'
import type { LatencyKnob } from './mock-async'

export function LatencyControls(props: { knobs: LatencyKnob[] }) {
  return (
    <div class="latency-controls">
      <h3>latency</h3>
      <For each={() => props.knobs}>
        {(knob) => (
          <label class="knob">
            <span class="knob-name">{knob.name}</span>
            <input
              attr:type="range"
              attr:min="0"
              attr:max="2000"
              attr:step="50"
              attr:data-testid={`latency-${knob.name}`}
              prop:value={() => knob.ms()}
              on:input={(e: Event) =>
                knob.setMs(Number((e.currentTarget as HTMLInputElement).value))
              }
            />
            <span class="knob-value">{() => `${knob.ms()}ms`}</span>
          </label>
        )}
      </For>
    </div>
  )
}
