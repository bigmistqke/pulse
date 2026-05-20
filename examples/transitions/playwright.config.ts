import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  // Serial execution: the transition scenarios are timing-sensitive — tests
  // drive latency sliders and poll the DOM during in-flight transitions, so
  // parallel workers cause cross-test interference and flakiness.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5182',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite --port 5182',
    url: 'http://localhost:5182',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
