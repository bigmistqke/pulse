import { expect, test } from '@playwright/test'

test.describe('E2 — torn across boundaries', () => {
  // Known gap, not a flake: each boundary gathers correctly on its own, but
  // the two commit independently (header settles at 200ms, body at 1000ms),
  // so header and body disagree for the gap between them. Red until one
  // logical change spanning multiple <Loading> boundaries can commit as a
  // whole (see this demo's `actual` doc field). If this ever starts passing,
  // Playwright will flag it as an unexpected pass — that's the signal to
  // remove test.fail() here.
  test.fail('header and body boundaries never show different generations at once', async ({ page }) => {
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
