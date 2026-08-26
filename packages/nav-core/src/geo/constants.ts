/** WGS84 reference ellipsoid. */
export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B = WGS84_A * (1 - WGS84_F);
/** First eccentricity squared. */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** Second eccentricity squared, used by Bowring's inverse. */
export const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

/** IUGG mean radius, used for haversine only. */
export const EARTH_MEAN_RADIUS_M = 6371008.8;

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
