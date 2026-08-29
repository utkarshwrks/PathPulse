"""
Train the speed regressor and its baseline (Phase 8, step 8A-2/8A-4).

    python ml/train.py [--epochs 50]

Writes ml/results/{model.pt, training_curves.png, train_metrics.json}.
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import PROCESSED, RESULTS, SEED  # noqa: E402
from models.speed_cnn import SpeedCNN, ridge_baseline  # noqa: E402


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)


def metrics(pred: np.ndarray, true: np.ndarray) -> dict[str, float]:
    err = pred - true
    ss_res = float((err**2).sum())
    ss_tot = float(((true - true.mean()) ** 2).sum())
    return {
        "mae_mps": float(np.abs(err).mean()),
        "rmse_mps": float(np.sqrt((err**2).mean())),
        "r2": 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan"),
        "mae_kph": float(np.abs(err).mean() * 3.6),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--batch-size", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--patience", type=int, default=10)
    args = ap.parse_args()

    seed_everything(SEED)
    RESULTS.mkdir(parents=True, exist_ok=True)

    npz = np.load(PROCESSED / "windows.npz")
    # (n, time, channels) -> (n, channels, time), which is what Conv1d wants.
    Xtr = torch.tensor(npz["X_train"]).permute(0, 2, 1)
    ytr = torch.tensor(npz["y_train"])
    Xva = torch.tensor(npz["X_val"]).permute(0, 2, 1)
    yva = torch.tensor(npz["y_val"])
    Xte = torch.tensor(npz["X_test"]).permute(0, 2, 1)
    yte = torch.tensor(npz["y_test"])

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = SpeedCNN().to(device)
    print(f"SpeedCNN {model.n_params} params on {device}")
    print(f"train {tuple(Xtr.shape)}  val {tuple(Xva.shape)}  test {tuple(Xte.shape)}\n")

    # Huber rather than MSE: a few windows sit right where the vehicle brakes
    # hard, and MSE would let those dominate the gradient.
    loss_fn = nn.HuberLoss(delta=1.0)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)

    ds = torch.utils.data.TensorDataset(Xtr, ytr)
    loader = torch.utils.data.DataLoader(
        ds, batch_size=args.batch_size, shuffle=True, generator=torch.Generator().manual_seed(SEED)
    )

    history: list[dict] = []
    best_val, best_state, bad_epochs = float("inf"), None, 0
    t0 = time.time()

    for epoch in range(1, args.epochs + 1):
        model.train()
        running = 0.0
        for xb, yb in loader:
            xb, yb = xb.to(device), yb.to(device)
            opt.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            opt.step()
            running += loss.item() * len(xb)
        train_loss = running / len(ds)

        model.eval()
        with torch.no_grad():
            val_pred = model(Xva.to(device)).cpu()
            val_loss = loss_fn(val_pred, yva).item()
        sched.step()

        m = metrics(val_pred.numpy(), yva.numpy())
        history.append({"epoch": epoch, "train_loss": train_loss, "val_loss": val_loss, **m})

        flag = ""
        if val_loss < best_val - 1e-5:
            best_val, bad_epochs = val_loss, 0
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            flag = " *"
        else:
            bad_epochs += 1
        if epoch % 5 == 0 or flag or epoch == 1:
            print(
                f"  epoch {epoch:>3}  train {train_loss:.4f}  val {val_loss:.4f}  "
                f"val MAE {m['mae_mps']:.3f} m/s ({m['mae_kph']:.2f} km/h)  R2 {m['r2']:.3f}{flag}"
            )
        if bad_epochs >= args.patience:
            print(f"  early stop at epoch {epoch} — no val improvement for {args.patience}")
            break

    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        te_cnn = model(Xte.to(device)).cpu().numpy()
    cnn_m = metrics(np.clip(te_cnn, 0, None), yte.numpy())

    # ── Baselines ────────────────────────────────────────────────────────────
    ridge = ridge_baseline()
    ridge.fit(npz["F_train"], npz["y_train"])
    ridge_m = metrics(np.clip(ridge.predict(npz["F_test"]), 0, None), yte.numpy())

    # The dumbest thing that could work: always answer the training mean.
    # If a model cannot beat this it has learned nothing at all.
    const_m = metrics(np.full_like(yte.numpy(), float(ytr.mean())), yte.numpy())

    print(f"\n  trained in {time.time()-t0:.1f}s over {len(history)} epochs\n")
    print(f"  {'model':<22}{'MAE m/s':>10}{'RMSE m/s':>10}{'R2':>8}{'MAE km/h':>10}")
    for name, m in (("constant (mean)", const_m), ("ridge (42 stats)", ridge_m), ("SpeedCNN", cnn_m)):
        print(f"  {name:<22}{m['mae_mps']:>10.3f}{m['rmse_mps']:>10.3f}{m['r2']:>8.3f}{m['mae_kph']:>10.2f}")

    torch.save({"state_dict": model.state_dict(), "n_params": model.n_params}, RESULTS / "model.pt")
    (RESULTS / "train_metrics.json").write_text(
        json.dumps(
            {
                "epochs_run": len(history),
                "best_val_loss": best_val,
                "n_params": model.n_params,
                "test": {"cnn": cnn_m, "ridge": ridge_m, "constant": const_m},
                "history": history,
            },
            indent=2,
        )
    )

    # ── Curves ───────────────────────────────────────────────────────────────
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, (a1, a2) = plt.subplots(1, 2, figsize=(11, 4))
    ep = [h["epoch"] for h in history]
    a1.plot(ep, [h["train_loss"] for h in history], label="train")
    a1.plot(ep, [h["val_loss"] for h in history], label="validation")
    a1.set_xlabel("epoch"); a1.set_ylabel("Huber loss"); a1.set_title("Training curve")
    a1.legend(); a1.grid(alpha=0.3)
    a2.plot(ep, [h["mae_mps"] for h in history], color="tab:red")
    a2.set_xlabel("epoch"); a2.set_ylabel("validation MAE (m/s)")
    a2.set_title("Validation speed error"); a2.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(RESULTS / "training_curves.png", dpi=150)
    print(f"\n✔ {RESULTS/'model.pt'}, training_curves.png, train_metrics.json")


if __name__ == "__main__":
    main()
