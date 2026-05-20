import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig(({ mode }) => ({
  plugins: [solid({ dev: mode === 'development' })],
  server: { port: 5183 },
}))
