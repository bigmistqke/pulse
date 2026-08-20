import { expect, test } from '@playwright/test'

test.describe('FM2 — spinner flash', () => {
  // Two boundaries read the same `data`, side by side: one through use(data),
  // one through use.latest(data). use(data) always throws while data is
  // pending, by design, so a freshly-remounted boundary treats a refetch in
  // flight as a first load and flashes its fallback. use.latest(data) only
  // throws while latest(data) has genuinely never resolved anything — that
  // memory lives on latest(data)'s own state, not on the boundary, so it
  // survives the remount and never flashes. See ADR 0014.
  test('use.latest(data) holds prior across a boundary remount; use(data) still flashes', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-spinner-flash"]').click()

    // First load completes on both panels.
    await expect(page.locator('[data-testid="payload-use"]')).toBeVisible()
    await expect(page.locator('[data-testid="payload-use-latest"]')).toBeVisible()

    // A plain refetch (no remount) holds prior on both — neither fallback appears.
    await page.locator('[data-testid="refetch"]').click()
    await expect(page.locator('[data-testid="fallback-use"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="fallback-use-latest"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="payload-use"]')).toContainText('payload #1', { timeout: 4000 })
    await expect(page.locator('[data-testid="payload-use-latest"]')).toContainText('payload #1', { timeout: 4000 })

    // Refetch, then remount both boundaries WHILE that refetch is still in flight.
    await page.locator('[data-testid="refetch"]').click()
    await page.locator('[data-testid="remount"]').click()
    const sawFallback = await page.evaluate(async () => {
      let sawUse = false
      let sawUseLatest = false
      const deadline = performance.now() + 2000
      while (performance.now() < deadline) {
        if (document.querySelector('[data-testid="fallback-use"]')) sawUse = true
        if (document.querySelector('[data-testid="fallback-use-latest"]')) sawUseLatest = true
        await new Promise((r) => setTimeout(r, 8))
      }
      return { sawUse, sawUseLatest }
    })
    expect(sawFallback.sawUse).toBe(true)
    expect(sawFallback.sawUseLatest).toBe(false)

    // Both panels converge on the fresh value once the refetch resolves.
    await expect(page.locator('[data-testid="payload-use"]')).toContainText('payload #2', { timeout: 4000 })
    await expect(page.locator('[data-testid="payload-use-latest"]')).toContainText('payload #2', { timeout: 4000 })
  })
})
