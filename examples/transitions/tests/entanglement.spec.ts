import { expect, test } from '@playwright/test'

test.describe('E4 — entanglement', () => {
  test('a concurrent rename does not leave bio referencing a stale name', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="tab-entanglement"]').click()

    await expect(page.locator('[data-testid="display-name"]')).toContainText('alice')
    await expect(page.locator('[data-testid="bio"]')).toContainText('alice')

    // update-bio (1000ms) captures 'alice'. rename (300ms) mid-flight changes
    // the name. When update-bio commits, bio must reference the CURRENT name.
    await page.locator('[data-testid="update-bio"]').click()
    await page.locator('[data-testid="rename"]').click()

    // Wait for both to settle (rename at ~300ms, update-bio at ~1000ms).
    await expect(page.locator('[data-testid="display-name"]')).not.toContainText('alice', {
      timeout: 4000,
    })
    await page.waitForTimeout(1200)

    // The committed bio must reference whatever displayName now is.
    const nameText = (await page.locator('[data-testid="display-name"]').textContent()) ?? ''
    const bioText = (await page.locator('[data-testid="bio"]').textContent()) ?? ''
    const currentName = nameText.replace('name:', '').trim()
    expect(bioText).toContain(currentName)
  })
})
