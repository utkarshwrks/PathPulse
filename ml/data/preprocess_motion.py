"""
IO-VNBD -> labelled motion-state windows (Phase 13, Model 2).

Input : the phone's IMU, resolved into the VEHICLE's frame, 6 channels at 10 Hz.
Label : one of eight motion states, read off the car's own CAN bus.

    python ml/data/preprocess_motion.py

★ TWO THINGS THIS FILE LEARNED THE HARD WAY ★

1. THE INPUT MUST BE IN THE VEHICLE'S FRAME.
   The first version fed raw device axes and reused Phase 8's augmentation,
   which applies a uniformly random yaw. Three classes then scored an F1 of
   exactly 0.000. That is not a tuning failure: accelerating and braking are
   the same axis with opposite signs, left and right likewise, so a model told
   the phone's heading is random is being told the sign carries no
   information. Speed is a magnitude and does not care; a motion state does.
   See `to_vehicle_frame`.

2. MOST OF THIS DATASET'S PHONES WERE NOT RIGIDLY MOUNTED.
   The phone and vehicle files ARE time-synchronised — GPS speed against CAN
   speed correlates above 0.9 for almost every sequence. But the phone's
   gyroscope only tracks the car's yaw rate in a few of them. In the rest the
   handset was loose on a seat or in a bag and was measuring its own motion.
   Training a vehicle-motion classifier on those is training it on noise.
   See `rigid_mount_score`, which measures it and drops what fails.
"""

from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import (  # noqa: E402
    MOTION_ACCEL_MPS2,
    MOTION_POTHOLE_MPS2,
    MOTION_RIGID_MIN_CORR,
    MOTION_STATES,
    MOTION_STOP_SPEED_MPS,
    MOTION_TURN_RATE_RADS,
    MOTION_WINDOW_SAMPLES,
    MOTION_WINDOW_STRIDE,
    N_RAW_CHANNELS,
    PROCESSED,
    RAW,
    SEED,
)

GRAVITY = 9.80665
IDX = {name: i for i, name in enumerate(MOTION_STATES)}

# Phone columns, verified against the headers in the CSVs themselves.
PHONE_T = 7
PHONE_ACC = (9, 10, 11)
PHONE_GYR = (15, 16, 17)

# ★ THE GYROSCOPE COLUMNS ARE NOT IN THE ACCELEROMETER'S AXIS ORDER ★
#
# The CSV header calls them "GYROSCOPE Yaw / Pitch / Roll". Taken at face value
# — and Phase 8 does take them at face value, harmlessly, because a speed model
# reads all three channels and does not care which is which — a flat phone's
# vehicle yaw would be the "Yaw" column.
#
# It is not. Measured against the car's own CAN yaw rate, on the two sequences
# where the phone is rigidly mounted and `up` comes out as device +Z:
#
#     column 15 "Yaw"     corr  +0.071   (S1)   +0.047  (S3c)
#     column 16 "Pitch"   corr  +0.935   (S1)   +0.949  (S3c)
#     column 17 "Roll"    corr  -0.342   (S1)   +0.256  (S3c)
#
# Column 16 is the vertical rate. Nothing else comes close, on either sequence.
#
# Rather than guess the full permutation from two correlations, the channels
# below are built to be INDEPENDENT of it: the vertical rate is taken from the
# column that demonstrably is one, and the other two enter only as a magnitude,
# which no permutation can change. See `to_vehicle_frame`.
PHONE_GYR_VERTICAL = 1

# Vehicle columns. Phase 8 uses two of these; the classifier needs six more,
# and every one of them replaces a heuristic with a measurement.
VEH_YAW_RATE = 14        # deg/s
VEH_SPEED = 15           # km/h, indicated
VEH_LON_ACCEL = 16       # g
VEH_ENGINE_RPM = 21      # rev/min  — STATIONARY vs IDLING, measured not guessed
VEH_BRAKE_POSITION = 25  # 0/1      — BRAKING, from the pedal itself


def _rows(path: Path) -> list[list[str]]:
    return list(csv.reader(io.StringIO(path.read_bytes().decode("utf-8", errors="replace"))))[1:]


