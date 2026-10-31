import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts, which is the library's production build
// config (build.lib, rollupOptions.external) — test config has no business
// there, and this way `vitest` never touches the build pipeline.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
