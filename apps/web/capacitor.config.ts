import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'in.avinya.pathpulse',
  appName: 'PathPulse',
  // Next.js `output: 'export'` writes here. Set on day one precisely so a
  // stray server component fails the web build long before it fails the APK.
  webDir: 'out',
  android: {
    allowMixedContent: true,
  },
  server: {
    // A https:// scheme makes the WebView a secure context, so the browser
    // geolocation and DeviceMotion APIs are available inside the APK without
    // the http:// restriction that blocks them over a LAN.
    androidScheme: 'https',
  },
  plugins: {
    Geolocation: {
      // Matches the web hook: never serve a cached fix, we want the real
      // update cadence on the HUD.
      enableHighAccuracy: true,
    },
  },
};

export default config;