def _col(rows: list[list[str]], i: int) -> np.ndarray:
    out = np.empty(len(rows))
    for k, r in enumerate(rows):
        try:
            out[k] = float(r[i])
        except (ValueError, IndexError):
            out[k] = np.nan
    return out


def load_motion_sequence(name: str) -> dict[str, np.ndarray]:
    """One sequence with every channel the classifier's labels need.

    A separate loader from Phase 8's `load_sequence` on purpose: that one is
    verified against the committed speed-model numbers, and widening it to
    carry six more columns would put those numbers at risk for no benefit.
    """
    d = RAW / name
    phone, vehicle = _rows(d / "phone.csv"), _rows(d / "vehicle.csv")
    n = min(len(phone), len(vehicle))
    phone, vehicle = phone[:n], vehicle[:n]

    t = _col(phone, PHONE_T)
    imu = np.column_stack([_col(phone, i) for i in (*PHONE_ACC, *PHONE_GYR)])

    data = {
        "t": t,
        "imu": imu,
        "speed": _col(vehicle, VEH_SPEED) / 3.6,
        "yaw_rate": np.deg2rad(_col(vehicle, VEH_YAW_RATE)),
        "lon_accel": _col(vehicle, VEH_LON_ACCEL) * GRAVITY,
        "engine_rpm": _col(vehicle, VEH_ENGINE_RPM),
        "brake": _col(vehicle, VEH_BRAKE_POSITION),
    }

    finite = np.isfinite(t) & np.isfinite(imu).all(axis=1) & np.isfinite(data["speed"])
    advancing = np.ones(n, dtype=bool)
    advancing[1:] = np.diff(t) > 0
    keep = finite & advancing
    return {k: v[keep] for k, v in data.items()}


def vertical_gyro(seq: dict) -> np.ndarray:
    """The phone's angular rate about the true vertical, rad/s, positive LEFT.

    Positive counter-clockwise seen from above, matching ISO 8855 and the CAN
    bus, so a value here means the same thing as the label it is trained
    against. The sign is oriented per sequence because a phone can be mounted
    face-down, which negates it — a mounting the app has to support.
    """
    w = seq["imu"][:, 3 + PHONE_GYR_VERTICAL]
    truth = seq["yaw_rate"]
    m = np.isfinite(w) & np.isfinite(truth)
    if m.sum() > 500 and w[m].std() > 1e-9 and truth[m].std() > 1e-9:
        if np.corrcoef(w[m], truth[m])[0, 1] < 0:
            return -w
    return w


def rigid_mount_score(seq: dict) -> float:
    """How well the phone's vertical gyro tracks the car's yaw rate, 0..1.

    ★ THE CHECK THAT SAVED THIS PHASE FROM TRAINING ON NOISE ★

    A phone bolted to a dashboard turns with the car, so its angular rate about
    the vertical IS the vehicle's yaw rate. A phone lying on the passenger seat
    is not: it slides, rocks and rotates on its own, and its gyroscope is
    measuring the seat.

    Measured across IO-VNBD this is 0.93-0.95 for two sequences and under 0.3
    for every other one — while GPS speed against CAN speed stays above 0.9
    throughout, which is how we know the files are synchronised and the problem
    is the mounting, not the timing.

    Returned as a number rather than a verdict so the caller can print it. A
    dataset limitation that is measured and reported is a finding; the same
    limitation unmeasured is a mystery in the results.
    """
    if len(seq["t"]) < 500:
        return 0.0
    w = seq["imu"][:, 3 + PHONE_GYR_VERTICAL]
    truth = seq["yaw_rate"]
    m = np.isfinite(w) & np.isfinite(truth)
    if m.sum() < 500 or w[m].std() < 1e-9 or truth[m].std() < 1e-9:
        return 0.0
    return float(abs(np.corrcoef(w[m], truth[m])[0, 1]))


