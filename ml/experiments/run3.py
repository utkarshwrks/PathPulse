"""
Optimise the thing that becomes drift, not the proxy.

★ MAE IS NOT WHAT A DEAD-RECKONING SYSTEM PAYS FOR ★

The engine INTEGRATES this model's output. Over a 30 s outage a zero-mean 3 m/s
error largely cancels; a 1 m/s BIAS does not — it is 30 metres of invented
distance, every time, and it is what puts the marker in a field. MAE scores
those two models identically.

So this measures drift the way the project's own ablation does: over contiguous
30-second stretches of a held-out journey, the error in the DISTANCE the model
would have said the vehicle travelled, as a percentage of the distance it
actually did. And then trains against it, by adding a term that penalises the
summed error over a block rather than only the error within each window.

    ./ml/.venv/bin/python ml/experiments/run3.py
"""

from __future__ import annotations

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
from run2 import SpeedNet, seed_everything  # noqa: E402

# Windows are one second apart, so a block of 30 is 30 seconds of driving —
# the outage length the published position results report.
BLOCK = 30


def blocks_for(ids: np.ndarray, block: int, stride: int = 1) -> np.ndarray:
    """Start indices of every contiguous within-sequence block of `block`.

    `stride` exists for training, not for scoring. At stride 1 successive
    blocks share 29 of their 30 windows, so an epoch does thirty times the work
    to see almost the same thing thirty times. Scoring keeps stride 1 because
    there every block is a distinct 30 s stretch to be right about.
    """
    starts = []
    n = len(ids)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and ids[j + 1] == ids[i]:
            j += 1
        for s in range(i, j - block + 2, stride):
            starts.append(s)
        i = j + 1
    return np.array(starts, dtype=np.int64)


def drift_metrics(pred: np.ndarray, true: np.ndarray, ids: np.ndarray) -> dict:
    """Distance error over contiguous 30 s stretches, as the ablation reports."""
    starts = blocks_for(ids, BLOCK)
    if len(starts) == 0:
        return {}
    idx = starts[:, None] + np.arange(BLOCK)[None, :]
    # dt is 1 s per window, so a sum of speeds IS a distance in metres.
    d_pred = pred[idx].sum(axis=1)
    d_true = true[idx].sum(axis=1)
    moving = d_true > 30.0  # a stretch that barely moved has no meaningful %
    if not moving.any():
        return {}
    pct = np.abs(d_pred[moving] - d_true[moving]) / d_true[moving] * 100
    signed = (d_pred[moving] - d_true[moving]) / d_true[moving] * 100
    return {
        "drift30_mean_pct": float(pct.mean()),
        "drift30_median_pct": float(np.median(pct)),
        "drift30_p90_pct": float(np.percentile(pct, 90)),
        "drift30_signed_pct": float(signed.mean()),
        "drift30_mean_m": float(np.abs(d_pred[moving] - d_true[moving]).mean()),
        "blocks": int(moving.sum()),
    }


def metrics(pred, true, ids):
    err = pred - true
    ss_res = float((err ** 2).sum())
    ss_tot = float(((true - true.mean()) ** 2).sum())
    m = {
        "mae_mps": float(np.abs(err).mean()),
        "rmse_mps": float(np.sqrt((err ** 2).mean())),
        "r2": 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan"),
        "bias_mps": float(err.mean()),
        "mae_stopped": float(np.abs(err[true < 0.5]).mean()) if (true < 0.5).any() else 0.0,
    }
    m.update(drift_metrics(pred, true, ids))
    return m


_CACHE = {}


def prepare(mode, win):
    key = (mode, win)
    if key in _CACHE:
        return _CACHE[key]
    npz = np.load(PROCESSED / "long_windows.npz")
    rng = np.random.default_rng(SEED)

    def cut(X):
        return X[:, -win:, :].astype(np.float64)

    Xtr, ytr, str_ids = cut(npz["X_train"]), npz["y_train"], npz["s_train"]
    Xtr_aug = augment(Xtr, rng)
    # ★ THE AUGMENTED COPY KEEPS ITS ORDER AND ITS SEQUENCE IDS ★
    # The block loss needs neighbours in time. Shuffling the two halves
    # together, or giving the copy fresh ids, would break every block.
    Xtr = np.concatenate([Xtr, Xtr_aug])
    ytr = np.concatenate([ytr, ytr])
    # Offset so an augmented block never splices onto an unaugmented one.
    ids_tr = np.concatenate([str_ids, str_ids + 1000])

    Xtr = build_channels(Xtr, mode)
    Xva = build_channels(cut(npz["X_val"]), mode)
    Xte = build_channels(cut(npz["X_test"]), mode)

    flat = Xtr.reshape(-1, Xtr.shape[2])
    mean, std = flat.mean(axis=0), flat.std(axis=0)
    std[std < 1e-6] = 1.0

    def t(X):
        return torch.tensor(((X - mean) / std).astype(np.float32)).permute(0, 2, 1)

    out = (t(Xtr), torch.tensor(ytr), ids_tr,
           t(Xva), torch.tensor(npz["y_val"]), npz["s_val"],
           t(Xte), torch.tensor(npz["y_test"]), npz["s_test"], mean, std)
    _CACHE[key] = out
    return out


