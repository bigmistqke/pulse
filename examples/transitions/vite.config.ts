import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'pulse/jsx-runtime': resolve(here, '../../src/jsx-runtime.ts'),
      'pulse/jsx-dev-runtime': resolve(here, '../../src/jsx-runtime.ts'),
      'pulse': resolve(here, '../../src/index.ts'),
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'pulse',
  },
})
