import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Mode colours, shared by the badge, marker and trail so they can
        // never drift apart. Phase 1 wires them to the map.
        mode: {
          gnss: '#22c55e',
          degraded: '#eab308',
          dr: '#f97316',
          recovering: '#3b82f6',
          error: '#ef4444',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