def run(name, mode, win, width, block_weight, epochs=50, dropout=0.2):
    seed_everything(SEED)
    Xtr, ytr, ids_tr, Xva, yva, ids_va, Xte, yte, ids_te, _, _ = prepare(mode, win)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = SpeedNet(n_channels(mode), width, dropout).to(device)
    huber = nn.HuberLoss(delta=1.0)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)

    if block_weight > 0:
        # Batches are BLOCKS of consecutive windows, so the summed error over a
        # block is differentiable. Random window order cannot express that.
        starts = blocks_for(ids_tr, BLOCK, stride=BLOCK // 3)
        block_idx = torch.tensor(starts[:, None] + np.arange(BLOCK)[None, :])
        loader = torch.utils.data.DataLoader(
            torch.utils.data.TensorDataset(block_idx), batch_size=16, shuffle=True,
            generator=torch.Generator().manual_seed(SEED))
    else:
        loader = torch.utils.data.DataLoader(
            torch.utils.data.TensorDataset(Xtr, ytr), batch_size=128, shuffle=True,
            generator=torch.Generator().manual_seed(SEED))

    best, best_state, bad = float("inf"), None, 0
    t0 = time.time()
    for epoch in range(1, epochs + 1):
        model.train()
        for batch in loader:
            opt.zero_grad()
            if block_weight > 0:
                bi = batch[0]                      # (b, BLOCK)
                xb = Xtr[bi.reshape(-1)].to(device)
                yb = ytr[bi.reshape(-1)].to(device)
                pred = model(xb)
                loss = huber(pred, yb)
                # The distance error over each block, which is the drift.
                pv = pred.view(bi.shape)
                yv = yb.view(bi.shape)
                loss = loss + block_weight * (pv.sum(1) - yv.sum(1)).abs().mean() / BLOCK
            else:
                xb, yb = batch[0].to(device), batch[1].to(device)
                loss = huber(model(xb), yb)
            loss.backward()
            opt.step()
        sched.step()
        model.eval()
        with torch.no_grad():
            vp = np.clip(model(Xva.to(device)).cpu().numpy(), 0, None)
        # ★ EARLY STOPPING ON THE METRIC THAT MATTERS ★
        # Stopping on validation MAE selects the epoch with the best per-window
        # score, which is not the epoch with the least drift — that is the
        # entire premise of this file.
        dv = drift_metrics(vp, yva.numpy(), ids_va)
        v = dv.get("drift30_mean_pct", float(np.abs(vp - yva.numpy()).mean()))
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
    m = metrics(p, yte.numpy(), ids_te)
    m.update(arm=name, mode=mode, win=win, width=width, block_weight=block_weight,
             params=model.n_params, val=best, epochs=epoch,
             seconds=round(time.time() - t0, 1))
    return m


ARMS = [
    ("shipped         ", "raw",  20, 1.0, 0.0),
    ("6 s + derived   ", "both", 60, 1.0, 0.0),
    ("+ block loss 0.5", "both", 60, 1.0, 0.5),
    ("+ block loss 2  ", "both", 60, 1.0, 2.0),
    ("+ block loss 5  ", "both", 60, 1.0, 5.0),
]


def main():
    rows = []
    print("arm               MAE m/s    bias   stopped   drift30%  median    p90  signed%   ep", flush=True)
    for name, mode, win, width, bw in ARMS:
        print(f"  ... {name.strip()}", flush=True)
        r = run(name.strip(), mode, win, width, bw)
        rows.append(r)
        print(
            f"{name} {r['mae_mps']:8.3f} {r['bias_mps']:7.3f} {r['mae_stopped']:9.3f} "
            f"{r['drift30_mean_pct']:10.2f} {r['drift30_median_pct']:7.2f} "
            f"{r['drift30_p90_pct']:6.2f} {r['drift30_signed_pct']:8.2f} {r['epochs']:4}",
            flush=True,
        )
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "experiments_drift.json").write_text(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
