import { expect, test } from '@playwright/test'

test('async memo inside Loading resolves', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('tab-debug').click()
  const content = page.locator('[data-testid="content"]')
  await expect(content).toHaveText('hello world', { timeout: 5000 })
})
