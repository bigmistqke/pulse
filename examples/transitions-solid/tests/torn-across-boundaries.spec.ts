import { expect, test } from '@playwright/test'

test.describe('E2 — torn across boundaries', () => {
  test('header and body boundaries never show different generations at once', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-torn-across-boundaries"]').click()

    await expect(page.locator('[data-testid="header"]')).toHaveAttribute('data-gen', 'alice')
    await expect(page.locator('[data-testid="body"]')).toHaveAttribute('data-gen', 'alice')

    await page.locator('[data-testid="navigate"]').click()

    // Poll the whole transition: header and body must never disagree.
    const sawTear = await page.evaluate(async () => {
      let tear = false
      const deadline = performance.now() + 2500
      while (performance.now() < deadline) {
        const h = document.querySelector('[data-testid="header"]')?.getAttribute('data-gen')
        const b = document.querySelector('[data-testid="body"]')?.getAttribute('data-gen')
        if (h && b && h !== b) tear = true
        await new Promise((r) => setTimeout(r, 8))
      }
      return tear
    })
    expect(sawTear).toBe(false)
  })
})
