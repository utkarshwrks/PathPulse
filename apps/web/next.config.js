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
