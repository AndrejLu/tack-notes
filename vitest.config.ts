import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  }
})
