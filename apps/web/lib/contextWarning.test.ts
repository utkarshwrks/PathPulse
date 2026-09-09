import { describe, expect, it } from 'vitest';
import { contextWarning } from './contextWarning';

/**
 * ★ THE FAILURE SIGNATURE, NAMED ★
 *
 * `DEAD RECKONING [ON FOOT] 0 km/h [STEPS]` on a rigidly mounted phone froze
 * the estimate for forty seconds. The cause is fixed; this line exists so that
 * if it ever returns it is visible in the vehicle rather than in a log.
 */
describe('contextWarning', () => {
  it('★ warns when a dead-reckoning estimate is taking speed from steps', () => {
    expect(contextWarning('DEAD_RECKONING', 'PEDESTRIAN', 'STEPS')).toContain('no cadence');
  });

  it('says nothing while GNSS is healthy, whatever the context', () => {
    expect(contextWarning('GNSS', 'PEDESTRIAN', 'STEPS')).toBeNull();
    expect(contextWarning('RECOVERING', 'PEDESTRIAN', 'STEPS')).toBeNull();
  });

  it('says nothing about an ordinary vehicle outage', () => {
    expect(contextWarning('DEAD_RECKONING', 'VEHICLE', 'ML')).toBeNull();
    expect(contextWarning('DEAD_RECKONING', 'VEHICLE', 'INTEGRATED')).toBeNull();
  });

  it('does not cry wolf at a red light', () => {
    expect(contextWarning('DEAD_RECKONING', 'STATIONARY', 'STOPPED')).toBeNull();
  });
});
