"""
Train the GNSS quality classifier (Phase 13, Model 4).

    pnpm eval:gnss-dataset          # writes ml/data/processed/gnss_quality_rows.csv
    python ml/train_gnss_quality.py

★ WHAT THIS MODEL ADDS OVER THE RULES IT SITS BESIDE ★

Phase 9D's SpoofingDetector is three hand-written rules, each a statement about
physics a judge can read and check. It ships enabled and stays.

What three thresholds cannot do is combine weak evidence. Multipath in an urban
canyon trips none of them individually: the satellite count is a little low,
the C/N0 a little poor, the fix jitters a little more, the IMU disagrees a
little. Four "a littles", each under its threshold, and together unmistakable.

★ THE SPLIT IS LOG-DISJOINT ★
Trained on the city logs and tested on the highway ones, and the other way
round. The corruptions are identical between them, so what the split actually
tests is whether the model learned the CORRUPTION or the ROUTE — and a model
that learned the route would score well within a log and badly across.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import GNSS_QUALITY_CLASSES, PROCESSED, RESULTS, SEED  # noqa: E402

EPOCHS = 120
BATCH = 256
LR = 3e-3
PATIENCE = 15
HIDDEN = 24


class GnssQualityMLP(nn.Module):
    """Eleven features in, four classes out. About 750 parameters.

    Small deliberately. The relationships being learned are near-linear
    separations in a low-dimensional, physically-meaningful space — "few
    satellites AND poor C/N0 AND large jump" — and a larger network on 2,504
    rows from four simulated routes would fit the routes.
    """

    def __init__(self, n_features: int, n_classes: int, hidden: int = HIDDEN) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(n_features, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, n_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def load_rows():
    path = PROCESSED / "gnss_quality_rows.csv"
    if not path.exists():
        raise SystemExit(f"no {path} — run `pnpm eval:gnss-dataset` first")
    raw = np.genfromtxt(path, delimiter=",", names=True, dtype=None, encoding="utf-8")
    names = list(raw.dtype.names)
    features = [n for n in names if n not in ("log", "label")]
    X = np.column_stack([raw[n].astype(np.float64) for n in features])
    index = {c: i for i, c in enumerate(GNSS_QUALITY_CLASSES)}
    y = np.array([index[str(v)] for v in raw["label"]], dtype=np.int64)
    logs = np.array([str(v) for v in raw["log"]])
    return X, y, logs, features


def per_class(y_true, y_pred, n):
    out = []
    for c in range(n):
        tp = int(((y_pred == c) & (y_true == c)).sum())
        fp = int(((y_pred == c) & (y_true != c)).sum())
        fn = int(((y_pred != c) & (y_true == c)).sum())
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        out.append(
            {
                "class": GNSS_QUALITY_CLASSES[c],
                "support": int((y_true == c).sum()),
                "precision": round(precision, 4),
                "recall": round(recall, 4),
                "f1": round(f1, 4),
            }
        )
    return out


def train_once(Xtr, ytr, Xte, seed):
    torch.manual_seed(seed)
    mean, std = Xtr.mean(axis=0), Xtr.std(axis=0)
    std[std == 0] = 1.0

    xtr = torch.tensor((Xtr - mean) / std, dtype=torch.float32)
    ttr = torch.tensor(ytr, dtype=torch.long)
    xte = torch.tensor((Xte - mean) / std, dtype=torch.float32)

    cut = int(len(xtr) * 0.85)
    perm = torch.randperm(len(xtr))
    xtr, ttr = xtr[perm], ttr[perm]
    xva, tva = xtr[cut:], ttr[cut:]
    xtr, ttr = xtr[:cut], ttr[:cut]

    model = GnssQualityMLP(Xtr.shape[1], len(GNSS_QUALITY_CLASSES))
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    criterion = nn.CrossEntropyLoss()

    best = {"loss": float("inf"), "epoch": -1, "state": None}
    for epoch in range(EPOCHS):
        model.train()
        order = torch.randperm(len(xtr))
        for i in range(0, len(xtr), BATCH):
            idx = order[i : i + BATCH]
            opt.zero_grad()
            criterion(model(xtr[idx]), ttr[idx]).backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            val = criterion(model(xva), tva).item()
        if val < best["loss"]:
            best = {"loss": val, "epoch": epoch, "state": {k: v.clone() for k, v in model.state_dict().items()}}
        if epoch - best["epoch"] >= PATIENCE:
            break

    model.load_state_dict(best["state"])
    model.eval()
    with torch.no_grad():
        pred = model(xte).argmax(dim=1).numpy()
    return model, {"mean": mean, "std": std}, pred


def report(name, y_true, y_pred):
    n = len(GNSS_QUALITY_CLASSES)
    rows = per_class(y_true, y_pred, n)
    acc = float((y_pred == y_true).mean())
    macro = float(np.mean([r["f1"] for r in rows if r["support"] > 0]))
    print(f"\n  {name}   accuracy {acc:.3f}   macro-F1 {macro:.3f}   (chance {1/n:.3f})")
    print(f"    {'class':12}{'support':>8}{'prec':>8}{'recall':>8}{'F1':>8}")
    for r in rows:
        print(
            f"    {r['class']:12}{r['support']:8d}{r['precision']:8.3f}"
            f"{r['recall']:8.3f}{r['f1']:8.3f}"
        )
    return {"split": name, "accuracy": round(acc, 4), "macro_f1": round(macro, 4), "per_class": rows}


def main() -> None:
    np.random.seed(SEED)
    RESULTS.mkdir(parents=True, exist_ok=True)

    X, y, logs, features = load_rows()
    print(f"\n  {len(X)} rows, {X.shape[1]} features")

    city = np.char.find(logs, "city") >= 0
    highway = ~city
    if city.sum() == 0 or highway.sum() == 0:
        raise SystemExit("need both city and highway logs for a log-disjoint split")

    print("\n  LOG-DISJOINT, BOTH DIRECTIONS")
    _, _, pred_h = train_once(X[city], y[city], X[highway], SEED)
    a = report("train city -> test highway", y[highway], pred_h)
    _, _, pred_c = train_once(X[highway], y[highway], X[city], SEED)
    b = report("train highway -> test city", y[city], pred_c)

    generalises = a["macro_f1"] > 0.7 and b["macro_f1"] > 0.7
    print(
        "\n  ★ READ THIS BEFORE QUOTING THE NUMBER ABOVE ★\n\n"
        "  ~1.00 macro-F1 is NOT evidence that this model works on real GNSS.\n"
        "  It is evidence that four MODELLED failure modes are separable — which\n"
        "  they are, by construction, because the same repository contains the\n"
        "  function that generates them. The classifier has learned that\n"
        "  function, not the physics of an urban canyon.\n\n"
        "  Severity is already randomised so mild cases overlap, and it barely\n"
        "  moves the score: even a mild multipath raises HDOP and C/N0 spread\n"
        "  while a mild spoof lowers both, so the classes stay in distinct\n"
        "  regions however weak the corruption. That is a property of the\n"
        "  generator, and no amount of tuning it turns a synthetic benchmark\n"
        "  into a statement about real multipath.\n\n"
        "  What this DOES establish: the feature contract, the training\n"
        "  pipeline, the export and the engine integration are correct and\n"
        "  ready for real labelled data. The model ships ADVISORY-ONLY and is\n"
        "  never allowed to gate a fix — see detect/spoofing.ts for the long\n"
        "  argument, which applies here with more force, not less.\n\n"
        "  To make this number mean something: drive an urban canyon and a\n"
        "  tunnel mouth with `pnpm eval:record` running, label the passes by\n"
        "  hand, and retrain. That is Phase 18 work."
    )

    model, meta, _ = train_once(X, y, X[:1], SEED)
    metrics = {
        "features": features,
        "classes": GNSS_QUALITY_CLASSES,
        "rows": int(len(X)),
        "params": sum(p.numel() for p in model.parameters()),
        "log_disjoint": [a, b],
        "generalises": bool(generalises),
        "caveat": (
            "~1.00 macro-F1 is NOT evidence this works on real GNSS. Labels are "
            "MODELLED corruptions of real fixes, generated by a function in this "
            "same repository, so the classifier has learned that function rather "
            "than the physics of an urban canyon. Severity is randomised so mild "
            "cases overlap and it barely moves the score, because even a mild "
            "multipath raises HDOP and C/N0 spread while a mild spoof lowers both. "
            "What this establishes is that the feature contract, pipeline, export "
            "and integration are correct and ready for real labelled data. The "
            "model is advisory-only and may never gate a fix."
        ),
        "synthetic_benchmark": True,
    }
    (RESULTS / "gnss_quality_metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    torch.save(
        {
            "state_dict": model.state_dict(),
            # Plain lists, not numpy arrays. torch.load defaults to
            # weights_only=True since 2.6 and refuses to unpickle a numpy
            # reconstruct — so a checkpoint carrying arrays cannot be reloaded
            # by the exporter that has to read it.
            "mean": [float(v) for v in meta["mean"]],
            "std": [float(v) for v in meta["std"]],
        },
        RESULTS / "gnss_quality_model.pt",
    )
    print(f"\n  wrote {RESULTS / 'gnss_quality_metrics.json'}")
    print(f"  wrote {RESULTS / 'gnss_quality_model.pt'}\n")


if __name__ == "__main__":
    main()