def to_vehicle_frame(seq: dict) -> np.ndarray:
    """The phone's IMU as six channels the ENGINE can also produce.

    Channels: [aFwd, aLat, aVert, wUp, wHorizMag, aMag - g]

    ★ EVERY CHANNEL IS EITHER VERIFIED OR PERMUTATION-INVARIANT ★
    The accelerometer's axis order is known and is what `up` is derived from.
    The gyroscope's is not — see PHONE_GYR_VERTICAL — so only its vertical
    component, which was identified against the CAN bus, is used directionally.
    The other two appear as a magnitude, which no axis permutation can change,
    and which is the same quantity the engine computes from real device axes.

    The forward/lateral split is the same job Phase 12's alignment engine does
    on the phone, done offline with the answer available: `up` from the mean
    specific force, `forward` from the horizontal direction that best explains
    the car's own longitudinal acceleration. Asking the network to solve
    alignment as a side effect of classifying motion would be asking it to
    redo, from one second of data, work the engine has already done properly
    from minutes of it.
    """
    accel, gyro = seq["imu"][:, 0:3], seq["imu"][:, 3:6]

    up = accel.mean(axis=0)
    up = up / max(1e-9, np.linalg.norm(up))
    vertical = accel @ up
    linear = accel - np.outer(vertical, up)

    # Least squares for the forward axis: the f maximising correlation between
    # (linear . f) and the car's longitudinal acceleration is proportional to
    # sum(lonAccel_i * linear_i). The CAN channel is used rather than a
    # differentiated speed because it is a direct measurement of the same
    # quantity and carries no quantisation noise.
    drive = np.where(np.isfinite(seq["lon_accel"]), seq["lon_accel"], 0.0)
    fwd = (linear * drive[:, None]).sum(axis=0)
    fwd = fwd - (fwd @ up) * up
    norm = np.linalg.norm(fwd)
    if norm < 1e-9:
        seed_axis = np.array([1.0, 0.0, 0.0])
        fwd = seed_axis - (seed_axis @ up) * up
        norm = max(1e-9, np.linalg.norm(fwd))
    fwd = fwd / norm
    right = np.cross(up, fwd)

    w_up = vertical_gyro(seq)
    # Horizontal angular rate as a magnitude: pitching over a crest and rolling
    # into a corner both show here, and neither needs an axis order to be known.
    w_horiz = np.sqrt(np.maximum(0.0, (gyro**2).sum(axis=1) - w_up**2))

    return np.column_stack(
        [
            linear @ fwd,
            linear @ right,
            vertical - GRAVITY,
            w_up,
            w_horiz,
            np.linalg.norm(accel, axis=1) - GRAVITY,
        ]
    )


def _moving_mean(x: np.ndarray, n: int) -> np.ndarray:
    if n < 2:
        return x.copy()
    pad = n // 2
    padded = np.pad(x, (pad, pad), mode="edge")
    return np.convolve(padded, np.ones(n) / n, mode="same")[pad : pad + len(x)]


def label_sequence(seq: dict) -> np.ndarray:
    """Per-sample motion state, from the CAN bus wherever the CAN bus knows.

    ★ PRIORITY ORDER, AND WHY ★
    A vehicle can brake into a corner, so the classes overlap in reality and
    the order decides which wins. It runs from "most specific about what the
    estimator should do" to least:

        POTHOLE   discard this sample. Nothing else about the window matters
                  if the accelerometer just measured a kerb.
        stopped   velocity is exactly zero — the strongest statement available
                  and the one that earns a ZUPT.
        turning   the gyro carries the information; the lateral force is
                  centripetal, not travel.
        accel/brake  longitudinal change is real rather than tilt.
        STRAIGHT  the ordinary case, and the majority class.

    Only POTHOLE_EVENT is a heuristic. The dataset carries no pothole
    annotation, so it is an impulse detector on the vertical residual — said
    plainly, because "our AI detects potholes" is a claim a judge is entitled
    to ask the provenance of.
    """
    speed = seq["speed"]
    yaw = seq["yaw_rate"]
    lon = seq["lon_accel"]
    rpm = seq["engine_rpm"]
    brake = seq["brake"]
    n = len(speed)

    mag = np.linalg.norm(seq["imu"][:, 0:3], axis=1)
    residual = np.abs(mag - _moving_mean(mag, MOTION_WINDOW_SAMPLES))

    labels = np.full(n, IDX["STRAIGHT"], dtype=np.int64)
    stopped = speed < MOTION_STOP_SPEED_MPS
    moving = ~stopped

    # Engine speed, measured. The first version inferred this from vibration
    # energy, which is a statement about the phone rather than about the car.
    engine_on = np.isfinite(rpm) & (rpm > 300)
    labels[stopped & engine_on] = IDX["IDLING"]
    labels[stopped & ~engine_on] = IDX["STATIONARY"]

    labels[moving & (lon > MOTION_ACCEL_MPS2)] = IDX["ACCELERATING"]
    # The brake pedal itself, not only the resulting deceleration: engine
    # braking down a hill is a deceleration and is not the driver braking.
    braking = (lon < -MOTION_ACCEL_MPS2) | (np.isfinite(brake) & (brake > 0.5))
    labels[moving & braking] = IDX["BRAKING"]

    # ISO 8855: yaw rate is positive counter-clockwise from above — a LEFT
    # turn. Getting this backwards is invisible in the accuracy figure and
    # wrong in every use of it.
    labels[moving & (yaw > MOTION_TURN_RATE_RADS)] = IDX["TURNING_LEFT"]
    labels[moving & (yaw < -MOTION_TURN_RATE_RADS)] = IDX["TURNING_RIGHT"]

    labels[moving & (residual > MOTION_POTHOLE_MPS2)] = IDX["POTHOLE_EVENT"]
    return labels


