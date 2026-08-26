import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SimulationSource physics is pure TypeScript — no DOM needed.
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
