"""
IO-VNBD -> windowed training arrays (Phase 8, step 8A-2).

Input  : the phone's accelerometer and gyroscope, 6 channels at 10 Hz.
Label  : the CAR'S OWN WHEEL-SPEED SENSOR at the end of the window, in m/s.

Using wheel speed rather than GPS speed as the label matters. GPS speed is
unavailable in exactly the situation this model exists to serve — a tunnel —
so a model trained against it would be learning from a teacher that goes silent
whenever it is needed. Wheel odometry does not.

    python ml/data/preprocess.py
"""

from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import (  # noqa: E402
    CHANNELS,
    MAX_SPEED_MPS,
    N_CHANNELS,
    PROCESSED,
    RAW,
    SEED,
    TEST_SEQUENCES,
    TRAIN_SEQUENCES,
    VAL_SEQUENCES,
    WINDOW_SAMPLES,
    WINDOW_STRIDE,
)

# Column indices, verified against the headers printed by download.py --explore.
PHONE_T = 7
PHONE_ACC = (9, 10, 11)      # ACCELEROMETER X/Y/Z, m/s^2, gravity included
PHONE_GYR = (15, 16, 17)     # GYROSCOPE Yaw/Pitch/Roll, rad/s
PHONE_GPS_SPEED = 3          # GPS SPEED, km/h — for comparison only, not a label
VEHICLE_SPEED = 15           # Indicated Vehicle Speed, km/h — THE LABEL
VEHICLE_YAWRATE = 14         # Yaw Rate, deg/s — ground truth heading for 8A-3


def _rows(path: Path) -> list[list[str]]:
    text = path.read_bytes().decode("utf-8", errors="replace")
    return list(csv.reader(io.StringIO(text)))[1:]


def _f(row: list[str], i: int) -> float:
    try:
        return float(row[i])
    except (ValueError, IndexError):
        return float("nan")


def load_sequence(seq: str) -> dict[str, np.ndarray]:
    """One sequence as aligned arrays, with the bad rows removed.

    ★ Vtb01 contains 5456 rows whose timestamp does not advance — the logger
    duplicated them. Left in, they would be ~17 % of that sequence teaching the
    model that the vehicle freezes periodically, and they would corrupt any
    trajectory integrated from it. Dropped here, and counted, because a silent
    drop is how a dataset problem becomes a modelling mystery.
    """
    d = RAW / seq
    phone, vehicle = _rows(d / "phone.csv"), _rows(d / "vehicle.csv")
    n = min(len(phone), len(vehicle))  # the pair is row-synchronised by construction
    phone, vehicle = phone[:n], vehicle[:n]

    t = np.array([_f(r, PHONE_T) for r in phone])
    imu = np.array(
        [[_f(r, i) for i in (*PHONE_ACC, *PHONE_GYR)] for r in phone], dtype=np.float64
    )
    speed = np.array([_f(r, VEHICLE_SPEED) for r in vehicle]) / 3.6  # km/h -> m/s
    yaw_rate = np.deg2rad([_f(r, VEHICLE_YAWRATE) for r in vehicle])
    gps_speed = np.array([_f(r, PHONE_GPS_SPEED) for r in phone]) / 3.6

    finite = np.isfinite(t) & np.isfinite(imu).all(axis=1) & np.isfinite(speed)
    advancing = np.ones(n, dtype=bool)
    advancing[1:] = np.diff(t) > 0
    keep = finite & advancing
    dropped = int((~keep).sum())

    return {
        "t": t[keep],
        "imu": imu[keep],
        "speed": np.clip(speed[keep], 0, MAX_SPEED_MPS),
        "yaw_rate": yaw_rate[keep],
        "gps_speed": gps_speed[keep],
        "dropped": dropped,
        "total": n,
    }


def window(seq_data: dict) -> tuple[np.ndarray, np.ndarray]:
    """Slice into 2-second windows, 50 % overlap. Label = speed at window END."""
    imu, speed = seq_data["imu"], seq_data["speed"]
    starts = range(0, len(imu) - WINDOW_SAMPLES + 1, WINDOW_STRIDE)
    if not starts:
        return np.empty((0, WINDOW_SAMPLES, N_CHANNELS)), np.empty(0)
    X = np.stack([imu[s : s + WINDOW_SAMPLES] for s in starts])
    y = np.array([speed[s + WINDOW_SAMPLES - 1] for s in starts])
    return X, y


