"""
Train the motion-state classifier (Phase 13, Model 2).

    python ml/train_motion.py

Writes ml/results/motion_model.pt, motion_metrics.json and motion_confusion.png.

★ WHAT IS BEING MEASURED, AND WHAT IS NOT ★

Accuracy is the wrong headline here and is reported only because its absence
would look evasive. 63 % of the windows are STRAIGHT, so a model that answers
STRAIGHT to everything scores 63 % and is worthless — it would never fire a
ZUPT and never reject a pothole. The number that matters is MACRO F1: the mean
of the per-class F1 scores, which weights POTHOLE_EVENT at 1.5 % of the data
exactly as heavily as STRAIGHT at 63 %.

The majority-class baseline is computed and printed alongside for that reason.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import MOTION_STATES, PROCESSED, RESULTS, SEED  # noqa: E402
from models.motion_cnn import MotionCNN  # noqa: E402

EPOCHS = 60
BATCH = 256
LR = 2e-3
PATIENCE = 10


def device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def scale(X: np.ndarray, mean: np.ndarray, std: np.ndarray) -> torch.Tensor:
    """(n, time, channels) -> (n, channels, time), normalised."""
    return torch.from_numpy(((X - mean) / std).transpose(0, 2, 1).astype(np.float32))


def per_class(y_true: np.ndarray, y_pred: np.ndarray, n: int) -> list[dict]:
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
                "class": MOTION_STATES[c],
                "support": int((y_true == c).sum()),
                "precision": round(precision, 4),
                "recall": round(recall, 4),
                "f1": round(f1, 4),
            }
        )
    return out


def macro_f1(y_true: np.ndarray, y_pred: np.ndarray, n: int) -> float:
    scores = [c["f1"] for c in per_class(y_true, y_pred, n) if c["support"] > 0]
    return float(np.mean(scores)) if scores else 0.0


def predict(model: nn.Module, X: torch.Tensor, dev: torch.device) -> np.ndarray:
    model.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(X), 1024):
            logits = model(X[i : i + 1024].to(dev))
            out.append(logits.argmax(dim=1).cpu().numpy())
    return np.concatenate(out) if out else np.empty(0, dtype=np.int64)


def main() -> None:
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    RESULTS.mkdir(parents=True, exist_ok=True)

    npz = np.load(PROCESSED / "motion_windows.npz", allow_pickle=True)
    mean, std = npz["scaler_mean"], npz["scaler_std"]
    n_classes = len(MOTION_STATES)

    Xtr = scale(npz["X_train"], mean, std)
    ytr = torch.from_numpy(npz["y_train"])
    Xva = scale(npz["X_val"], mean, std)
    yva = npz["y_val"]
    Xte = scale(npz["X_test"], mean, std)
    yte = npz["y_test"]

    dev = device()
    model = MotionCNN(n_classes=n_classes).to(dev)
    print(f"\nMotionCNN — {model.n_params} parameters on {dev}")
    print(f"  train {len(Xtr)}   val {len(Xva)}   test {len(Xte)}\n")

    # ★ CLASS WEIGHTS, SQUARE-ROOT DAMPED ★
    # Straight inverse frequency would weight POTHOLE_EVENT forty times
    # STRAIGHT, and the model then predicts potholes constantly — trading a
    # useless majority classifier for a useless minority one. The square root
    # is the usual compromise and it is a choice, so it is written down.
    counts = np.bincount(npz["y_train"], minlength=n_classes).astype(np.float64)
    weights = np.sqrt(counts.sum() / np.maximum(counts, 1))
    weights = weights / weights.mean()
    criterion = nn.CrossEntropyLoss(weight=torch.tensor(weights, dtype=torch.float32).to(dev))

    opt = torch.optim.Adam(model.parameters(), lr=LR)
    sched = torch.optim.lr_scheduler.ReduceLROnPlateau(opt, mode="max", factor=0.5, patience=4)
    loader = DataLoader(TensorDataset(Xtr, ytr), batch_size=BATCH, shuffle=True)

    best = {"macro_f1": -1.0, "epoch": -1, "state": None}
    history = []

    for epoch in range(EPOCHS):
        model.train()
        total = 0.0
        for xb, yb in loader:
            xb, yb = xb.to(dev), yb.to(dev)
            opt.zero_grad()
            loss = criterion(model(xb), yb)
            loss.backward()
            opt.step()
            total += loss.item() * len(xb)

        val_pred = predict(model, Xva, dev)
        f1 = macro_f1(yva, val_pred, n_classes)
        sched.step(f1)
        history.append({"epoch": epoch, "loss": total / len(Xtr), "val_macro_f1": f1})

        if f1 > best["macro_f1"]:
            best = {
                "macro_f1": f1,
                "epoch": epoch,
                "state": {k: v.detach().cpu().clone() for k, v in model.state_dict().items()},
            }
        if epoch - best["epoch"] >= PATIENCE:
            print(f"  early stop at epoch {epoch} (best {best['epoch']})")
            break
        if epoch % 5 == 0:
            print(f"  epoch {epoch:3d}  loss {total / len(Xtr):.4f}  val macro-F1 {f1:.4f}")

    assert best["state"] is not None
    model.load_state_dict(best["state"])

    test_pred = predict(model, Xte, dev)
    test_f1 = macro_f1(yte, test_pred, n_classes)
    accuracy = float((test_pred == yte).mean())

    # The baseline that makes the accuracy figure interpretable.
    majority = int(np.bincount(npz["y_train"], minlength=n_classes).argmax())
    majority_acc = float((yte == majority).mean())
    majority_f1 = macro_f1(yte, np.full_like(yte, majority), n_classes)

    confusion = np.zeros((n_classes, n_classes), dtype=int)
    for t, p in zip(yte, test_pred):
        confusion[t, p] += 1

    rows = per_class(yte, test_pred, n_classes)
    print(f"\n  test accuracy   {accuracy:.4f}   (majority-class baseline {majority_acc:.4f})")
    print(f"  test macro-F1   {test_f1:.4f}   (majority-class baseline {majority_f1:.4f})\n")
    print(f"  {'class':16} {'support':>8} {'prec':>7} {'recall':>7} {'F1':>7}")
    for r in rows:
        print(
            f"  {r['class']:16} {r['support']:8d} {r['precision']:7.3f} "
            f"{r['recall']:7.3f} {r['f1']:7.3f}"
        )

    metrics = {
        "params": model.n_params,
        "epochs_trained": len(history),
        "best_epoch": best["epoch"],
        "val_macro_f1": round(best["macro_f1"], 4),
        "test_accuracy": round(accuracy, 4),
        "test_macro_f1": round(test_f1, 4),
        "majority_baseline_accuracy": round(majority_acc, 4),
        "majority_baseline_macro_f1": round(majority_f1, 4),
        "per_class": rows,
        "confusion": confusion.tolist(),
        "classes": MOTION_STATES,
        "history": history,
    }
    (RESULTS / "motion_metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    torch.save({"state_dict": model.state_dict()}, RESULTS / "motion_model.pt")

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        norm = confusion / np.maximum(1, confusion.sum(axis=1, keepdims=True))
        fig, ax = plt.subplots(figsize=(7.5, 6.5))
        im = ax.imshow(norm, cmap="Blues", vmin=0, vmax=1)
        ax.set_xticks(range(n_classes), MOTION_STATES, rotation=45, ha="right", fontsize=8)
        ax.set_yticks(range(n_classes), MOTION_STATES, fontsize=8)
        ax.set_xlabel("predicted")
        ax.set_ylabel("actual")
        ax.set_title(f"Motion state — held-out journeys\nmacro-F1 {test_f1:.3f}", fontsize=11)
        for i in range(n_classes):
            for j in range(n_classes):
                if norm[i, j] > 0.005:
                    ax.text(
                        j,
                        i,
                        f"{norm[i, j]:.2f}",
                        ha="center",
                        va="center",
                        fontsize=7,
                        color="white" if norm[i, j] > 0.5 else "black",
                    )
        fig.colorbar(im, ax=ax, fraction=0.046)
        fig.tight_layout()
        fig.savefig(RESULTS / "motion_confusion.png", dpi=140)
        print(f"\n  wrote {RESULTS / 'motion_confusion.png'}")
    except Exception as err:  # noqa: BLE001
        print(f"  (no confusion plot: {err})")

    print(f"  wrote {RESULTS / 'motion_metrics.json'}")
    print(f"  wrote {RESULTS / 'motion_model.pt'}\n")


if __name__ == "__main__":
    main()
