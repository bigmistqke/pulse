import { expect, test } from '@playwright/test'

test.describe('FM1 — torn state', () => {
  test('the three panes never show mixed generations during a transition', async ({ page }) => {
    await page.goto('/')
    // FM1 is the default tab.
    const panes = page.locator('[data-testid="profile-card"] .pane')
    await expect(panes).toHaveCount(3)
    for (let i = 0; i < 3; i++) {
      await expect(panes.nth(i)).toHaveAttribute('data-gen', 'alice')
    }

    await page.locator('[data-testid="navigate"]').click()

    // Poll the DOM through the whole transition: the set of data-gen values
    // must never contain more than one generation.
    const sawTorn = await page.evaluate(async () => {
      let torn = false
      const deadline = performance.now() + 2500
      while (performance.now() < deadline) {
        const gens = [...document.querySelectorAll('[data-testid="profile-card"] .pane')]
          .map((el) => el.getAttribute('data-gen'))
          .filter((g): g is string => g !== null)
        if (new Set(gens).size > 1) torn = true
        await new Promise((r) => setTimeout(r, 8))
      }
      return torn
    })
    expect(sawTorn).toBe(false)

    for (let i = 0; i < 3; i++) {
      await expect(panes.nth(i)).toHaveAttribute('data-gen', 'bob')
    }
  })
})
