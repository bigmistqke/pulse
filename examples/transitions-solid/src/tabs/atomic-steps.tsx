import { action, createSignal, flush } from 'solid-js'
import { EventTimeline, createEventLog } from '../kernel/event-log'
import { LatencyControls } from '../kernel/latency-controls'
import { latencyKnob, mockFetch } from '../kernel/mock-async'
import { TabFrame } from '../kernel/tab-frame'

export function AtomicSteps() {
  const log = createEventLog()
  const reserveKnob = latencyKnob('reserve', 500)
  const payKnob = latencyKnob('pay', 500)
  const confirmKnob = latencyKnob('confirm', 500)

  const [reservation, setReservation] = createSignal('')
  const [payment, setPayment] = createSignal('')
  const [order, setOrder] = createSignal('')
  const [mode, setMode] = createSignal('idle')

  function reset(label: string) {
    setReservation('')
    setPayment('')
    setOrder('')
    setMode(label)
    // flush() commits the reset on its own — without it these writes would
    // share the tick with the action below and be swept into its transition.
    flush()
  }

  const reserve = () =>
    mockFetch({ log, knob: reserveKnob, generation: 'reserve', produce: () => 'RSV-1837' })
  const pay = () =>
    mockFetch({ log, knob: payKnob, generation: 'pay', produce: () => 'PAY-44910' })
  const confirm = () =>
    mockFetch({ log, knob: confirmKnob, generation: 'confirm', produce: () => 'ORD-7' })

  // Plain async: three awaits, three independent commits. Each setter lands on
  // its own flush, so the UI shows the workflow half-applied between steps.
  async function runPlain() {
    log.emit('action', 'plain async run', 'p0')
    reset('plain async')
    setReservation(await reserve())
    setPayment(await pay())
    setOrder(await confirm())
    log.emit('action', 'plain run done (committed in 3 frames)', 'p0')
  }

  // action(): one transition spanning all three awaits. Every write is held
  // and commits together when the generator returns — one frame, never torn.
  const checkout = action(function* () {
    const ticket: string = yield reserve()
    setReservation(ticket)
    const receipt: string = yield pay()
    setPayment(receipt)
    const ord: string = yield confirm()
    setOrder(ord)
  })
  function runAction() {
    log.emit('action', 'action() run', 'p0')
    reset('action()')
    checkout().then(() => log.emit('action', 'action committed atomically', 'p0'))
  }

  const scenario = (
    <div class="scenario">
      <div class="btn-row">
        <button data-testid="run-plain" onClick={runPlain}>
          run (plain async)
        </button>
        <button data-testid="run-action" onClick={runAction}>
          run (action)
        </button>
      </div>
      <div class="pane" data-testid="mode" data-gen="current">
        mode: {mode()}
      </div>
      <div class="list-card">
        <div data-testid="reservation">reservation: {reservation() || '—'}</div>
        <div data-testid="payment">payment: {payment() || '—'}</div>
        <div data-testid="order">order: {order() || '—'}</div>
      </div>
    </div>
  )

  return (
    <TabFrame
      title="P2 · Atomic transaction"
      quality="A multi-step async workflow should commit as one unit — the UI never shows it half-applied, with one step's result on screen and the next still missing."
      actual="Solid 2.x: a plain async fn commits each await separately (torn frames); an action() generator is a single transition that commits every step in one frame."
      scenario={scenario}
      controls={<LatencyControls knobs={[reserveKnob, payKnob, confirmKnob]} />}
      timeline={<EventTimeline log={log} />}
    />
  )
}
