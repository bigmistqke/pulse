import { expect, test } from '@playwright/test'

// Polls the number of populated result fields (reservation / payment / order)
// for `ms` and returns the set of distinct counts observed.
async function observedCounts(page: import('@playwright/test').Page, ms: number) {
  return page.evaluate(async (duration) => {
    const seen = new Set<number>()
    const deadline = performance.now() + duration
    while (performance.now() < deadline) {
      const filled = ['reservation', 'payment', 'order'].filter(
        (id) =>
          !document
            .querySelector(`[data-testid="${id}"]`)!
            .textContent!.trim()
            .endsWith('—'),
      ).length
      seen.add(filled)
      await new Promise((r) => setTimeout(r, 16))
    }
    return [...seen].sort()
  }, ms)
}

test.describe('P2 — atomic transaction', () => {
  test('plain async commits each step separately — torn frames', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-atomic-steps"]').click()

    await page.locator('[data-testid="run-plain"]').click()
    const counts = await observedCounts(page, 2000)
    // Three independent commits: the workflow is visibly half-applied.
    expect(counts).toContain(1)
    expect(counts).toContain(2)
    expect(counts).toContain(3)
  })

  test('action() commits all three steps in one frame', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-atomic-steps"]').click()

    await page.locator('[data-testid="run-action"]').click()
    const counts = await observedCounts(page, 2000)
    // One transition: the field count jumps straight from 0 to 3 — never a
    // frame with one or two steps applied.
    expect(counts).not.toContain(1)
    expect(counts).not.toContain(2)
    expect(counts).toContain(3)
    await expect(page.locator('[data-testid="order"]')).toContainText('ORD-7')
  })
})
