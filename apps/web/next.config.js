const { execSync } = require('node:child_process');

/**
 * Stamp the build into the bundle.
 *
 * The APK bundles its web assets at build time and never auto-updates, so
 * "am I running the new build?" is otherwise unanswerable on a phone. The
 * Device screen shows this.
 */
function buildStamp() {
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    const dirty = execSync('git status --porcelain').toString().trim().length > 0;
    return `${sha}${dirty ? '+dirty' : ''}`;
  } catch {
    return 'unknown';
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Capacitor needs a folder of plain static files to wrap into the APK.
  // Setting this on day one is deliberate: it makes any accidental server
  // component or API route fail the build now, not on demo day.
  output: 'export',
  images: { unoptimized: true },
  // nav-core and sensor-sources ship as TypeScript source, so Next compiles
  // them itself. No separate build step, no stale dist/ to debug.
  transpilePackages: ['@pathpulse/nav-core', '@pathpulse/sensor-sources'],
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_BUILD_ID: buildStamp(),
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
    // ★ ONE PLACE, BECAUSE THE LAST ONE WENT STALE ★ The Device screen read a
    // hardcoded "phase 4" for fourteen phases. That screen exists to answer
    // "am I running the new build?", so a wrong answer there is worse than no
    // answer: it is the one label a judge would take at face value.
    NEXT_PUBLIC_PHASE: '18 — two-wheeler, edge engine, particle filter',
  },
  webpack: (config) => {
    // nav-core uses explicit .js specifiers because that is what real ESM
    // requires — Node will need them verbatim for the Part B edge engine.
    // Webpack has to be told those map onto .ts sources.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

module.exports = nextConfig;
