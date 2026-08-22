import { expect, test, type Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// The mock server answers a shorter label more slowly (see `latencyFor` in
// src/api.ts: max(150, 1000 - label.length * 80)), so typing forwards issues
// requests whose answers come back in reverse order. Nothing here mocks the
// network — the timings below are the ones the app itself produces.
//
//   ''              1000ms      'Rome'            680ms
//   'a'              920ms      'Berlin'          520ms
//   'amste'          600ms      'San Francisco'   150ms
// ---------------------------------------------------------------------------

type LogRow = {
	id: number
	kind: string
	label: string
	settledAt: number | null
	supersededBy: number | null
}

async function readLog(page: Page): Promise<LogRow[]> {
	return page.$$eval('[data-testid="log-row"]', rows =>
		rows.map(row => {
			const settled = row.getAttribute('data-settled-at') ?? ''
			const superseded = row.getAttribute('data-superseded-by') ?? ''
			return {
				id: Number(row.getAttribute('data-request-id')),
				kind: row.getAttribute('data-kind') ?? '',
				label: row.getAttribute('data-label') ?? '',
				settledAt: settled === '' ? null : Number(settled),
				supersededBy: superseded === '' ? null : Number(superseded),
			}
		}),
	)
}

function rowFor(log: LogRow[], kind: string, label: string): LogRow {
	const row = log.find(each => each.kind === kind && each.label === label)
	if (row === undefined) throw new Error(`no ${kind} request logged for “${label}”`)
	return row
}

/** Wait until no request is in flight. */
async function quiet(page: Page): Promise<void> {
	await expect(page.locator('[data-testid="log-row"].inflight')).toHaveCount(0, { timeout: 8000 })
}

/**
 * Record every distinct value a set of elements takes from now on, so a test
 * can assert on what actually reached the screen over a window rather than
 * only on where it came to rest. Snapshotting a settled end state cannot tell
 * a list that never showed a superseded answer apart from one that showed it
 * and then corrected itself.
 */
async function startRecording(page: Page, testids: string[]): Promise<void> {
	await page.evaluate(ids => {
		const store = (window as unknown as { __seen: string[] })
		store.__seen = []
		const sample = () => {
			const text = ids
				.map(id => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '(absent)')
				.join(' | ')
			if (store.__seen[store.__seen.length - 1] !== text) store.__seen.push(text)
		}
		sample()
		new MutationObserver(sample).observe(document.body, {
			subtree: true,
			childList: true,
			characterData: true,
		})
	}, testids)
}

async function recorded(page: Page): Promise<string[]> {
	return page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)
}

async function loaded(page: Page): Promise<void> {
	await page.goto('/?mode=inverse')
	await expect(page.getByTestId('showing-query')).toHaveText('every city', { timeout: 8000 })
	await quiet(page)
}

test.describe('first load', () => {
	test('the list shows a skeleton until the first result set arrives', async ({ page }) => {
		await page.goto('/?mode=inverse')
		await expect(page.getByTestId('list-skeleton')).toBeVisible()
		await expect(page.getByTestId('hits')).toHaveCount(0)

		await expect(page.getByTestId('showing-query')).toHaveText('every city', { timeout: 8000 })
		await expect(page.getByTestId('hit')).toHaveCount(50)
		await expect(page.getByTestId('list-skeleton')).toHaveCount(0)
	})

	test('the detail header names the selected city before its record arrives', async ({ page }) => {
		// A long fixed latency, so that the window this test asserts inside is
		// wide. In the default mode the first detail request takes 280ms, which
		// a loaded machine can spend on the first assertion, leaving the second
		// one to look for an indicator that has already gone.
		await page.goto('/?mode=fixed&latency=2000')
		// The header never calls use(), so it commits without waiting for the
		// record — it is readable while the fields below are still suspended.
		await expect(page.getByTestId('detail-requested')).toHaveText('Amsterdam')
		await expect(page.getByTestId('detail-loading')).toBeVisible()
		await expect(page.getByTestId('detail-name')).toHaveText('Amsterdam', { timeout: 8000 })
	})
})

