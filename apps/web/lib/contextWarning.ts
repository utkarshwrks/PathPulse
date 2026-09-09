import type { MotionContext, NavMode, SpeedSource } from '@pathpulse/nav-core';

/**
 * The one HUD line that names a known failure signature.
 *
 * ★ WHY THIS STATE AND NOT ANY OTHER ★
 *
 * A rigidly mounted handset on a vehicle has no step cadence to measure. If
 * the engine has nonetheless decided the carrier is on foot, the pedestrian
 * speed path resolves to zero and the estimate stops advancing — the field
 * failure exactly: `DEAD RECKONING [ON FOOT] 0 km/h [STEPS]`, and 704 m of
 * distance becoming 708 m across forty seconds while the vehicle covered
 * 174 m.
 *
 * The cause is fixed — see `MotionContextDetector.vehicleMemoryMs` and the
 * outage latch — and the reason this line exists anyway is that a fix nobody
 * can see fail is a fix nobody can trust. If it ever comes back, it says so on
 * the screen, in the vehicle, without a laptop.
 *
 * Deliberately narrow. PEDESTRIAN while dead reckoning is not itself wrong —
 * somebody walking through a tunnel is exactly that. What is wrong is the
 * SPEED SOURCE that follows from it, so that is what this keys on.
 */
export function contextWarning(
  mode: NavMode | null,
  context: MotionContext,
  speedSource: SpeedSource | undefined,
): string | null {
  if (mode !== 'DEAD_RECKONING') return null;
  if (speedSource === 'STEPS') {
    return 'on-foot speed while dead reckoning — a mounted phone has no cadence';
  }
  if (context === 'STATIONARY' && speedSource === 'STOPPED') {
    // Legitimate at a red light, and the signature of a stuck classifier when
    // it persists. The words say which question to ask rather than asserting
    // an answer.
    return null;
  }
  return null;
}
