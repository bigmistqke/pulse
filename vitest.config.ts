import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))
const aliases = {
  r3: resolve(here, '../r3/src/index.ts'),
  'pulse/jsx-runtime': resolve(here, 'src/jsx-runtime.ts'),
  'pulse/jsx-dev-runtime': resolve(here, 'src/jsx-runtime.ts'),
  pulse: resolve(here, 'src/index.ts'),
}

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        extends: true,
        resolve: { alias: aliases },
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/dom/**'],
        },
      },
      {
        extends: true,
        resolve: { alias: aliases },
        test: {
          name: 'dom',
          include: ['test/dom/**/*.test.{ts,tsx}'],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
