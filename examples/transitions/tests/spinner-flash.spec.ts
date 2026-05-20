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

    // Remount the boundary, then refetch. Correct behavior: still hold-prior,
    // no fallback. This is the FM2 failure — red until transitions land.
    await page.locator('[data-testid="remount"]').click()
    await page.locator('[data-testid="refetch"]').click()
    await expect(page.locator('[data-testid="fallback"]')).toHaveCount(0)
  })
})
