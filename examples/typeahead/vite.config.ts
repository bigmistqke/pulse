import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { pulseJsx } from '../../src/vite-jsx-plugin'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [pulseJsx()],
  resolve: {
    alias: {
      'pulse/jsx-runtime': resolve(here, '../../src/jsx-runtime.ts'),
      'pulse/jsx-dev-runtime': resolve(here, '../../src/jsx-runtime.ts'),
      'pulse': resolve(here, '../../src/index.ts'),
    },
  },
})
