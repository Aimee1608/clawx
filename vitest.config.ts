import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Tests must not touch the operator's real ~/.config/clawx or network.
    // Each suite that reads env/fs stubs or isolates via tmp dirs.
  },
})
