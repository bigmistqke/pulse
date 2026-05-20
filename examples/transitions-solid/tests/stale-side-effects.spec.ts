import { expect, test } from '@playwright/test'

test.describe('E1 — stale side effects', () => {
  test('a superseded save cancels its in-flight work (side effect does not run)', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-stale-side-effects"]').click()

    // First save completes — 1 side effect.
    await page.locator('[data-testid="save"]').click()
    await expect(page.locator('[data-testid="committed"]')).toContainText('saved #1')
    await expect(page.locator('[data-testid="side-effect-count"]')).toHaveText('1')

    // Save twice rapidly — save #2 is superseded by save #3 before it resolves.
    await page.locator('[data-testid="save"]').click()
    await page.locator('[data-testid="save"]').click()
    await expect(page.locator('[data-testid="committed"]')).toContainText('saved #3')

    // Correct behavior: save #2 was cancelled, so only saves #1 and #3 ran
    // their side effect — total 2. Oracle: passes iff pulse fires onCleanup on
    // computed re-run.
    await page.waitForTimeout(900)
    await expect(page.locator('[data-testid="side-effect-count"]')).toHaveText('2')
  })
})
