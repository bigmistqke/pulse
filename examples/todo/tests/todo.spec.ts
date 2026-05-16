import { test, expect } from '@playwright/test'

async function addTodo(page: import('@playwright/test').Page, text: string) {
  const before = await page.locator('.todo-list li').count()
  await page.fill('.new-todo', text)
  await page.keyboard.press('Enter')
  // Wait for the new item to appear before proceeding
  await expect(page.locator('.todo-list li')).toHaveCount(before + 1)
}

test.describe('TodoMVC', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('initial state shows empty-state message', async ({ page }) => {
    await expect(page.locator('.empty')).toHaveText('No todos yet.')
    await expect(page.locator('.todo-list')).not.toBeVisible()
  })

  test('add a todo shows it in the list', async ({ page }) => {
    await addTodo(page, 'Buy milk')
    await expect(page.locator('.todo-list li')).toHaveCount(1)
    await expect(page.locator('.todo-list li .text')).toHaveText('Buy milk')
    await expect(page.locator('.empty')).not.toBeVisible()
  })

  test('toggle a todo gives it done class and updates footer count', async ({ page }) => {
    await addTodo(page, 'First')
    await addTodo(page, 'Second')
    await addTodo(page, 'Third')

    const items = page.locator('.todo-list li')
    await expect(items).toHaveCount(3)

    // Toggle the second item
    await items.nth(1).locator('input[type="checkbox"]').click()

    await expect(items.nth(1)).toHaveClass(/done/)
    await expect(page.locator('.count')).toHaveText('2 items left')
  })

  test('pluralization: 3 active → "3 items left"', async ({ page }) => {
    await addTodo(page, 'A')
    await addTodo(page, 'B')
    await addTodo(page, 'C')
    await expect(page.locator('.count')).toHaveText('3 items left')
  })

  test('pluralization: 1 remaining → "1 item left"', async ({ page }) => {
    await addTodo(page, 'A')
    await addTodo(page, 'B')
    await addTodo(page, 'C')
    // Mark two as done
    const items = page.locator('.todo-list li')
    await items.nth(0).locator('input[type="checkbox"]').click()
    await items.nth(1).locator('input[type="checkbox"]').click()
    await expect(page.locator('.count')).toHaveText('1 item left')
  })

  test('pluralization: all done → "All done!"', async ({ page }) => {
    await addTodo(page, 'A')
    await addTodo(page, 'B')
    const items = page.locator('.todo-list li')
    await items.nth(0).locator('input[type="checkbox"]').click()
    await items.nth(1).locator('input[type="checkbox"]').click()
    await expect(page.locator('.count')).toHaveText('All done!')
  })

  test('remove a todo removes it from the list', async ({ page }) => {
    await addTodo(page, 'Keep me')
    await addTodo(page, 'Delete me')
    await expect(page.locator('.todo-list li')).toHaveCount(2)

    await page.locator('.todo-list li').nth(1).locator('.remove').click()
    await expect(page.locator('.todo-list li')).toHaveCount(1)
    await expect(page.locator('.todo-list li .text')).toHaveText('Keep me')
  })

  test('filter Active shows only active todos', async ({ page }) => {
    await addTodo(page, 'Active 1')
    await addTodo(page, 'Active 2')
    await addTodo(page, 'Done one')
    // Mark third as done
    await page.locator('.todo-list li').nth(2).locator('input[type="checkbox"]').click()

    await page.locator('.filters button', { hasText: 'Active' }).click()
    await expect(page.locator('.todo-list li')).toHaveCount(2)
    await expect(page.locator('.todo-list li .text').nth(0)).toHaveText('Active 1')
    await expect(page.locator('.todo-list li .text').nth(1)).toHaveText('Active 2')
  })

  test('filter Completed shows only completed todos', async ({ page }) => {
    await addTodo(page, 'Active')
    await addTodo(page, 'Done one')
    await page.locator('.todo-list li').nth(1).locator('input[type="checkbox"]').click()

    await page.locator('.filters button', { hasText: 'Completed' }).click()
    await expect(page.locator('.todo-list li')).toHaveCount(1)
    await expect(page.locator('.todo-list li .text')).toHaveText('Done one')
  })

  test('filter All shows all todos', async ({ page }) => {
    await addTodo(page, 'Active')
    await addTodo(page, 'Done')
    await page.locator('.todo-list li').nth(1).locator('input[type="checkbox"]').click()

    // Go to Active first, then back to All
    await page.locator('.filters button', { hasText: 'Active' }).click()
    await page.locator('.filters button', { hasText: 'All' }).click()
    await expect(page.locator('.todo-list li')).toHaveCount(2)
  })

  test('clear completed removes done todos', async ({ page }) => {
    await addTodo(page, 'Keep me')
    await addTodo(page, 'Done 1')
    await addTodo(page, 'Done 2')
    const items = page.locator('.todo-list li')
    await items.nth(1).locator('input[type="checkbox"]').click()
    await items.nth(2).locator('input[type="checkbox"]').click()

    await page.locator('.clear').click()
    await expect(page.locator('.todo-list li')).toHaveCount(1)
    await expect(page.locator('.todo-list li .text')).toHaveText('Keep me')
  })

  test('active filter button gets .active class', async ({ page }) => {
    await addTodo(page, 'A')
    // Initially "All" is active
    await expect(page.locator('.filters button', { hasText: 'All' })).toHaveClass(/active/)

    await page.locator('.filters button', { hasText: 'Active' }).click()
    await expect(page.locator('.filters button', { hasText: 'Active' })).toHaveClass(/active/)
    await expect(page.locator('.filters button', { hasText: 'All' })).not.toHaveClass(/active/)

    await page.locator('.filters button', { hasText: 'Completed' }).click()
    await expect(page.locator('.filters button', { hasText: 'Completed' })).toHaveClass(/active/)
  })
})
