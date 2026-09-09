"""
Does the variance head know a two-wheeler is not a car?

★ THE ACCEPTANCE TEST 2.2 NAMES ★

"Validate on Tier F: the two-wheeler windows must show materially higher
predicted variance than the car windows. If they do not, the head has not
learned what it needs to and shipping it would be worse than the gate."

Runs the trained head over windows built from the Tier F ride and over the
held-out IO-VNBD test split, and compares the sigma distributions.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import PROCESSED, RESULTS  # noqa: E402
from derived import with_derived  # noqa: E402
from models.speed_cnn import SpeedCNN  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "data/replay/drive_20260909_1942.jsonl"
WINDOW, RATE_HZ = 60, 10


def tierf_windows() -> np.ndarray:
    """Decimate the 127 Hz ride onto the model's 10 Hz grid, as the app does."""
    rows = []
    next_t = None
    for line in LOG.read_text().splitlines():
        if not line.strip():
            continue
        s = json.loads(line)
        imu = s.get("imu")
        if not imu:
            continue
        t = s["t"]
        if next_t is not None and t < next_t:
            continue
        next_t = t + 1000 / RATE_HZ
        rows.append([imu["ax"], imu["ay"], imu["az"], imu["gx"], imu["gy"], imu["gz"]])
    a = np.asarray(rows, dtype=np.float32)
    n = len(a) // WINDOW
    return a[: n * WINDOW].reshape(n, WINDOW, 6)


def main() -> None:
    ckpt = torch.load(RESULTS / "model_hetero.pt", map_location="cpu", weights_only=False)
    model = SpeedCNN(heteroscedastic=True)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    npz = np.load(PROCESSED / "windows.npz")
    scaler_mean = npz["scaler_mean"] if "scaler_mean" in npz else None
    Xte = torch.tensor(npz["X_test"]).permute(0, 2, 1)

    raw = tierf_windows()
    X = with_derived(raw)
    if scaler_mean is not None:
        mean = npz["scaler_mean"].astype(np.float32)
        std = npz["scaler_std"].astype(np.float32)
        X = (X - mean) / np.where(std == 0, 1, std)
    Xf = torch.tensor(X.astype(np.float32)).permute(0, 2, 1)

    with torch.no_grad():
        car = model(Xte).numpy()
        bike = model(Xf).numpy()

    def sig(o):
        return np.exp(0.5 * np.clip(o[:, 1], -6.0, 6.0))

    sc, sb = sig(car), sig(bike)
    q = lambda a, p: float(np.quantile(a, p))
    print(f"\n  windows: car(test) {len(sc)}   two-wheeler(Tier F) {len(sb)}\n")
    print(f"  {'':<18}{'p10':>8}{'p50':>8}{'p90':>8}{'mean':>8}")
    print(f"  {'car (IO-VNBD)':<18}{q(sc,.1):>8.2f}{q(sc,.5):>8.2f}{q(sc,.9):>8.2f}{sc.mean():>8.2f}")
    print(f"  {'two-wheeler':<18}{q(sb,.1):>8.2f}{q(sb,.5):>8.2f}{q(sb,.9):>8.2f}{sb.mean():>8.2f}")
    print(f"\n  ratio of medians: {q(sb,.5)/max(1e-6,q(sc,.5)):.2f}x")
    print(f"  mean predicted speed: car {car[:,0].mean():.1f}  two-wheeler {bike[:,0].mean():.1f} m/s\n")


if __name__ == "__main__":
    main()
