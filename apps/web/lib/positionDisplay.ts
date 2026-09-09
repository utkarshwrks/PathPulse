/**
 * How honestly to draw the marker, given what the estimator says it knows.
 *
 * ★ THE ESTIMATOR WAS BEING HONEST AND THE RENDERER WAS NOT ★
 *
 * Field ride, at the end of a 52 s outage, the HUD read:
 *
 *     uncert. 88/5 m        drift est 87.9 m
 *
 * The filter knew it had 88 metres of along-track uncertainty. It said so, in
 * a number, on the screen. And two hundred pixels away the map drew a crisp
 * arrow at a point, which is a claim to metre-level knowledge. That gap is the
 * whole of what the rider means by "misleading": nothing was wrong with the
 * estimate, and everything was wrong with the picture of it.
 *
 * A system that says "I do not know" is recoverable — the rider slows down,
 * looks up, waits for a fix. One that says "you are here" and is wrong is not,
 * because there is nothing to react to until the error is already a wrong turn.
 *
 * ★ ALONG-TRACK, BECAUSE THAT IS THE AXIS THAT GROWS ★
 *
 * Road snapping bounds cross-track error — it is the one thing the map can
 * assert — while along-track error grows without limit, which is why the
 * covariance is carried as an ellipse and not a radius. 88/5 is not a blob
 * 88 m across; it is a smear 176 m long and 10 m wide, lying along the road.
 * Drawing a circle would overstate the cross-track error as badly as the point
 * marker understates the along-track one.
 *
 * Presentation only. Nothing here touches the estimator, and the thresholds are
 * about what a person can act on, not about the filter.
 */

export type PositionDisplayKind = 'POINT' | 'POINT_AND_BAND' | 'BAND';

export interface PositionDisplay {
  kind: PositionDisplayKind;
  /** Draw the arrow at all. */
  showMarker: boolean;
  /** Draw the along-road smear. */
  showBand: boolean;
  /**
   * Full length of the band, metres — 2 sigma of along-track uncertainty, so
   * the smear covers roughly 95 % of where the vehicle might actually be.
   */
  bandLengthM: number;
  /**
   * A line for the HUD when the marker alone would be a lie, else null.
   * Pre-formatted here so the renderer cannot word it differently.
   */
  notice: string | null;
}

export interface PositionDisplayThresholds {
  /**
   * Below this the point marker is the honest picture, metres.
   *
   * 25 m is about the width of a junction. Inside it the marker is on the
   * right road, at the right junction, and a band would be visual noise
   * claiming a doubt that does not change anything a rider would do.
   */
  pointMaxM: number;
  /**
   * Above this the point marker is dropped entirely, metres.
   *
   * 60 m is more than a city block. Drawing a definite arrow somewhere inside
   * a 120 m smear picks one point out of it and asserts it, and the one thing
   * we know at that range is that we cannot. The band alone is the truthful
   * shape, and it has to be accompanied by words, because a band with no
   * marker looks like a rendering glitch rather than a statement.
   */
  bandOnlyM: number;
}

export const DEFAULT_POSITION_DISPLAY_THRESHOLDS: PositionDisplayThresholds = {
  pointMaxM: 25,
  bandOnlyM: 60,
};

/**
 * @param alongM  semi-major (along-track) 1-sigma uncertainty, metres
 * @param crossM  semi-minor (cross-track) 1-sigma uncertainty, metres
 */
export function positionDisplay(
  alongM: number,
  crossM: number,
  thresholds: PositionDisplayThresholds = DEFAULT_POSITION_DISPLAY_THRESHOLDS,
): PositionDisplay {
  // The semi-major axis is the one that decides, and a covariance that has not
  // been populated yet must not be read as certainty. NaN is "we do not know
  // what we do not know", which is not a licence to draw a confident point —
  // but it is also not evidence of a large error, and every session starts
  // there. Treat it as zero and let the first real number speak.
  const along = Number.isFinite(alongM) ? Math.max(0, alongM) : 0;
  const cross = Number.isFinite(crossM) ? Math.max(0, crossM) : 0;
  const semiMajor = Math.max(along, cross);

  if (semiMajor <= thresholds.pointMaxM) {
    return {
      kind: 'POINT',
      showMarker: true,
      showBand: false,
      bandLengthM: 0,
      notice: null,
    };
  }

  const bandLengthM = 2 * semiMajor;

  if (semiMajor <= thresholds.bandOnlyM) {
    return {
      kind: 'POINT_AND_BAND',
      showMarker: true,
      showBand: true,
      bandLengthM,
      notice: null,
    };
  }

  return {
    kind: 'BAND',
    showMarker: false,
    showBand: true,
    bandLengthM,
    // Rounded to 5 m: the figure is an estimate of an estimate, and printing
    // "±87 m" claims a precision about our own ignorance that we do not have.
    notice: `position uncertain — ±${(Math.round(semiMajor / 5) * 5).toFixed(0)} m along road`,
  };
}
