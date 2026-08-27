export const GRAVITY_MPS2 = 9.80665;

/**
 * ★ ATTITUDE ACCURACY IS POSITION ACCURACY ★
 *
 * An accelerometer measures specific force — gravity plus motion, mixed. To
 * get motion alone you must know exactly which way is down, and any error in
 * that estimate leaks gravity straight into the motion signal.
 *
 * Work the numbers: a 1 degree attitude error tilts the gravity vector enough
 * to inject sin(1 deg) x 9.81 = 0.171 m/s^2 of false acceleration. Position
 * error from a constant acceleration is 0.5 x a x t^2, so after 60 seconds
 * that is 0.5 x 0.171 x 3600 = ~308 metres.
 *
 * One degree. Five minutes of tunnel. Three hundred metres of error, from an
 * error you cannot see on any screen. This single fact drives more design
 * decisions in this project than any other, which is why it lives here next to
 * the constant rather than buried in a commit message.
 *
 * ---
 *
 * This file used to also export a `GravityRemover` that isolated gravity with a
 * low-pass filter. It was removed rather than left to rot: a low-pass slow
 * enough to reject vibration still tracks a five-second vehicle acceleration,
 * so subtracting it cancelled the very signal being integrated — speed never
 * rebuilt after a stop. `AttitudeEstimator` replaced it with a complementary
 * filter and nothing referenced the class any more. Dead code that still looks
 * plausible is worse than no code, because the next person assumes it is the
 * path in use.
 */