test.describe('search', () => {
	test('the list narrows to the query in the box', async ({ page }) => {
		await loaded(page)
		await page.getByTestId('search').fill('ams')
		await quiet(page)

		await expect(page.getByTestId('showing-query')).toHaveText('results for “ams”')
		await expect(page.getByTestId('hit')).toHaveCount(1)
		await expect(page.getByTestId('hit')).toContainText('Amsterdam')
	})

	test('the previous results stay on screen while a new query is in flight', async ({ page }) => {
		await loaded(page)
		await page.getByTestId('search').fill('ber')

		await expect(page.getByTestId('searching')).toBeVisible()
		await expect(page.getByTestId('hits')).toHaveClass(/stale/)
		// Held, not blanked: still the previous 50 rows.
		await expect(page.getByTestId('hit')).toHaveCount(50)

		await quiet(page)
		await expect(page.getByTestId('hit')).toHaveCount(1)
		await expect(page.getByTestId('hits')).not.toHaveClass(/stale/)
	})

	test('the empty state does not appear while a query is in flight', async ({ page }) => {
		await loaded(page)
		await page.getByTestId('search').fill('zzzz')

		// Pending is not emptiness. `For` coerces a pending list to zero rows,
		// so an empty-state keyed on row count alone would flash here.
		await expect(page.getByTestId('searching')).toBeVisible()
		await expect(page.getByTestId('empty')).toHaveCount(0)

		await quiet(page)
		await expect(page.getByTestId('empty')).toBeVisible()
		await expect(page.getByTestId('empty')).toHaveText('no city matches “zzzz”')
	})
})

test.describe('supersession', () => {
	test('an answer that arrives after a newer one does not reach the list', async ({ page }) => {
		await loaded(page)
		await page.getByTestId('clear-log').click()
		await startRecording(page, ['showing-query'])

		// One request per keystroke, each issued while its predecessor is still
		// in flight, each answered faster than its predecessor.
		await page.getByTestId('search').pressSequentially('amste', { delay: 60 })
		await quiet(page)

		const log = await readLog(page)

		// The race is the premise of this test, so assert it happened rather
		// than assuming it: the first request must have come back last.
		const first = rowFor(log, 'search', 'a')
		const last = rowFor(log, 'search', 'amste')
		expect(first.settledAt).not.toBeNull()
		expect(last.settledAt).not.toBeNull()
		expect(first.settledAt!).toBeGreaterThan(last.settledAt!)
		expect(first.supersededBy).not.toBeNull()

		// Where it came to rest.
		await expect(page.getByTestId('showing-query')).toHaveText('results for “amste”')
		await expect(page.getByTestId('result-count')).toHaveText('1')
		await expect(page.getByTestId('list-torn')).toHaveCount(0)

		// What reached the screen along the way. Every intermediate query was
		// superseded long before its answer came back, so none of them should
		// ever have been displayed.
		expect(await recorded(page)).toEqual(['every city', 'results for “amste”'])
	})

	test('a late detail answer does not replace the record that was clicked after it', async ({
		page,
	}) => {
		await loaded(page)
		await page.getByTestId('clear-log').click()
		await startRecording(page, ['detail-name'])

		// Rome is answered in 680ms, San Francisco in 150ms, so the second
		// click is answered first and the first click's answer lands late.
		await page.getByTestId('hit').filter({ hasText: 'Rome' }).click()
		await page.getByTestId('hit').filter({ hasText: 'San Francisco' }).click()
		await quiet(page)

		const log = await readLog(page)
		const rome = rowFor(log, 'detail', 'Rome')
		const sanFrancisco = rowFor(log, 'detail', 'San Francisco')
		expect(rome.settledAt!).toBeGreaterThan(sanFrancisco.settledAt!)
		expect(rome.supersededBy).toBe(sanFrancisco.id)

		await expect(page.getByTestId('detail-name')).toHaveText('San Francisco')
		await expect(page.getByTestId('detail-country')).toHaveText('United States')
		await expect(page.getByTestId('detail-torn')).toHaveCount(0)

		expect(await recorded(page)).not.toContain('Rome')
	})
})

test.describe('atomic commit', () => {
	test('the fields never show two cities at once', async ({ page }) => {
		await loaded(page)
		await expect(page.getByTestId('detail-name')).toHaveText('Amsterdam')
		await startRecording(page, ['detail-name', 'detail-country'])

		await page.getByTestId('hit').filter({ hasText: 'Berlin' }).click()
		await quiet(page)
		await expect(page.getByTestId('detail-name')).toHaveText('Berlin')

		// Every state the pair was ever seen in belongs to one city, never a mix
		// of both.
		//
		// This does not measure the boundary. Every field reads the same record,
		// so all of them are invalidated together and recompute in one
		// propagation: the assertion below passes unchanged with the boundary
		// replaced by a fragment. Showing that a gate is load-bearing needs
		// fields that read two sources which resolve at different times, and
		// this example has no such pair.
		expect(await recorded(page)).toEqual(['Amsterdam | Netherlands', 'Berlin | Germany'])
	})
})