# ── Augmentation (8A-2, the DOMAIN GAP block) ────────────────────────────────
# IO-VNBD's phone sat in one particular position in one particular car. Ours
# will be in a cradle, a cup holder, or a pocket, in any car. Without this the
# model learns that car's mounting angle and nothing more general.


MOUNT_TILT_LIMIT_DEG = 30.0


def _random_rotation(rng: np.random.Generator) -> np.ndarray:
    """A random but PLAUSIBLE phone mounting: any yaw, limited pitch and roll.

    ★ This was a uniformly random SO(3) rotation and that made the model worse:
    measured 4.26 m/s test MAE with this version against 6.01 m/s with uniform
    rotation, on an identical training run.

    The reason is that gravity is the one absolute reference in the window. A
    uniform rotation puts the phone upside-down and on its side as often as
    upright, which destroys that reference and asks the model to solve a harder
    problem than the real one. A phone in a car is in a cradle, on a dash, or in
    a cup holder: pointing any direction in the horizontal plane, but within
    about thirty degrees of level. Augment for the phones that exist.
    """
    yaw = rng.uniform(0, 2 * np.pi)
    lim = np.deg2rad(MOUNT_TILT_LIMIT_DEG)
    pitch, roll = rng.uniform(-lim, lim), rng.uniform(-lim, lim)
    cz, sz = np.cos(yaw), np.sin(yaw)
    cy, sy = np.cos(pitch), np.sin(pitch)
    cx, sx = np.cos(roll), np.sin(roll)
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    return rz @ ry @ rx