def window(seq: dict) -> tuple[np.ndarray, np.ndarray]:
    """1-second windows, 50 % overlap, label = the state at the window's END.

    POTHOLE_EVENT is the exception: a window counts as a pothole if the impulse
    falls anywhere inside it. An impulse lasts two or three samples, so
    requiring it to land on the last one would discard most of them — and the
    engine's use for the class is "discard this window", not "the kerb was
    struck at this instant".
    """
    x = to_vehicle_frame(seq)
    labels = label_sequence(seq)
    starts = range(0, len(x) - MOTION_WINDOW_SAMPLES + 1, MOTION_WINDOW_STRIDE)
    if not starts:
        return np.empty((0, MOTION_WINDOW_SAMPLES, N_RAW_CHANNELS)), np.empty(0, dtype=np.int64)

    X = np.stack([x[s : s + MOTION_WINDOW_SAMPLES] for s in starts])
    y = [
        IDX["POTHOLE_EVENT"]
        if (labels[s : s + MOTION_WINDOW_SAMPLES] == IDX["POTHOLE_EVENT"]).any()
        else labels[s + MOTION_WINDOW_SAMPLES - 1]
        for s in starts
    ]
    return X, np.array(y, dtype=np.int64)


MOUNT_ERROR_YAW_DEG = 10.0


