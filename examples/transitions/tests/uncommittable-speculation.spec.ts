import { expect, test } from '@playwright/test'

test.describe('FM4 — uncommittable speculation', () => {
  test('a superseded toggle never leaves the committed list contradicting the toggle', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-uncommittable"]').click()

    const list = page.locator('[data-testid="list"]')
    await expect(list).toBeVisible()
    await expect(list).toHaveAttribute('data-gen', 'active')

    // Toggle to archived, then immediately back to active — the archived
    // fetch is now superseded.
    const toggle = page.locator('[data-testid="toggle"]')
    await toggle.click()
    await page.waitForTimeout(80)
    await toggle.click()

    // Through the rest of both fetches the committed list must never show the
    // superseded 'archived' generation.
    const sawSuperseded = await page.evaluate(async () => {
      let bad = false
      const deadline = performance.now() + 2500
      while (performance.now() < deadline) {
        const gen = document.querySelector('[data-testid="list"]')?.getAttribute('data-gen')
        if (gen === 'archived') bad = true
        await new Promise((r) => setTimeout(r, 8))
      }
      return bad
    })
    expect(sawSuperseded).toBe(false)
    await expect(list).toHaveAttribute('data-gen', 'active')
  })
})
