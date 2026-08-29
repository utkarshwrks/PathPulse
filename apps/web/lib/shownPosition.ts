import type { NavigationState, SensorSample } from '@pathpulse/nav-core';

export interface ShownPosition {
  lat: number;
  lon: number;
  /** True once the engine is navigating; false while this is a raw fix. */
  fromEngine: boolean;
  /** Metres. Engine uncertainty when navigating, GNSS accuracy before that. */
  accuracyM: number;
}

/**
 * Where to put the marker and point the camera.
 *
 * ★ "WE KNOW WHERE YOU ARE" IS NOT "THE ENGINE TRUSTS THIS ENOUGH TO NAVIGATE" ★
 *
 * Both were once gated on the engine having left INITIALIZING, which needs two
 * consecutive fixes at 20 m or better. On a handset delivering a fix every 5 to
 * 20 seconds that is the best part of a minute, and if accuracy sits above 20 m
 * it never happens at all. Until then the map held its default centre — Delhi —
 * with no marker and no camera move, so tapping Live looked exactly like an app
 * that could not find you. It had your position the whole time. It just refused
 * to admit it, because it was answering a different question.
 *
 * A 60 m fix is useless for dead reckoning and still tells you which city you
 * are in. So show the best position available and be honest about its quality
 * rather than hiding it: the caller renders a raw fix under the grey ACQUIRING
 * mode, which is what tells the user this is not a navigation solution yet.
 *
 * Returns null only when there is genuinely nothing — no engine position and no
 * fix has ever arrived.
 */
export function resolveShownPosition(
  navState: NavigationState | null,
  lastFix: NonNullable<SensorSample['gnss']> | undefined,
): ShownPosition | null {
  const engineReady =
    navState !== null &&
    navState.mode !== 'INITIALIZING' &&
    Number.isFinite(navState.position.lat) &&
    Number.isFinite(navState.position.lon) &&
    !(navState.position.lat === 0 && navState.position.lon === 0);

  if (engineReady) {
    return {
      lat: navState!.position.lat,
      lon: navState!.position.lon,
      fromEngine: true,
      accuracyM: navState!.covariance.alongM,
    };
  }

  if (
    lastFix &&
    Number.isFinite(lastFix.lat) &&
    Number.isFinite(lastFix.lon) &&
    !(lastFix.lat === 0 && lastFix.lon === 0)
  ) {
    return {
      lat: lastFix.lat,
      lon: lastFix.lon,
      fromEngine: false,
      accuracyM: Number.isFinite(lastFix.accuracyM) ? lastFix.accuracyM : 0,
    };
  }

  return null;
}

/**
 * Whether to jump the camera rather than glide it.
 *
 * Easing 800 km from the default centre to the first real fix spends several
 * seconds flying across India, which reads as a hang. Once we are near the
 * vehicle, ease — a marker that jumps every frame looks like a bug (Golden
 * Rule #6), and the same applies to the map under it.
 */
export function shouldJumpCamera(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  thresholdDeg = 0.5,
): boolean {
  return (
    Math.abs(from.lat - to.lat) > thresholdDeg || Math.abs(from.lon - to.lon) > thresholdDeg
  );
}
