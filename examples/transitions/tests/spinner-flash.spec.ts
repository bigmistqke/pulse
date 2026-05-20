import { expect, test } from '@playwright/test'

test.describe('FM2 — spinner flash', () => {
  test('hold-prior survives a boundary remount (no fallback flash)', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-spinner-flash"]').click()

    // First load completes.
    await expect(page.locator('[data-testid="payload"]')).toBeVisible()

    // A plain refetch holds prior: the fallback must not appear.
    await page.locator('[data-testid="refetch"]').click()
    await expect(page.locator('[data-testid="fallback"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="payload"]')).toContainText('payload #1')

    // Remount the boundary, then refetch. Poll the whole post-remount window:
    // the fallback must never appear (correct hold-prior behavior). This is the
    // FM2 failure — expected red until pulse gains transition support.
    await page.locator('[data-testid="remount"]').click()
    // wait for the boundary to come back, then refetch
    await expect(page.locator('[data-testid="payload"]')).toBeVisible()
    await page.locator('[data-testid="refetch"]').click()
    const sawFallback = await page.evaluate(async () => {
      let saw = false
      const deadline = performance.now() + 2500
      while (performance.now() < deadline) {
        if (document.querySelector('[data-testid="fallback"]')) saw = true
        await new Promise((r) => setTimeout(r, 8))
      }
      return saw
    })
    expect(sawFallback).toBe(false)
  })
})
