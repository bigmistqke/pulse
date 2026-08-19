import { transformAsync } from '@babel/core'
import type { Plugin } from 'vite'
import pulsePropsToGetters from '../../src/babel-plugin'

export function pulseJsx(): Plugin {
  return {
    name: 'pulse-jsx',
    enforce: 'pre',
    async transform(code, id) {
      if (!id.endsWith('.tsx') && !id.endsWith('.jsx')) return null
      const result = await transformAsync(code, {
        filename: id,
        presets: [['@babel/preset-typescript', {}]],
        plugins: [
          '@babel/plugin-syntax-jsx',
          pulsePropsToGetters,
          [
            '@babel/plugin-transform-react-jsx',
            { runtime: 'automatic', importSource: 'pulse', throwIfNamespace: false },
          ],
        ],
        babelrc: false,
        configFile: false,
        sourceMaps: true,
      })
      if (!result?.code) return null
      return { code: result.code, map: result.map }
    },
  }
}
