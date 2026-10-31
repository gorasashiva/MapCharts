import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

// Library build: ES + CJS bundles with bundled .d.ts. React is externalized —
// it's only used (type-only) by the drawing-tool icon exports, so consumers who
// don't touch those never need React.
export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
      name: 'CandLCharts',
      formats: ['es', 'cjs'],
      fileName: (format) => `candl-charts.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    },
    sourcemap: true,
  },
  plugins: [dts({ insertTypesEntry: true })],
})
