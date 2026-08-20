import { expect, test } from '@playwright/test'

test.describe('E3 — optimistic value clobbered by refetch', () => {
  test('documents the E3 failure: a refetch that lands first overwrites the optimistic comment', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-optimistic-clobbered"]').click()

    await expect(page.locator('[data-testid="comments"] li')).toHaveCount(2)

    // Add a comment (add latency 1200ms), then refresh (300ms) so the refresh
    // lands first.
    await page.locator('[data-testid="add"]').click()
    await expect(page.locator('[data-testid="comments"] li')).toHaveCount(3)
    await page.locator('[data-testid="refresh"]').click()

    // Poll: the optimistic overlay and committed truth share one signal
    // cell, so the refresh's setComments(list) overwrites the optimistic
    // entry once it lands. This assertion documents that vanish as it
    // stands today, and should flip to `toBe(false)` once the overlay is
    // held in its own signal and merged with committed truth via a
    // computed (see this demo's `actual` doc field).
    const vanished = await page.evaluate(async () => {
      let gone = false
      const deadline = performance.now() + 1800
      while (performance.now() < deadline) {
        if (document.querySelectorAll('[data-testid="comments"] li').length < 3) gone = true
        await new Promise((r) => setTimeout(r, 8))
      }
      return gone
    })
    expect(vanished).toBe(true)
  })
})