def motion_augment(X: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Residual misalignment, sensor noise, bias and engine vibration.

    ★ THE ROTATION IS APPLIED TO THE HORIZONTAL PAIR ONLY ★
    Phase 8 rotates the whole 3-vector because its channels ARE device axes.
    Here they are not: three of the six are already resolved (forward, lateral,
    vertical) and two are magnitudes, which a rotation cannot touch. What a
    residual alignment error actually does to this representation is mix
    forward into lateral and back — a 2-D rotation of the first two channels.

    Ten degrees, against Phase 12's measured 3-4. The model learns to tolerate
    an imperfect alignment; it is not asked to work without one.
    """
    out = X.copy()
    w = out.shape[1]
    for i in range(len(out)):
        yaw = np.deg2rad(rng.uniform(-MOUNT_ERROR_YAW_DEG, MOUNT_ERROR_YAW_DEG))
        c, s_ = np.cos(yaw), np.sin(yaw)
        f, lat = out[i, :, 0].copy(), out[i, :, 1].copy()
        out[i, :, 0] = f * c - lat * s_
        out[i, :, 1] = f * s_ + lat * c

        # A cheap handset is noisier than a research rig.
        out[i, :, 0:3] += rng.normal(0, 0.05, (w, 3))
        out[i, :, 3:5] += rng.normal(0, 0.002, (w, 2))
        # Constant bias — the error that actually kills dead reckoning.
        out[i, :, 0:3] += rng.uniform(0.01, 0.05) * rng.choice([-1, 1], 3)
        out[i, :, 3] += rng.uniform(0.0005, 0.002) * rng.choice([-1, 1])
        # Engine vibration, 15-25 Hz, aliased by the 10 Hz rate exactly as a
        # real phone stream decimated without an anti-alias filter would be.
        f_hz = rng.uniform(15, 25)
        ts = np.arange(w) / 10.0
        vib = rng.uniform(0.05, 0.3) * np.sin(2 * np.pi * f_hz * ts)
        out[i, :, 2] += vib
        out[i, :, 5] += vib
    return out


def main() -> None:
    rng = np.random.default_rng(SEED)
    PROCESSED.mkdir(parents=True, exist_ok=True)

    print("\nmotion-state windows\n")
    print("  rigid-mount screen — does the phone's gyro see the car's yaw?\n")
    print(f"    {'sequence':12} {'rows':>7} {'corr':>6}")

    usable: list[tuple[str, dict]] = []
    for d in sorted(p.name for p in RAW.iterdir() if p.is_dir()):
        try:
            seq = load_motion_sequence(d)
        except (FileNotFoundError, OSError):
            continue
        if len(seq["t"]) < 2000:
            continue
        score = rigid_mount_score(seq)
        verdict = "keep" if score >= MOTION_RIGID_MIN_CORR else "drop — phone not rigidly mounted"
        print(f"    {d:12} {len(seq['t']):7d} {score:6.3f}  {verdict}")
        if score >= MOTION_RIGID_MIN_CORR:
            usable.append((d, seq))

    if len(usable) < 2:
        raise SystemExit(
            f"\n  only {len(usable)} sequence(s) survive the rigid-mount screen — "
            "not enough to hold a journey out. Lower MOTION_RIGID_MIN_CORR only if "
            "you are willing to train on a phone that was lying on the seat.\n"
        )

    # ★ THE HELD-OUT JOURNEY IS THE LARGEST USABLE ONE ★
    # With so few rigidly-mounted sequences the split cannot be generous. The
    # biggest is held out entirely and never trained on; the rest train, with
    # the last fifth of each kept back for early stopping only. That is weaker
    # than Phase 8's sequence-disjoint validation and is said so in the README.
    usable.sort(key=lambda kv: len(kv[1]["t"]), reverse=True)
    test_name, test_seq = usable[0]
    train_names = [n for n, _ in usable[1:]]
    print(f"\n  test  (held out entirely)  {test_name}")
    print(f"  train                     {', '.join(train_names)}")

    Xtr_parts, ytr_parts, Xva_parts, yva_parts = [], [], [], []
    for name, seq in usable[1:]:
        X, y = window(seq)
        if len(X) < 50:
            continue
        cut = int(len(X) * 0.8)
        Xtr_parts.append(X[:cut])
        ytr_parts.append(y[:cut])
        Xva_parts.append(X[cut:])
        yva_parts.append(y[cut:])

    if not Xtr_parts:
        raise SystemExit("no training windows")

    Xtr = motion_augment(np.concatenate(Xtr_parts), rng)
    ytr = np.concatenate(ytr_parts)
    Xva = np.concatenate(Xva_parts)
    yva = np.concatenate(yva_parts)
    Xte, yte = window(test_seq)

    # The scaler is fit on TRAIN ONLY. Fitting it on everything leaks the test
    # set's distribution into training and flatters every number after it.
    flat = Xtr.reshape(-1, N_RAW_CHANNELS)
    mean = flat.mean(axis=0)
    std = flat.std(axis=0)
    std[std == 0] = 1.0

    print(f"\n  windows: train {len(Xtr)}   val {len(Xva)}   test {len(Xte)}")
    print("\n  class balance (train)")
    counts = np.bincount(ytr, minlength=len(MOTION_STATES))
    for i, name in enumerate(MOTION_STATES):
        print(f"    {name:16} {counts[i]:7d}  {100 * counts[i] / max(1, counts.sum()):5.1f}%")

    np.savez_compressed(
        PROCESSED / "motion_windows.npz",
        X_train=Xtr.astype(np.float32),
        y_train=ytr,
        X_val=Xva.astype(np.float32),
        y_val=yva,
        X_test=Xte.astype(np.float32),
        y_test=yte,
        scaler_mean=mean.astype(np.float32),
        scaler_std=std.astype(np.float32),
        classes=np.array(MOTION_STATES),
        test_sequence=np.array(test_name),
        train_sequences=np.array(train_names),
    )
    print(f"\n  wrote {PROCESSED / 'motion_windows.npz'}\n")


if __name__ == "__main__":
    main()
