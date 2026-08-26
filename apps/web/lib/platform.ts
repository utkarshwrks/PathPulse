/**
 * Runtime platform detection.
 *
 * The web build and the APK ship the same bundle, so which SensorSource to use
 * is a runtime question, not a build-time one.
 */
export interface PlatformInfo {
  isNative: boolean;
  platform: string;
  model?: string;
  osVersion?: string;
  manufacturer?: string;
  webViewVersion?: string;
  isSecureContext: boolean;
}

export async function detectPlatform(): Promise<PlatformInfo> {
  const isSecureContext =
    typeof window !== 'undefined' ? window.isSecureContext !== false : false;

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) {
      return { isNative: false, platform: 'web', isSecureContext };
    }
    const { Device } = await import('@capacitor/device');
    const info = await Device.getInfo();
    return {
      isNative: true,
      platform: info.platform,
      model: info.model,
      osVersion: info.osVersion,
      manufacturer: info.manufacturer,
      webViewVersion: info.webViewVersion,
      isSecureContext,
    };
  } catch {
    // Not running under Capacitor at all.
    return { isNative: false, platform: 'web', isSecureContext };
  }
}
