// test/dynamic-upstream.test.ts
//
// Loading state crossing a tolerant read. A node that reads `latest(x)` holds
// a value and is not itself suspended, so its own pending flag is false — but
// the value it holds was computed from `x`, and will change when `x` resolves.
// The sources a recipe read through a verb are recorded as that node's dynamic
// upstream, and `isPending`/`promiseOf` walk them alongside the static
// pipeline chain. See ADR 0017.
import { describe, expect, test } from 'vitest'
import { computed, effect, isPending, latest, peek, promiseOf, signal, use } from '../src/index'

const settle = () => new Promise<void>((r) => setTimeout(r, 20))

describe('a tolerant read carries loading state into its reader', () => {
  /**
   * @canon spec-a-tolerant-read-carries-loading-state-into-its-reader
   */
  test('a reader of a first-loading source reports pending, and holds no value of its own', async () => {
    let release!: (v: number) => void
    const source = computed<Promise<number>>(() => new Promise<number>((r) => { release = r }))
    const reader = computed(() => (latest(source) ?? 0) + 1)
    effect(() => { peek(reader) })
    await settle()

    // The reader itself never suspended — it took the tolerant branch and
    // published 1. It is nonetheless pending, because 1 was computed from a
    // source that has not arrived.
    expect(peek(reader)).toBe(1)
    expect(isPending(reader)).toBe(true)
    expect(promiseOf(reader)).toBe(promiseOf(source))

    release(10)
    await settle()
    expect(peek(reader)).toBe(11)
    expect(isPending(reader)).toBe(false)
    expect(promiseOf(reader)).toBe(null)
  })

  /**
   * @canon spec-a-tolerant-read-carries-loading-state-into-its-reader
   */
  test('a refresh reports through the reader while the reader still shows the prior value', async () => {
    // Note what this does NOT rely on: the reader does re-run here, because a
    // refetch publishes the new promise as the source's value and that
    // invalidates readers. What it shows is that re-running does not lose the
    // report — the reader recomputes, reads the source tolerantly again, gets
    // the same stale value back, and still reports that a replacement is on
    // its way.
    const [page, setPage] = signal(0)
    let release!: (v: string) => void
    const source = computed<Promise<string>>(() => {
      const p = page()
      if (p === 0) return Promise.resolve('first')
      return new Promise<string>((r) => { release = r })
    })
    let readerRuns = 0
    const reader = computed(() => { readerRuns++; return `[${latest(source) ?? '-'}]` })
    effect(() => { peek(reader) })
    await settle()

    expect(peek(reader)).toBe('[first]')
    expect(isPending(reader)).toBe(false)
    const runsBeforeRefresh = readerRuns

    setPage(1)
    await settle()
    // It re-ran, and its tolerant read handed back the stale value again.
    expect(readerRuns).toBeGreaterThan(runsBeforeRefresh)
    expect(peek(reader)).toBe('[first]')
    // ...and reports that the value it holds is being replaced.
    expect(isPending(source)).toBe(true)
    expect(isPending(reader)).toBe(true)

    release('second')
    await settle()
    expect(peek(reader)).toBe('[second]')
    expect(isPending(reader)).toBe(false)
  })

  /**
   * @canon spec-a-read-through-peek-carries-no-pending-state-into-its-reader
   * @canon spec-a-computed-reading-through-peek-still-follows-its-source
   */
  test('peek does not carry it — that is the difference between peek and latest outside a binding', async () => {
    let release!: (v: number) => void
    const source = computed<Promise<number>>(() => new Promise<number>((r) => { release = r }))
    const viaPeek = computed(() => (peek(source) ?? 0) + 1)
    const viaLatest = computed(() => (latest(source) ?? 0) + 1)
    effect(() => { peek(viaPeek); peek(viaLatest) })
    await settle()

    expect(isPending(viaLatest)).toBe(true)
    expect(isPending(viaPeek)).toBe(false)

    release(10)
    await settle()
    // Both still converge — peek suppresses the report, not the dependency.
    expect(peek(viaPeek)).toBe(11)
    expect(peek(viaLatest)).toBe(11)
  })

  /**
   * @canon spec-a-tolerant-read-carries-loading-state-into-its-reader
   */
  test('use carries it too, so a settled read that later refreshes is reported', async () => {
    const [page, setPage] = signal(0)
    let release!: (v: string) => void
    const source = computed<Promise<string>>(() => {
      const p = page()
      if (p === 0) return Promise.resolve('first')
      return new Promise<string>((r) => { release = r })
    })
    const reader = computed(() => `[${use(source)}]`)
    effect(() => { peek(reader) })
    await settle()
    expect(peek(reader)).toBe('[first]')
    expect(isPending(reader)).toBe(false)

    setPage(1)
    await settle()
    expect(isPending(reader)).toBe(true)

    release('second')
    await settle()
    expect(peek(reader)).toBe('[second]')
    expect(isPending(reader)).toBe(false)
  })

  /**
   * @canon spec-a-tolerant-read-carries-loading-state-into-its-reader
   */
  test('it composes through a chain of readers', async () => {
    let release!: (v: number) => void
    const source = computed<Promise<number>>(() => new Promise<number>((r) => { release = r }))
    const middle = computed(() => (latest(source) ?? 0) + 1)
    const outer = computed(() => (latest(middle) ?? 0) * 2)
    effect(() => { peek(outer) })
    await settle()

    expect(isPending(middle)).toBe(true)
    expect(isPending(outer)).toBe(true)

    release(10)
    await settle()
    expect(peek(outer)).toBe(22)
    expect(isPending(outer)).toBe(false)
  })
})
