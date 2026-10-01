import { expect, test } from 'vitest'
import { pulseJsx } from '../src/vite-jsx-plugin'

type Transform = (code: string, id: string) => Promise<{ code: string } | null>
const transform = pulseJsx().transform as unknown as Transform

/**
 * @canon spec-the-vite-plugin-compiles-only-jsx-files
 */
test('a file that is not .tsx or .jsx is left alone', async () => {
  expect(await transform('export const a = 1', '/src/a.ts')).toBeNull()
})

/**
 * @canon spec-the-getter-transform-runs-before-the-jsx-transform
 */
test('a .tsx file is compiled through the pulse JSX runtime, with dynamic props as getters', async () => {
  const result = await transform('const el = <div class={name()} />', '/src/a.tsx')
  expect(result?.code).toContain('pulse/jsx-runtime')
  expect(result?.code).toMatch(/get\s+class\s*\(\)/)
})

/**
 * @canon spec-the-vite-plugin-compiles-only-jsx-files
 */
test('a query string on the id does not stop a .jsx file being compiled', async () => {
  const result = await transform('const el = <div />', '/src/a.jsx?v=123')
  expect(result?.code).toContain('pulse/jsx-runtime')
})
