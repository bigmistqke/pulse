import { expect, test } from '@playwright/test'

test.describe('P1 — optimistic action', () => {
  test('an optimistic comment shows at once, commits on success', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-optimistic-action"]').click()

    const items = page.locator('[data-testid="comments"] li')
    await expect(items).toHaveCount(2)

    // The optimistic row appears immediately — flagged pending — long before
    // the 900ms request settles. A non-optimistic write would show nothing
    // until commit.
    await page.locator('[data-testid="add"]').click()
    const pending = page.locator('[data-testid="comments"] li[data-pending="true"]')
    await expect(pending).toHaveCount(1)
    await expect(items).toHaveCount(3)

    // When the request settles the row commits in place — pending flag clears,
    // count holds at 3.
    await expect(pending).toHaveCount(0, { timeout: 4000 })
    await expect(items).toHaveCount(3)
    await expect(page.locator('[data-testid="comments"] li[data-pending="false"]')).toHaveCount(3)
  })

  test('a failing request auto-reverts its optimistic comment', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-optimistic-action"]').click()

    const items = page.locator('[data-testid="comments"] li')
    await expect(items).toHaveCount(2)

    // Commit one real comment first — it must survive the later revert.
    await page.locator('[data-testid="add"]').click()
    await expect(items).toHaveCount(3)
    await expect(page.locator('[data-testid="comments"] li[data-pending="true"]')).toHaveCount(0, {
      timeout: 4000,
    })

    // The failing add shows optimistically, then rolls back when the request
    // rejects — count returns to 3, and the earlier committed comment stays.
    await page.locator('[data-testid="add-failing"]').click()
    await expect(items).toHaveCount(4)
    await expect(page.locator('[data-testid="comments"] li[data-pending="true"]')).toHaveCount(1)
    await expect(items).toHaveCount(3, { timeout: 4000 })
    await expect(page.locator('[data-testid="comments"] li[data-pending="false"]')).toHaveCount(3)
  })
})
