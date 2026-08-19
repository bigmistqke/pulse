import { expect, test, type Page } from '@playwright/test'

/**
 * The demo reads its fake server's latency and failure rate from the query
 * string so a test can pin them. `latency` is milliseconds per request;
 * `fail` is a rate between 0 and 1, where 1 means every request rejects.
 */
const open = (page: Page, params: Record<string, string | number> = {}) => {
  const query = new URLSearchParams({ latency: '80', fail: '0', ...params } as Record<string, string>)
  return page.goto(`/?${query}`)
}

const rows = (page: Page) => page.getByTestId('todo-row')
const canonicalRows = (page: Page) => page.getByTestId('canonical-row')

async function addTodo(page: Page, text: string) {
  const input = page.getByTestId('new-todo')
  await input.fill(text)
  await input.press('Enter')
}

test('the initial load shows a skeleton, then the list', async ({ page }) => {
  await open(page, { latency: 400 })

  // `<Loading initial>` renders in place of the subtree while nothing has
  // committed yet, so the list is not merely invisible — it does not exist.
  await expect(page.getByTestId('skeleton')).toBeVisible()
  await expect(page.getByTestId('todo-list')).not.toBeAttached()

  await expect(page.getByTestId('todo-list')).toBeAttached({ timeout: 5000 })
  await expect(page.getByTestId('remaining')).toHaveText(/0 left/)
  await expect(page.getByTestId('skeleton')).not.toBeAttached()
})

test('an added todo appears before the server has answered', async ({ page }) => {
  await open(page, { latency: 600 })
  await expect(page.getByTestId('todo-list')).toBeAttached({ timeout: 5000 })

  const before = await rows(page).count()
  await addTodo(page, 'write the demo')

  // The optimistic overlay is visible immediately — well inside the 600ms
  // the server takes to answer.
  await expect(rows(page)).toHaveCount(before + 1, { timeout: 250 })
  await expect(rows(page).filter({ hasText: 'write the demo' })).toBeVisible()

  // Canonical state has NOT caught up yet: the overlay is what you are seeing.
  await expect(canonicalRows(page)).toHaveCount(before)

  // ...and then it does.
  await expect(canonicalRows(page)).toHaveCount(before + 1, { timeout: 5000 })
})

test('a rejected write rolls the optimistic row back', async ({ page }) => {
  // Load cleanly first — a failure rate of 1 from the start would fail the
  // initial fetch too, and this test is about a rejected *write*.
  await open(page, { latency: 200, fail: 0 })
  await expect(page.getByTestId('todo-list')).toBeAttached({ timeout: 5000 })

  const before = await rows(page).count()
  await page.getByTestId('fail-rate').fill('1')
  await addTodo(page, 'doomed')

  await expect(rows(page).filter({ hasText: 'doomed' })).toBeVisible({ timeout: 250 })

  // The action discards, its overlay is dropped, and the row goes away again.
  await expect(rows(page).filter({ hasText: 'doomed' })).toHaveCount(0, { timeout: 5000 })
  await expect(rows(page)).toHaveCount(before)
  await expect(canonicalRows(page)).toHaveCount(before)
})

test('a rejected write shows an inline banner without hiding the list, and its retry button resubmits the same request', async ({ page }) => {
  await open(page, { latency: 200, fail: 0 })
  await expect(page.getByTestId('todo-list')).toBeAttached({ timeout: 5000 })

  await page.getByTestId('fail-rate').fill('1')
  await addTodo(page, 'retry me')

  // The write is refused. It registers with the mutation boundary, not the
  // load boundary, so the list stays attached and only a banner appears.
  await expect(page.getByTestId('mutation-error-panel')).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('mutation-error-panel')).toContainText(
    'the server refused this request',
  )
  await expect(page.getByTestId('todo-list')).toBeAttached()
  await expect(page.getByTestId('error-panel')).not.toBeAttached()
  const retryButton = page.getByTestId('mutation-retry')

  // Fix the server, then press retry — the same request is issued again.
  await page.getByTestId('fail-rate').fill('0')
  await retryButton.click()

  await expect(page.getByTestId('mutation-error-panel')).not.toBeAttached({ timeout: 5000 })
  await expect(
    page.getByTestId('todo-row').filter({ hasText: 'retry me' }),
  ).toBeVisible({ timeout: 5000 })
})

test('a refetch holds the current list on screen while it is in flight', async ({ page }) => {
  await open(page, { latency: 100 })
  await expect(page.getByTestId('todo-list')).toBeAttached({ timeout: 5000 })
  await addTodo(page, 'stays visible')
  await expect(canonicalRows(page).filter({ hasText: 'stays visible' })).toBeVisible({
    timeout: 5000,
  })

  const before = await rows(page).count()

  await page.getByTestId('latency').fill('600')
  await page.getByTestId('refetch').click()

  // Stale-while-revalidate: the prior list stays put rather than being replaced
  // by the skeleton, and an in-flight cue appears instead.
  await expect(page.getByTestId('inflight')).toBeVisible({ timeout: 250 })
  await expect(page.getByTestId('skeleton')).not.toBeAttached()
  await expect(rows(page)).toHaveCount(before)
  await expect(rows(page).filter({ hasText: 'stays visible' })).toBeVisible()

  await expect(page.getByTestId('inflight')).toBeHidden({ timeout: 5000 })
  await expect(rows(page)).toHaveCount(before)
})

test('a failed load shows the error boundary, and retry recovers', async ({ page }) => {
  await open(page, { latency: 80, fail: 1 })

  await expect(page.getByTestId('error-panel')).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('todo-list')).not.toBeAttached()

  // Stop the server failing, then retry from the boundary.
  await page.getByTestId('fail-rate').fill('0')
  await page.getByTestId('retry').click()

  await expect(page.getByTestId('todo-list')).toBeAttached({ timeout: 5000 })
  await expect(page.getByTestId('error-panel')).toBeHidden()
})

test('the remaining count and the list commit together', async ({ page }) => {
  await open(page, { latency: 100 })
  await expect(page.getByTestId('todo-list')).toBeAttached({ timeout: 5000 })

  await addTodo(page, 'first')
  await expect(canonicalRows(page).filter({ hasText: 'first' })).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('remaining')).toHaveText(/1 left/)

  await addTodo(page, 'second')
  await expect(canonicalRows(page).filter({ hasText: 'second' })).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('remaining')).toHaveText(/2 left/)

  await rows(page).filter({ hasText: 'first' }).getByRole('checkbox').click()
  await expect(page.getByTestId('remaining')).toHaveText(/1 left/, { timeout: 5000 })
})

test('filters select which todos are shown', async ({ page }) => {
  await open(page, { latency: 60 })
  await expect(page.getByTestId('todo-list')).toBeAttached({ timeout: 5000 })

  await addTodo(page, 'alpha')
  await expect(canonicalRows(page).filter({ hasText: 'alpha' })).toBeVisible({ timeout: 5000 })
  await addTodo(page, 'beta')
  await expect(canonicalRows(page).filter({ hasText: 'beta' })).toBeVisible({ timeout: 5000 })

  await rows(page).filter({ hasText: 'alpha' }).getByRole('checkbox').click()
  await expect(page.getByTestId('remaining')).toHaveText(/1 left/, { timeout: 5000 })

  await page.getByTestId('filter-active').click()
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).filter({ hasText: 'beta' })).toBeVisible()

  await page.getByTestId('filter-completed').click()
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).filter({ hasText: 'alpha' })).toBeVisible()

  await page.getByTestId('filter-all').click()
  await expect(rows(page)).toHaveCount(2)
})