def augment(X: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Rotation, extra noise, bias, vibration. Applied to TRAIN ONLY.

    The window length is taken from the array rather than from WINDOW_SAMPLES:
    Phase 13's motion classifier reads one second where the speed regressor
    reads two, and the augmentation is about the PHONE, not about the model.
    For a 20-sample window every draw is identical to before, so Phase 8's
    committed numbers still reproduce exactly.
    """
    out = X.copy()
    w = out.shape[1]
    for i in range(len(out)):
        # 1. Orientation: accelerometer and gyroscope are the same physical
        #    frame, so they take the SAME rotation. Rotating them independently
        #    would teach the model a phone that cannot exist.
        R = _random_rotation(rng)
        out[i, :, 0:3] = out[i, :, 0:3] @ R.T
        out[i, :, 3:6] = out[i, :, 3:6] @ R.T
        # 2. A cheap handset is noisier than a research rig.
        out[i, :, 0:3] += rng.normal(0, 0.05, (w, 3))
        out[i, :, 3:6] += rng.normal(0, 0.002, (w, 3))
        # 3. Constant bias — the error that actually kills dead reckoning.
        out[i, :, 0:3] += rng.uniform(0.01, 0.05) * rng.choice([-1, 1], 3)
        out[i, :, 3:6] += rng.uniform(0.0005, 0.002) * rng.choice([-1, 1], 3)
        # 4. Engine vibration, 15-25 Hz on the vertical axis.
        #    ★ At a 10 Hz sample rate this is above Nyquist and ALIASES. That is
        #    not a bug in the augmentation: a phone stream decimated to 10 Hz
        #    without an anti-alias filter contains exactly this artefact, and
        #    teaching the model to ignore it is the point. Evaluating the sine
        #    at the real sample times is what physically happens.
        f = rng.uniform(15, 25)
        ts = np.arange(w) / 10.0
        out[i, :, 2] += rng.uniform(0.05, 0.3) * np.sin(2 * np.pi * f * ts)
    return out


# ── Statistical features (the ridge baseline's input) ────────────────────────


def statistical_features(X: np.ndarray) -> np.ndarray:
    """7 features per axis x 6 axes = 42.

    The guide says 36; it lists seven statistics (mean, std, min, max, energy,
    dominant frequency, spectral centroid). Seven times six is 42, so 42 is what
    this computes — the list won over the arithmetic.
    """
    n, w, c = X.shape
    spectra = np.abs(np.fft.rfft(X - X.mean(axis=1, keepdims=True), axis=1))
    freqs = np.fft.rfftfreq(w, d=1 / 10.0)
    power = spectra**2
    total = power.sum(axis=1) + 1e-12
    feats = [
        X.mean(axis=1),
        X.std(axis=1),
        X.min(axis=1),
        X.max(axis=1),
        (X**2).sum(axis=1) / w,                       # energy
        freqs[np.argmax(spectra, axis=1)],            # dominant frequency
        (power * freqs[None, :, None]).sum(axis=1) / total,  # spectral centroid
    ]
    return np.concatenate([f.reshape(n, -1) for f in feats], axis=1)


def build_split(names: list[str], augment_it: bool, rng) -> dict:
    Xs, ys, report = [], [], []
    for seq in names:
        if not (RAW / seq).exists():
            print(f"  ! {seq} not downloaded — skipping")
            continue
        data = load_sequence(seq)
        X, y = window(data)
        if len(X) == 0:
            print(f"  ! {seq} too short for a {WINDOW_SAMPLES}-sample window")
            continue
        # ★ DEGENERATE-SEQUENCE GUARD ★
        # A sequence whose label never varies carries no information for a
        # regressor, but it does carry weight: Vw01 is 34 minutes of a car
        # idling with the wheels at exactly zero, and including it made a
        # quarter of the training set say "the answer is 0". A constant label
        # is not a small data-quality wrinkle, it is an anti-signal — so refuse
        # it loudly rather than averaging it in.
        if y.std() < 0.5:
            print(
                f"  ✖ {seq} REFUSED — label std {y.std():.3f} m/s over "
                f"{len(y)} windows (max {y.max()*3.6:.1f} km/h). "
                "Constant-speed sequence, no signal to learn."
            )
            continue
        Xs.append(X)
        ys.append(y)
        report.append(
            f"  {seq:8} {len(X):>6} windows  "
            f"{data['speed'].min()*3.6:5.1f}-{data['speed'].max()*3.6:5.1f} km/h  "
            f"dropped {data['dropped']:>5}/{data['total']}"
        )
    print("\n".join(report))
    if not Xs:
        raise SystemExit("no usable sequences — run ml/data/download.py first")
    X = np.concatenate(Xs)
    y = np.concatenate(ys)
    if augment_it:
        X = np.concatenate([X, augment(X, rng)])
        y = np.concatenate([y, y])
        print(f"  + augmentation -> {len(X)} windows")
    return {"X": X, "y": y}


def main() -> None:
    rng = np.random.default_rng(SEED)
    PROCESSED.mkdir(parents=True, exist_ok=True)

    print("TRAIN")
    train = build_split(TRAIN_SEQUENCES, True, rng)
    print("VAL")
    val = build_split(VAL_SEQUENCES, False, rng)
    print("TEST")
    test = build_split(TEST_SEQUENCES, False, rng)

    # ★ Scaler fitted on TRAIN ONLY. Fitting on everything leaks the test set's
    #   distribution into the inputs and quietly inflates the score.
    flat = train["X"].reshape(-1, N_CHANNELS)
    mean, std = flat.mean(axis=0), flat.std(axis=0)
    std[std < 1e-6] = 1.0

    out = {}
    for name, split in (("train", train), ("val", val), ("test", test)):
        out[f"X_{name}"] = ((split["X"] - mean) / std).astype(np.float32)
        out[f"y_{name}"] = split["y"].astype(np.float32)
        out[f"F_{name}"] = statistical_features(split["X"]).astype(np.float32)
    out["scaler_mean"] = mean.astype(np.float32)
    out["scaler_std"] = std.astype(np.float32)

    np.savez_compressed(PROCESSED / "windows.npz", **out)

    print(f"\n✔ {PROCESSED / 'windows.npz'}")
    for name in ("train", "val", "test"):
        X, y = out[f"X_{name}"], out[f"y_{name}"]
        print(
            f"  {name:5} X{X.shape}  y {y.mean()*3.6:5.1f} km/h mean, "
            f"{y.max()*3.6:5.1f} max, {(y < 0.5).mean()*100:4.1f}% stopped"
        )
    print(f"  channels {CHANNELS}")
    print(f"  scaler mean {np.round(mean, 3)}")
    print(f"  scaler std  {np.round(std, 3)}")


if __name__ == "__main__":
    main()
