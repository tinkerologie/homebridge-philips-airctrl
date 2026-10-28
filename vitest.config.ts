import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 93.64,
        branches: 88.31,
        functions: 95.81,
        lines: 96.41,
      },
    },
  },
})
