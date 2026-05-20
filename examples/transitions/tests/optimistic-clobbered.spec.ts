import { expect, test } from '@playwright/test'

test.describe('E3 — optimistic value clobbered by refetch', () => {
  test('an optimistic comment survives a refetch that lands before its save', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-optimistic-clobbered"]').click()

    await expect(page.locator('[data-testid="comments"] li')).toHaveCount(2)

    // Add a comment (add latency 1200ms), then refresh (300ms) so the refresh
    // lands first. The optimistic comment must stay visible the whole time.
    await page.locator('[data-testid="add"]').click()
    await expect(page.locator('[data-testid="comments"] li')).toHaveCount(3)
    await page.locator('[data-testid="refresh"]').click()

    // Poll: the list must never drop below 3 items (the optimistic comment
    // must never vanish). Red until pulse has a scoped/overlay write.
    const vanished = await page.evaluate(async () => {
      let gone = false
      const deadline = performance.now() + 1800
      while (performance.now() < deadline) {
        if (document.querySelectorAll('[data-testid="comments"] li').length < 3) gone = true
        await new Promise((r) => setTimeout(r, 8))
      }
      return gone
    })
    expect(vanished).toBe(false)
  })
})
