import { For } from 'solid-js'
import type { LatencyKnob } from './mock-async'

export function LatencyControls(props: { knobs: LatencyKnob[] }) {
  return (
    <div class="latency-controls">
      <h3>latency</h3>
      <For each={props.knobs}>
        {(knob) => {
          const k = knob()
          return (
            <label class="knob">
              <span class="knob-name">{k.name}</span>
              <input
                type="range"
                min="0"
                max="2000"
                step="50"
                data-testid={`latency-${k.name}`}
                value={k.ms()}
                onInput={(e: Event) =>
                  k.setMs(Number((e.currentTarget as HTMLInputElement).value))
                }
              />
              <span class="knob-value">{`${k.ms()}ms`}</span>
            </label>
          )
        }}
      </For>
    </div>
  )
}
