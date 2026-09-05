"""
Cache 6-second windows so every window length can be measured from one file.

★ WHY ONE LONG CACHE RATHER THAN ONE CACHE PER LENGTH ★
The label is the speed at the window's END, so a shorter window is exactly the
TAIL of a longer one. Slicing gives every arm the same number of windows, the
same labels and the same alignment, so a difference between two rows is the
window length and nothing else. Separate caches would differ in window count
and boundary placement too, and the comparison would be worth much less.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "data"))
from config import PROCESSED, RAW, TEST_SEQUENCES, TRAIN_SEQUENCES, VAL_SEQUENCES  # noqa: E402
from preprocess import load_sequence  # noqa: E402

LONG_SAMPLES = 60   # 6 s at 10 Hz
STRIDE = 10         # 1 s, so every arm sees the same window starts
OUT = PROCESSED / "long_windows.npz"


def build(names: list[str]):
    Xs, ys, ids = [], [], []
    for i, seq in enumerate(names):
        if not (RAW / seq).exists():
            continue
        d = load_sequence(seq)
        imu, speed = d["imu"], d["speed"]
        starts = range(0, len(imu) - LONG_SAMPLES + 1, STRIDE)
        if not starts:
            continue
        X = np.stack([imu[s : s + LONG_SAMPLES] for s in starts])
        y = np.array([speed[s + LONG_SAMPLES - 1] for s in starts])
        if y.std() < 0.5:
            print(f"  x {seq} refused (label std {y.std():.3f})")
            continue
        Xs.append(X)
        ys.append(y)
        # ★ NEEDED TO INTEGRATE ANYTHING ★
        # Windows are stored consecutively and are one second apart, so a run
        # of them is a stretch of driving — which is what a drift figure is
        # computed over. Without knowing where one sequence ends, a 30-window
        # block would silently splice the end of one journey onto the start of
        # another and report the join as error.
        ids.append(np.full(len(X), i, dtype=np.int16))
        print(f"  {seq:8} {len(X):>6} windows")
    return (
        np.concatenate(Xs).astype(np.float32),
        np.concatenate(ys).astype(np.float32),
        np.concatenate(ids),
    )


def main() -> None:
    out = {}
    for name, seqs in (
        ("train", TRAIN_SEQUENCES),
        ("val", VAL_SEQUENCES),
        ("test", TEST_SEQUENCES),
    ):
        print(name.upper())
        X, y, ids = build(seqs)
        out[f"X_{name}"], out[f"y_{name}"], out[f"s_{name}"] = X, y, ids
    np.savez_compressed(OUT, **out)
    print(f"\n✔ {OUT}")
    for n in ("train", "val", "test"):
        print(f"  {n:5} {out[f'X_{n}'].shape}")


if __name__ == "__main__":
    main()
