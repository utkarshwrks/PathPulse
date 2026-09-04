"""
Single source of truth for every constant the Phase 8 pipeline shares.

Kept in one place because the window length, the sample rate and the channel
order have to agree across preprocessing, training, the position evaluation,
the ONNX export and the TypeScript that runs the model on a phone. They
disagreed once and the model silently predicted nonsense.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
RESULTS = ROOT / "results"
EXPORT = ROOT / "export"

# ── Rate ─────────────────────────────────────────────────────────────────────
# ★ THE DATASET IS 10 Hz, NOT 50 Hz. ★
#
# The build guide says "resample to 50 Hz (if the dataset is at a different
# rate)". IO-VNBD's smartphone log is 10 Hz — a 100 ms sample period, verified
# from the median delta of TIME SINCE START. Upsampling it to 50 Hz would give
# the guide's 100-sample window, but 80 of those 100 samples would be
# interpolation: no information above 5 Hz exists in the recording, so the
# vibration features the guide hopes to capture are not there to capture.
#
# We train at the dataset's native rate and decimate the phone's stream to
# match at inference. The window is still 2 seconds, which is what actually
# matters. This also happens to be the rate the engine emits at.
SAMPLE_RATE_HZ = 10
WINDOW_SECONDS = 2.0
WINDOW_SAMPLES = int(SAMPLE_RATE_HZ * WINDOW_SECONDS)  # 20
WINDOW_STRIDE = WINDOW_SAMPLES // 2                    # 50 % overlap

# ── Channels ─────────────────────────────────────────────────────────────────
# Order is a contract. It matches SensorSample.imu in packages/nav-core:
# specific force in m/s^2 (gravity included), angular rate in rad/s.
CHANNELS = ["ax", "ay", "az", "gx", "gy", "gz"]
N_CHANNELS = len(CHANNELS)

# ── Split ────────────────────────────────────────────────────────────────────
# SEQUENCE-WISE, never random. Windows overlap by 50 %, so a random split would
# put near-duplicate windows in train and test and report a score that is
# mostly memorisation. Test holds a different route category AND a different
# driver, which is the only honest way to claim generalisation.
#
# Vtb03 is here on purpose: 13.7 minutes of stop-go traffic, 38 % of it
# stationary. Without it the training set is 96 % moving and the model never
# learns what a stopped vehicle looks like — which is the one case a navigation
# system must not get wrong, because a phantom 5 m/s at a red light integrates
# into a hundred metres of imaginary travel.
#
# ★ Vw01 was in this list and was removed. It is 34 minutes of a car IDLING:
#   engine at 880 rpm, wheel speed exactly zero for every one of its 20475
#   rows. It is not corrupt, it is just useless for regression, and at 24 % of
#   the training set it would have taught the model to answer "zero". See the
#   degenerate-sequence guard in preprocess.py.
TRAIN_SEQUENCES = [
    # Driver A, smartphone-heavy long runs
    "S2", "S3a", "S3c", "S4",
    # Driver E, motorway (Vf) / trunk (Vta) / B-road (Vtb) / urban (Vw)
    "V-Vfa01", "V-Vfa02",
    "Vta01a", "Vta01b", "Vta02", "Vta03", "Vta05", "Vta06", "Vta07",
    "Vta10", "Vta11", "Vta12", "Vta13",
    "Vtb01", "Vtb03",
]
# Validation needs to be big and varied enough to steer early stopping. At
# three short sequences it was 1427 windows and its MAE moved in the opposite
# direction to the test set's, which makes it a coin toss rather than a signal.
VAL_SEQUENCES = ["Vta04", "Vta08", "Vtb02", "S3b", "Vw03"]
TEST_SEQUENCES = ["Vw02", "S1"]

# What the split does and does not prove: the test SEQUENCES are held out, so
# no window and no route from them is ever trained on. Other sessions by the
# same two drivers are in train, so this measures generalisation to a new
# journey, not to a new vehicle or a new phone. Claiming the latter would need
# a driver-disjoint split, and the dataset has only two drivers with enough
# data to make one.

SEED = 1337
MAX_SPEED_MPS = 40.0  # same plausibility ceiling the engine uses


# ── Phase 13, Model 2: the motion-state classifier ───────────────────────────
#
# The problem statement asks for AI in three places. Phase 8 built the first
# (speed). This is the second: "dynamically detect and filter out
# non-navigation motions such as engine idling vibrations, pothole shocks,
# bumps" — a classification problem stated in prose.

# One second, not two. A motion STATE changes in a few hundred milliseconds; a
# two-second window would report what the vehicle was doing a second ago. Speed
# gets two seconds because speed changes slowly.
MOTION_WINDOW_SECONDS = 1.0
MOTION_WINDOW_SAMPLES = int(SAMPLE_RATE_HZ * MOTION_WINDOW_SECONDS)  # 10
MOTION_WINDOW_STRIDE = MOTION_WINDOW_SAMPLES // 2                    # 50 % overlap

# ★ THIS ORDER IS A CONTRACT ★
# It must match MOTION_STATES in packages/nav-core/src/ml/motionModel.ts
# exactly. Reordering it silently relabels every prediction: the model would
# still score 90 % and every answer it gave the engine would be wrong. The
# export writes the names into the weights file and nav-core checks them.
MOTION_STATES = [
    "STATIONARY",
    "IDLING",
    "STRAIGHT",
    "TURNING_LEFT",
    "TURNING_RIGHT",
    "ACCELERATING",
    "BRAKING",
    "POTHOLE_EVENT",
]

# ── Label thresholds ─────────────────────────────────────────────────────────
#
# ★ WHERE EACH LABEL COMES FROM, AND HOW FAR TO TRUST IT ★
#
# Six of the eight classes are labelled from the CAR'S OWN CAN BUS — wheel
# speed and yaw rate — which is real supervision from an instrument that keeps
# working in the tunnels where GPS does not. Those labels are as good as the
# vehicle's own sensors.
#
# Two are self-labelled from the phone's IMU, and are weaker claims:
#
#   STATIONARY vs IDLING  the CAN bus says only "stopped". The engine running
#                         or not is read from vibration energy, so this split
#                         is a heuristic about the phone, not a measurement of
#                         the car.
#   POTHOLE_EVENT         the dataset has no pothole annotation. It is an
#                         impulse detector on |a|, which is rotation-invariant
#                         and therefore survives the mounting augmentation.
#
# What the model adds over the rules is not accuracy against these labels — it
# cannot exceed its teacher — it is that a network reading the whole window
# generalises where a threshold on one statistic does not. Said plainly rather
# than implied, because "our AI detects potholes" is a claim a judge is
# entitled to ask the provenance of.

MOTION_STOP_SPEED_MPS = 0.5      # below this the wheels are not turning
MOTION_IDLE_ENERGY_MPS2 = 0.06   # std of |a| over the window; above = engine on
MOTION_TURN_RATE_RADS = 0.15     # ~8.6 deg/s, a deliberate turn not a lane drift
MOTION_ACCEL_MPS2 = 0.7          # sustained longitudinal change worth naming
MOTION_POTHOLE_MPS2 = 3.5        # impulse above the local mean of |a|

# ── The rigid-mount screen ───────────────────────────────────────────────────
#
# ★ MOST OF IO-VNBD'S PHONES WERE NOT BOLTED DOWN ★
#
# The phone and vehicle files are time-synchronised: GPS speed against CAN
# speed correlates above 0.9 for almost every sequence. But the phone's
# GYROSCOPE only tracks the car's yaw rate in a few of them — 0.93 to 0.95 for
# two sequences, under 0.3 for most. In the rest the handset was loose on a
# seat or in a bag, measuring its own motion rather than the vehicle's.
#
# That is survivable for a SPEED model, because a moving car shakes its whole
# cabin and the vibration energy still carries the speed. It is fatal for a
# model whose classes are TURNING_LEFT and TURNING_RIGHT.
#
# So sequences are screened on that correlation and the ones that fail are
# dropped, loudly. It costs most of the dataset and buys labels that mean what
# they say.
MOTION_RIGID_MIN_CORR = 0.5


# ── Phase 13, Model 4: the GNSS quality classifier ───────────────────────────
#
# ★ THIS ORDER IS A CONTRACT ★
# It must match GNSS_QUALITY_CLASSES in
# packages/nav-core/src/ml/gnssQualityModel.ts. A reordered list still runs,
# still looks confident, and calls a good fix spoofed.
GNSS_QUALITY_CLASSES = ["GOOD", "MULTIPATH", "SPOOFED", "LOST"]
