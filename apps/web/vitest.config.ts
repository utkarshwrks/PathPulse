import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    // The hooks under test drive navigator.geolocation, so they need a DOM.
    environment: 'jsdom',
    globals: false,
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**', 'out/**', 'android/**'],
    coverage: {
      /**
       * ★ COVERAGE MUST COUNT SOURCE, NOT BUILD OUTPUT ★
       * Without this the report walked `out/`, `.next/` and the Capacitor
       * assets copied into `android/`, and counted Cordova's 1034-line
       * `native-bridge.js` as untested application code. That reported 48%
       * for a package whose components are all above 90 — a number too low to
       * act on and, worse, one that moves when you rebuild rather than when
       * you change a test. This project runs coverage-driven test passes, so a
       * polluted denominator is not cosmetic.
       */
      include: ['app/**', 'components/**', 'config/**', 'hooks/**', 'lib/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx'],
    },
  },
});
