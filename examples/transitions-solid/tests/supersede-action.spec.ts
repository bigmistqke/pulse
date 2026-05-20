import { expect, test } from '@playwright/test'

test.describe('P3 — supersession', () => {
  test('a superseded save neither commits nor runs its side effect', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-supersede-action"]').click()

    // First save completes — 1 side effect.
    await page.locator('[data-testid="save"]').click()
    await expect(page.locator('[data-testid="committed"]')).toContainText('saved #1')
    await expect(page.locator('[data-testid="side-effect-count"]')).toHaveText('1')

    // Save twice rapidly — save #2 is superseded by #3 before it resolves.
    // The action behind #3 aborts #2's request, so #2 throws and commits
    // nothing; only #3 reaches the committed value.
    await page.locator('[data-testid="save"]').click()
    await page.locator('[data-testid="save"]').click()
    await expect(page.locator('[data-testid="committed"]')).toContainText('saved #3')

    // Only saves #1 and #3 ran their side effect — #2 was cancelled.
    await page.waitForTimeout(900)
    await expect(page.locator('[data-testid="side-effect-count"]')).toHaveText('2')
    await expect(page.locator('[data-testid="committed"]')).toContainText('saved #3')
  })
})
