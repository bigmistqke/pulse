import { expect, test } from '@playwright/test'

test.describe('FM3 — lost interactivity', () => {
  test('input keeps focus and stale results never replace newer ones', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-lost-interactivity"]').click()

    const search = page.locator('[data-testid="search"]')
    await search.click()

    // Type a sequence of queries quickly (each keystroke is a new query).
    for (const q of ['r', 're', 'rea', 'reac', 'react']) {
      await search.fill(q)
      await page.waitForTimeout(60)
    }

    // The input must still hold focus.
    await expect(search).toBeFocused()

    // Once everything settles, the results must reflect the LAST query and
    // never a stale earlier one.
    const results = page.locator('[data-testid="results"]')
    await expect(results).toHaveAttribute('data-result-query', 'react')
    await page.waitForTimeout(800)
    await expect(results).toHaveAttribute('data-result-query', 'react')
    await expect(results.locator('li').first()).toContainText('react')
  })
})
