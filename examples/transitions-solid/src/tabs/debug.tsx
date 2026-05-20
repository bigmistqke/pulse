import { createMemo, Loading } from 'solid-js'
import { TabFrame } from '../kernel/tab-frame'

export function Debug() {
  const greeting = createMemo(async () => {
    await new Promise((r) => setTimeout(r, 100))
    return 'hello world'
  })

  const scenario = (
    <div class="scenario">
      <Loading fallback={<div>waiting…</div>}>
        <div data-testid="content">{greeting()}</div>
      </Loading>
    </div>
  )

  return (
    <TabFrame
      title="DEBUG · async memo inside Loading"
      quality="Async memo resolves inside Loading boundary"
      actual="Solid 2.x createMemo returns an accessor; accessing it inside Loading catches NotReadyError and shows fallback until resolved."
      scenario={scenario}
      controls={<div />}
      timeline={<div />}
    />
  )
}
