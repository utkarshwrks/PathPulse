import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // nav-core is pure math: no DOM, no jsdom, no globals needed.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
