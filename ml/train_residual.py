"""
Train the drift-residual corrector (Phase 13, Model 3).

    pnpm eval:drift-dataset        # writes ml/data/processed/drift_rows.csv
    python ml/train_residual.py

★ WHAT THIS MODEL IS ★
The problem statement's third AI slot: "AI based fusion model to mitigate drift
errors". It reads eleven numbers the engine already knows during an outage —
time since GNSS, speed, distance, covariance, turns, ZUPTs, bias estimates,
whether a road is matched — and predicts the estimate's own error, along and
across the direction of travel. The engine subtracts it.

★ THE SPLIT IS THE EXPERIMENT ★
A residual corrector's failure mode is learning the ROUTE rather than the
physics, then mis-correcting confidently on a road it has never seen. Trained
and tested on the same drives it would look excellent and mean nothing. So the
split is ROUTE-DISJOINT — every city outage against every highway outage — and
it is run BOTH WAYS, because a model that helps in one direction and hurts in
the other has told you it memorised.

The baseline is predicting zero, which is exactly what the engine does today.
A model that cannot beat "do nothing" is a model that should not ship, and
saying so with a number is worth more than shipping it quietly.

★ AND THE CAVEAT, WHICH IS LARGE ★
Every log here is SIMULATED. This measures whether the model generalises across
route types within one simulator. It does not measure whether it generalises to
a real vehicle, and nothing here should be claimed as if it did.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import PROCESSED, RESULTS, SEED  # noqa: E402

EPOCHS = 40
BATCH = 1024
LR = 3e-3
PATIENCE = 6
HIDDEN = 32


class ResidualMLP(nn.Module):
    """Eleven features in, two metres out. 1,442 parameters.

    Small on purpose. The signal being learned is a smooth function of a few
    physical quantities — error grows with time, with speed, with turns — and a
    larger network on 188k rows from four simulated drives would fit the drives.
    """

    def __init__(self, n_features: int, hidden: int = HIDDEN) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(n_features, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, 2),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def load_rows() -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    path = PROCESSED / "drift_rows.csv"
    if not path.exists():
        raise SystemExit(f"no {path} — run `pnpm eval:drift-dataset` first")
    raw = np.genfromtxt(path, delimiter=",", names=True, dtype=None, encoding="utf-8")
    names = list(raw.dtype.names)
    feature_names = [n for n in names if n not in ("log", "t", "alongM", "crossM")]
    X = np.column_stack([raw[n].astype(np.float64) for n in feature_names])
    y = np.column_stack([raw["alongM"].astype(np.float64), raw["crossM"].astype(np.float64)])
    logs = np.array([str(v) for v in raw["log"]])
    return X, y, logs, feature_names


def train_once(
    Xtr: np.ndarray, ytr: np.ndarray, Xte: np.ndarray, yte: np.ndarray, seed: int
) -> tuple[nn.Module, dict, np.ndarray, np.ndarray]:
    torch.manual_seed(seed)
    mean, std = Xtr.mean(axis=0), Xtr.std(axis=0)
    std[std == 0] = 1.0

    xtr = torch.tensor((Xtr - mean) / std, dtype=torch.float32)
    ttr = torch.tensor(ytr, dtype=torch.float32)
    xte = torch.tensor((Xte - mean) / std, dtype=torch.float32)

    # A tail of the training set for early stopping. It is the same route type,
    # so it says nothing about generalisation — that is what the held-out route
    # is for — but it is enough to stop before the model starts memorising.
    cut = int(len(xtr) * 0.85)
    xva, tva = xtr[cut:], ttr[cut:]
    xtr, ttr = xtr[:cut], ttr[:cut]

    model = ResidualMLP(Xtr.shape[1])
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    criterion = nn.SmoothL1Loss()  # Huber: outage tails produce genuine outliers

    best = {"loss": float("inf"), "epoch": -1, "state": None}
    for epoch in range(EPOCHS):
        model.train()
        perm = torch.randperm(len(xtr))
        for i in range(0, len(xtr), BATCH):
            idx = perm[i : i + BATCH]
            opt.zero_grad()
            criterion(model(xtr[idx]), ttr[idx]).backward()
            opt.step()

        model.eval()
        with torch.no_grad():
            val = criterion(model(xva), tva).item()
        if val < best["loss"]:
            best = {
                "loss": val,
                "epoch": epoch,
                "state": {k: v.clone() for k, v in model.state_dict().items()},
            }
        if epoch - best["epoch"] >= PATIENCE:
            break

    assert best["state"] is not None
    model.load_state_dict(best["state"])
    model.eval()
    with torch.no_grad():
        pred = model(xte).numpy()

    return model, {"mean": mean, "std": std, "best_epoch": best["epoch"]}, pred, yte


def clamp_like_engine(pred: np.ndarray, cov_along: np.ndarray, cov_cross: np.ndarray) -> np.ndarray:
    """Apply the same bound `clampResidual` applies on the phone.

    The engine never trusts a raw prediction: the correction is capped at the
    estimator's OWN stated uncertainty, and at 50 m absolutely. That bound is
    the difference between a bad model degrading the estimate and a bad model
    destroying it, so the evaluation has to measure the bounded version — it is
    what would actually ship.
    """
    lim_a = np.minimum(50.0, np.maximum(0.0, cov_along))
    lim_c = np.minimum(50.0, np.maximum(0.0, cov_cross))
    out = pred.copy()
    out[:, 0] = np.clip(out[:, 0], -lim_a, lim_a)
    out[:, 1] = np.clip(out[:, 1], -lim_c, lim_c)
    return out


def report(name: str, pred: np.ndarray, truth: np.ndarray) -> dict:
    """MAE with the correction, against MAE with no correction at all."""
    corrected = np.abs(truth - pred)
    baseline = np.abs(truth)
    out = {
        "split": name,
        "rows": int(len(truth)),
        "along_mae_baseline": round(float(baseline[:, 0].mean()), 3),
        "along_mae_model": round(float(corrected[:, 0].mean()), 3),
        "cross_mae_baseline": round(float(baseline[:, 1].mean()), 3),
        "cross_mae_model": round(float(corrected[:, 1].mean()), 3),
    }
    out["along_improvement_pct"] = round(
        100 * (out["along_mae_baseline"] - out["along_mae_model"]) / max(1e-9, out["along_mae_baseline"]), 1
    )
    out["cross_improvement_pct"] = round(
        100 * (out["cross_mae_baseline"] - out["cross_mae_model"]) / max(1e-9, out["cross_mae_baseline"]), 1
    )
    print(
        f"  {name:28} along {out['along_mae_baseline']:7.2f} -> {out['along_mae_model']:7.2f} m "
        f"({out['along_improvement_pct']:+6.1f}%)   "
        f"cross {out['cross_mae_baseline']:6.2f} -> {out['cross_mae_model']:6.2f} m "
        f"({out['cross_improvement_pct']:+6.1f}%)"
    )
    return out


def main() -> None:
    np.random.seed(SEED)
    RESULTS.mkdir(parents=True, exist_ok=True)

    X, y, logs, feature_names = load_rows()
    print(f"\n  {len(X)} rows, {X.shape[1]} features: {', '.join(feature_names)}\n")

    city = np.char.find(logs, "city") >= 0
    highway = ~city
    if city.sum() == 0 or highway.sum() == 0:
        raise SystemExit("need both city and highway logs for a route-disjoint split")

    print("  ROUTE-DISJOINT, BOTH DIRECTIONS")
    print("  a model that helps one way and hurts the other has memorised the route\n")

    ia = feature_names.index("covarianceAlongM")
    ic = feature_names.index("covarianceCrossM")

    _, _, pred_h, truth_h = train_once(X[city], y[city], X[highway], y[highway], SEED)
    a = report("train city -> test highway", pred_h, truth_h)

    _, _, pred_c, truth_c = train_once(X[highway], y[highway], X[city], y[city], SEED)
    b = report("train highway -> test city", pred_c, truth_c)

    print("\n  the same, bounded as the engine bounds it (clampResidual)\n")
    a_clamped = report(
        "  city -> highway, clamped",
        clamp_like_engine(pred_h, X[highway][:, ia], X[highway][:, ic]),
        truth_h,
    )
    b_clamped = report(
        "  highway -> city, clamped",
        clamp_like_engine(pred_c, X[city][:, ia], X[city][:, ic]),
        truth_c,
    )

    generalises = (
        a["along_improvement_pct"] > 0
        and b["along_improvement_pct"] > 0
        and a["cross_improvement_pct"] > 0
        and b["cross_improvement_pct"] > 0
    )
    print(
        f"\n  VERDICT: {'improves in both directions' if generalises else 'DOES NOT generalise across route types'}"
    )

    # The shipped model, if any, is trained on everything — but only after the
    # honest split above has decided whether shipping it is defensible.
    model, meta, _, _ = train_once(X, y, X[:1], y[:1], SEED)

    metrics = {
        "features": feature_names,
        "rows": int(len(X)),
        "params": sum(p.numel() for p in model.parameters()),
        "route_disjoint": [a, b],
        "route_disjoint_clamped": [a_clamped, b_clamped],
        "generalises": bool(generalises),
        "caveat": (
            "Every log is SIMULATED. This measures generalisation across route types "
            "within one simulator, not to a real vehicle."
        ),
    }
    (RESULTS / "residual_metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    torch.save(
        {"state_dict": model.state_dict(), "mean": meta["mean"], "std": meta["std"]},
        RESULTS / "residual_model.pt",
    )
    print(f"\n  wrote {RESULTS / 'residual_metrics.json'}")
    print(f"  wrote {RESULTS / 'residual_model.pt'}\n")


if __name__ == "__main__":
    main()
