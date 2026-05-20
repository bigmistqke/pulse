import type { JSX } from 'solid-js/jsx-runtime'

export interface TabFrameProps {
  title: string
  quality: string
  actual: string
  scenario: JSX.Element
  controls: JSX.Element
  timeline: JSX.Element
}

export function TabFrame(props: TabFrameProps) {
  return (
    <section class="tab-frame">
      <header class="tab-head">
        <h2>{props.title}</h2>
        <p class="quality"><strong>Quality:</strong> {props.quality}</p>
        <p class="actual"><strong>Solid 2.x:</strong> {props.actual}</p>
      </header>
      <div class="tab-body">
        <div class="scenario-pane">{props.scenario}</div>
        <aside class="tab-side">
          <div class="controls-pane">{props.controls}</div>
          {props.timeline}
        </aside>
      </div>
    </section>
  )
}
