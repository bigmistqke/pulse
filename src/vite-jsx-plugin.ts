import { transformAsync } from '@babel/core'
import type { Plugin } from 'vite'
import pulsePropsToGetters from './babel-plugin'

export function pulseJsx(): Plugin {
  return {
    name: 'pulse-jsx',
    enforce: 'pre',
    async transform(code, id) {
      const filename = id.split('?')[0]
      if (!filename.endsWith('.tsx') && !filename.endsWith('.jsx')) return null
      const result = await transformAsync(code, {
        filename,
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
      // Babel's EncodedSourceMap types `file` as `string | null | undefined`; Rollup's
      // SourceMapInput wants `string | undefined`. Both are the same JSON shape at
      // runtime - this is a type-only mismatch between the two ecosystems' definitions.
      return { code: result.code, map: result.map as any }
    },
  }
}
