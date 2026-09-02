import type { Config } from 'tailwindcss';
import { MODE_COLORS } from './config/modes';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Imported, not duplicated — config/modes.ts is the single source of
        // truth for mode colour, shared with the marker and trail.
        mode: {
          init: MODE_COLORS.INITIALIZING,
          gnss: MODE_COLORS.GNSS,
          degraded: MODE_COLORS.GNSS_DEGRADED,
          dr: MODE_COLORS.DEAD_RECKONING,
          recovering: MODE_COLORS.RECOVERING,
          error: MODE_COLORS.ERROR,
        },
      },
      fontFamily: {
        // next/font sets these variables in layout.tsx; the stacks after them
        // are what renders if the webfont is unavailable — which matters,
        // because the APK runs with every radio off.
        sans: ['var(--font-sans)', 'system-ui', '-apple-system', 'sans-serif'],
        mono: [
          'var(--font-mono)',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};

export default config;
