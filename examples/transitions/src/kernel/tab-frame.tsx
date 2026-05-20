export interface TabFrameProps {
  title: string
  quality: string
  actual: string
  scenario: unknown
  controls: unknown
  timeline: unknown
}

export function TabFrame(props: TabFrameProps) {
  return (
    <section class="tab-frame">
      <header class="tab-head">
        <h2>{props.title}</h2>
        <p class="quality"><strong>Quality:</strong> {props.quality}</p>
        <p class="actual"><strong>Pulse today:</strong> {props.actual}</p>
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
