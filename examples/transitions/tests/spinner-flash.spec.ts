import { expect, test } from '@playwright/test'

test.describe('FM2 — spinner flash', () => {
  // Known gap, not a flake: <Loading> tracks "has ever loaded" per boundary
  // instance, so a freshly-remounted boundary has no memory that this data
  // already resolved once. Expected to fail until pulse gains transition
  // support (see this demo's `actual` doc field). If this ever starts
  // passing, Playwright will flag it as an unexpected pass — that's the
  // signal to remove test.fail() here.
  test.fail('hold-prior survives a boundary remount (no fallback flash)', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-spinner-flash"]').click()

    // First load completes.
    await expect(page.locator('[data-testid="payload"]')).toBeVisible()

    // A plain refetch holds prior: the fallback must not appear.
    await page.locator('[data-testid="refetch"]').click()
    await expect(page.locator('[data-testid="fallback"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="payload"]')).toContainText('payload #1', { timeout: 4000 })

    // Refetch, then remount the boundary WHILE that refetch is still in flight.
    // The freshly-mounted boundary first observes `data` pending, so its
    // per-boundary hasEverLoaded is false and it wrongly shows the fallback —
    // though `data` has resolved before. Correct behavior is hold-prior. This
    // assertion is the FM2 failure: red until pulse gains transition support.
    await page.locator('[data-testid="refetch"]').click()
    await page.locator('[data-testid="remount"]').click()
    const sawFallback = await page.evaluate(async () => {
      let saw = false
      const deadline = performance.now() + 2000
      while (performance.now() < deadline) {
        if (document.querySelector('[data-testid="fallback"]')) saw = true
        await new Promise((r) => setTimeout(r, 8))
      }
      return saw
    })
    expect(sawFallback).toBe(false)
  })
})
