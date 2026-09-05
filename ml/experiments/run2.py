"""
Window length, capacity and channel mode, measured on identical windows.

    ./ml/.venv/bin/python ml/experiments/run2.py
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "data"))
from config import PROCESSED, RESULTS, SEED  # noqa: E402
from preprocess import augment  # noqa: E402
from derived import derive  # noqa: E402


def build_channels(X, mode):
    """Assemble the input tensor for a channel mode.

    'raw' and 'derived' exist only so the ablation can separate the two; the
    pipeline itself always ships 'both'. The derivation comes from ml/derived.py
    so there is exactly one definition of what these channels are.
    """
    if mode == "raw":
        return X
    if mode == "derived":
        return derive(X)
    if mode == "both":
        return np.concatenate([X, derive(X)], axis=2)
    raise ValueError(f"unknown channel mode {mode!r}")


def n_channels(mode):
    return {"raw": 6, "derived": 6, "both": 12}[mode]


class SpeedNet(nn.Module):
    """The shipped SpeedCNN with its two sizes made adjustable.

    Identical to `models/speed_cnn.SpeedCNN` at width=1: same layers, same
    kernels, same two pools, same global average pool. `width` scales the
    channel counts so capacity can be measured against the 100k budget rather
    than assumed.
    """

    def __init__(self, in_channels: int, width: float = 1.0, dropout: float = 0.2):
        super().__init__()
        c1, c2 = int(32 * width), int(64 * width)
        self.features = nn.Sequential(
            nn.Conv1d(in_channels, c1, 5, padding=2),
            nn.BatchNorm1d(c1), nn.ReLU(), nn.MaxPool1d(2),
            nn.Conv1d(c1, c2, 5, padding=2),
            nn.BatchNorm1d(c2), nn.ReLU(), nn.MaxPool1d(2),
            nn.Conv1d(c2, c2, 3, padding=1),
            nn.BatchNorm1d(c2), nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),
        )
        self.head = nn.Sequential(
            nn.Flatten(), nn.Linear(c2, int(32 * width)), nn.ReLU(),
            nn.Dropout(dropout), nn.Linear(int(32 * width), 1),
        )

    def forward(self, x):
        return self.head(self.features(x)).squeeze(-1)

    @property
    def n_params(self):
        return sum(p.numel() for p in self.parameters() if p.requires_grad)


def seed_everything(seed):
    random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)


def metrics(pred, true):
    err = pred - true
    ss_res = float((err ** 2).sum())
    ss_tot = float(((true - true.mean()) ** 2).sum())
    return {
        "mae_mps": float(np.abs(err).mean()),
        "rmse_mps": float(np.sqrt((err ** 2).mean())),
        "r2": 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan"),
        # ★ BIAS IS WHAT ACTUALLY BECOMES DRIFT ★
        # Dead reckoning integrates this model's output. A zero-mean error of
        # 3 m/s largely cancels over a 30 s outage; a 1 m/s BIAS does not — it
        # is 30 m of invented distance, every time. MAE cannot tell them apart,
        # which is why it is not the only number here.
        "bias_mps": float(err.mean()),
        "mae_stopped": float(np.abs(err[true < 0.5]).mean()) if (true < 0.5).any() else 0.0,
        "mae_moving": float(np.abs(err[true >= 0.5]).mean()) if (true >= 0.5).any() else 0.0,
    }


_CACHE = {}


def prepare(mode, win):
    key = (mode, win)
    if key in _CACHE:
        return _CACHE[key]
    npz = np.load(PROCESSED / "long_windows.npz")
    rng = np.random.default_rng(SEED)

    # The last `win` samples: a shorter window is the tail of a longer one,
    # so every arm gets the same windows and the same labels.
    def cut(X):
        return X[:, -win:, :].astype(np.float64)

    Xtr, ytr = cut(npz["X_train"]), npz["y_train"]
    Xtr = np.concatenate([Xtr, augment(Xtr, rng)])
    ytr = np.concatenate([ytr, ytr])

    Xtr = build_channels(Xtr, mode)
    Xva = build_channels(cut(npz["X_val"]), mode)
    Xte = build_channels(cut(npz["X_test"]), mode)

    flat = Xtr.reshape(-1, Xtr.shape[2])
    mean, std = flat.mean(axis=0), flat.std(axis=0)
    std[std < 1e-6] = 1.0

    def t(X):
        return torch.tensor(((X - mean) / std).astype(np.float32)).permute(0, 2, 1)

    out = (t(Xtr), torch.tensor(ytr), t(Xva), torch.tensor(npz["y_val"]),
           t(Xte), torch.tensor(npz["y_test"]))
    _CACHE[key] = out
    return out


def run(name, mode, win, width, epochs=50, dropout=0.2):
    seed_everything(SEED)
    Xtr, ytr, Xva, yva, Xte, yte = prepare(mode, win)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = SpeedNet(n_channels(mode), width, dropout).to(device)
    loss_fn = nn.HuberLoss(delta=1.0)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(Xtr, ytr), batch_size=128, shuffle=True,
        generator=torch.Generator().manual_seed(SEED))

    best, best_state, bad = float("inf"), None, 0
    t0 = time.time()
    for epoch in range(1, epochs + 1):
        model.train()
        for xb, yb in loader:
            xb, yb = xb.to(device), yb.to(device)
            opt.zero_grad(); loss_fn(model(xb), yb).backward(); opt.step()
        sched.step()
        model.eval()
        with torch.no_grad():
            v = float(np.abs(model(Xva.to(device)).cpu().numpy() - yva.numpy()).mean())
        if v < best - 1e-4:
            best, bad = v, 0
            best_state = {k: t.detach().clone() for k, t in model.state_dict().items()}
        else:
            bad += 1
            if bad >= 10:
                break
    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        p = np.clip(model(Xte.to(device)).cpu().numpy(), 0, None)
    m = metrics(p, yte.numpy())
    m.update(arm=name, mode=mode, win=win, width=width, params=model.n_params,
             val_mae=best, epochs=epoch, seconds=round(time.time() - t0, 1))
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()

    arms = [
        ("shipped        ", "raw",  20, 1.0),
        ("both ch        ", "both", 20, 1.0),
        ("4 s window     ", "both", 40, 1.0),
        ("6 s window     ", "both", 60, 1.0),
        ("6 s, raw ch    ", "raw",  60, 1.0),
        ("6 s, both, x1.5", "both", 60, 1.5),
        ("6 s, both, x2  ", "both", 60, 2.0),
    ]
    if args.quick:
        arms = arms[:3]

    rows = []
    print("arm              mode   win  MAE m/s   km/h    RMSE     r2    bias  stopped  moving   params  ep")
    for name, mode, win, width in arms:
        r = run(name.strip(), mode, win, width)
        rows.append(r)
        print(
            f"{name} {r['mode']:6} {r['win']:4} {r['mae_mps']:8.3f} {r['mae_mps']*3.6:6.2f} "
            f"{r['rmse_mps']:7.3f} {r['r2']:6.3f} {r['bias_mps']:7.3f} {r['mae_stopped']:8.3f} "
            f"{r['mae_moving']:7.3f} {r['params']:8} {r['epochs']:3}",
            flush=True,
        )
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "experiments.json").write_text(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
