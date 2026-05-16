import { test, expect, type Page, type Route } from '@playwright/test'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const listPage0 = {
  count: 1302,
  results: [
    { name: 'bulbasaur', url: 'https://pokeapi.co/api/v2/pokemon/1/' },
    { name: 'ivysaur', url: 'https://pokeapi.co/api/v2/pokemon/2/' },
    { name: 'charmander', url: 'https://pokeapi.co/api/v2/pokemon/4/' },
  ],
}

const listPage1 = {
  count: 1302,
  results: [
    { name: 'wartortle', url: 'https://pokeapi.co/api/v2/pokemon/8/' },
    { name: 'blastoise', url: 'https://pokeapi.co/api/v2/pokemon/9/' },
  ],
}

const bulbasaur = {
  id: 1,
  name: 'bulbasaur',
  sprites: { front_default: 'https://example.com/bulbasaur.png' },
  types: [{ type: { name: 'grass' } }, { type: { name: 'poison' } }],
  stats: [
    { base_stat: 45, stat: { name: 'hp' } },
    { base_stat: 49, stat: { name: 'attack' } },
  ],
}

const ivysaur = {
  id: 2,
  name: 'ivysaur',
  sprites: { front_default: 'https://example.com/ivysaur.png' },
  types: [{ type: { name: 'grass' } }],
  stats: [{ base_stat: 60, stat: { name: 'hp' } }],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Install standard API mocks (no delay). */
async function mockApi(page: Page) {
  await page.route(
    (url) => url.href.includes('/api/v2/pokemon?offset=0&limit=20'),
    (route) => route.fulfill({ json: listPage0 }),
  )
  await page.route(
    (url) => url.href.includes('/api/v2/pokemon?offset=20&limit=20'),
    (route) => route.fulfill({ json: listPage1 }),
  )
  await page.route(
    (url) => url.pathname.endsWith('/api/v2/pokemon/bulbasaur'),
    (route) => route.fulfill({ json: bulbasaur }),
  )
  await page.route(
    (url) => url.pathname.endsWith('/api/v2/pokemon/ivysaur'),
    (route) => route.fulfill({ json: ivysaur }),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Pokédex', () => {
  test('initial load shows 3 pokémon names', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    const items = page.locator('.list li button.name')
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toHaveText('bulbasaur')
    await expect(items.nth(1)).toHaveText('ivysaur')
    await expect(items.nth(2)).toHaveText('charmander')
  })

  test('pagination: next → shows page 1 names', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await expect(page.locator('.list li button.name')).toHaveCount(3)

    await page.locator('button', { hasText: 'next →' }).click()
    const items = page.locator('.list li button.name')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toHaveText('wartortle')
    await expect(items.nth(1)).toHaveText('blastoise')
  })

  test('prev button is disabled on page 0 and enabled after advancing', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await expect(page.locator('.list li button.name')).toHaveCount(3)

    const prev = page.locator('button', { hasText: '← prev' })
    await expect(prev).toBeDisabled()

    await page.locator('button', { hasText: 'next →' }).click()
    await expect(page.locator('.list li button.name')).toHaveCount(2)
    await expect(prev).toBeEnabled()
  })

  test('expand details: clicking a name shows details panel', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await expect(page.locator('.list li button.name')).toHaveCount(3)

    await page.locator('button.name', { hasText: 'bulbasaur' }).click()
    const details = page.locator('.details')
    await expect(details).toBeVisible()
    await expect(details.locator('.type').nth(0)).toHaveText('grass')
    await expect(details.locator('.type').nth(1)).toHaveText('poison')
    await expect(details.locator('img')).toHaveAttribute('src', bulbasaur.sprites.front_default)
  })

  test('collapse details: clicking the same name again hides details', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await expect(page.locator('.list li button.name')).toHaveCount(3)

    await page.locator('button.name', { hasText: 'bulbasaur' }).click()
    await expect(page.locator('.details')).toBeVisible()

    await page.locator('button.name', { hasText: 'bulbasaur' }).click()
    await expect(page.locator('.details')).not.toBeVisible()
  })

  test('clicking different row: only that row shows details', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await expect(page.locator('.list li button.name')).toHaveCount(3)

    await page.locator('button.name', { hasText: 'bulbasaur' }).click()
    await expect(page.locator('.details')).toHaveCount(1)

    await page.locator('button.name', { hasText: 'ivysaur' }).click()
    await expect(page.locator('.details')).toHaveCount(1)
    // ivysaur's stats
    const rows = page.locator('.details table.stats tr')
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('60')
  })

  test('refreshing indicator appears while next page is loading', async ({ page }) => {
    // Page 0: immediate
    await page.route(
      (url) => url.href.includes('/api/v2/pokemon?offset=0&limit=20'),
      (route) => route.fulfill({ json: listPage0 }),
    )
    // Page 1: delayed
    await page.route(
      (url) => url.href.includes('/api/v2/pokemon?offset=20&limit=20'),
      async (route) => {
        await new Promise((r) => setTimeout(r, 600))
        await route.fulfill({ json: listPage1 })
      },
    )

    await page.goto('/')
    await expect(page.locator('.list li button.name')).toHaveCount(3)

    // Click next — don't await completion yet
    await page.locator('button', { hasText: 'next →' }).click()

    // Refreshing indicator should appear
    await expect(page.locator('.indicator')).toBeVisible()
    await expect(page.locator('.indicator')).toHaveText('refreshing…')

    // Wait for load to complete
    await expect(page.locator('.list li button.name')).toHaveCount(2)
    await expect(page.locator('.indicator')).not.toBeVisible()
  })

  test('page label and items commit atomically (transition snapshot)', async ({ page }) => {
    await page.route(
      (url) => url.href.includes('/api/v2/pokemon?offset=0&limit=20'),
      (route) => route.fulfill({ json: listPage0 }),
    )
    let releasePage1!: () => void
    const page1Gate = new Promise<void>((r) => { releasePage1 = r })
    await page.route(
      (url) => url.href.includes('/api/v2/pokemon?offset=20&limit=20'),
      async (route) => {
        await page1Gate
        await route.fulfill({ json: listPage1 })
      },
    )

    await page.goto('/')
    await expect(page.locator('.list li button.name')).toHaveCount(3)
    const pageLabel = page.locator('.paging span')
    await expect(pageLabel).toHaveText('page 1')

    await page.locator('button', { hasText: 'next →' }).click()

    // Mid-refetch: label stays at page 1, items stay at page 0 names.
    // The .loading class is applied for the grey-out cue.
    await expect(pageLabel).toHaveText('page 1')
    await expect(page.locator('.list li button.name')).toHaveCount(3)
    await expect(pageLabel).toHaveClass(/loading/)

    // Release the request; both label and items commit together.
    releasePage1()
    await expect(pageLabel).toHaveText('page 2')
    await expect(page.locator('.list li button.name')).toHaveCount(2)
    await expect(pageLabel).not.toHaveClass(/loading/)
  })

  test('initial spinner appears during first load', async ({ page }) => {
    // Delay the initial list request
    await page.route(
      (url) => url.href.includes('/api/v2/pokemon?offset=0&limit=20'),
      async (route) => {
        await new Promise((r) => setTimeout(r, 600))
        await route.fulfill({ json: listPage0 })
      },
    )

    const navPromise = page.goto('/')

    await expect(page.locator('.spinner')).toBeVisible()
    await expect(page.locator('.spinner')).toHaveText('loading…')

    await navPromise
    await expect(page.locator('.list li button.name')).toHaveCount(3)
    await expect(page.locator('.spinner')).not.toBeVisible()
  })

  test('detail spinner appears while pokemon details are loading', async ({ page }) => {
    // List loads immediately
    await page.route(
      (url) => url.href.includes('/api/v2/pokemon?offset=0&limit=20'),
      (route) => route.fulfill({ json: listPage0 }),
    )
    // Bulbasaur detail is delayed
    await page.route(
      (url) => url.pathname.endsWith('/api/v2/pokemon/bulbasaur'),
      async (route) => {
        await new Promise((r) => setTimeout(r, 600))
        await route.fulfill({ json: bulbasaur })
      },
    )

    await page.goto('/')
    await expect(page.locator('.list li button.name')).toHaveCount(3)

    await page.locator('button.name', { hasText: 'bulbasaur' }).click()

    // Loading detail spinner
    await expect(page.locator('.detail-spinner')).toBeVisible()
    await expect(page.locator('.detail-spinner')).toHaveText('loading details…')

    // After load, details appear and spinner gone
    await expect(page.locator('.details')).toBeVisible()
    await expect(page.locator('.detail-spinner')).not.toBeVisible()
  })
})
