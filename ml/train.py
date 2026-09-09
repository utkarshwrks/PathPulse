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
from config import PROCESSED, RESULTS, SAMPLE_RATE_HZ, SEED, WINDOW_STRIDE  # noqa: E402
from models.speed_cnn import SpeedCNN, ridge_baseline  # noqa: E402


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)


# One window per WINDOW_STRIDE samples, so this many windows span 30 seconds —
# the outage length the published position results report.
DRIFT_BLOCK = int(30 * SAMPLE_RATE_HZ / WINDOW_STRIDE)


def blocks_for(ids: np.ndarray, block: int, stride: int = 1) -> np.ndarray:
    """Start index of every contiguous WITHIN-SEQUENCE run of `block` windows.

    Crossing a sequence boundary would splice the end of one journey onto the
    start of another and score the join as model error.
    """
    starts: list[int] = []
    n = len(ids)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and ids[j + 1] == ids[i]:
            j += 1
        starts.extend(range(i, j - block + 2, stride))
        i = j + 1
    return np.array(starts, dtype=np.int64)


def drift_metrics(pred: np.ndarray, true: np.ndarray, ids: np.ndarray) -> dict[str, float]:
    """Distance error over contiguous 30 s stretches, as a percentage.

    ★ MAE IS NOT WHAT A DEAD-RECKONING SYSTEM PAYS FOR ★

    The engine INTEGRATES this model's output. Over a 30 s outage a zero-mean
    3 m/s error largely cancels; a 1 m/s BIAS does not — it is 30 metres of
    invented distance, every time, and it is what puts the marker in a field.
    MAE scores those two models identically, and the difference between them is
    the entire difference between a navigation system that works and one that
    does not.

    That is not hypothetical here. The model this replaced scored a respectable
    2.909 m/s MAE while over-stating distance by 13.5 % on every 30 s stretch of
    a held-out journey. Nothing in the old metrics could see it.
    """
    starts = blocks_for(ids, DRIFT_BLOCK)
    if len(starts) == 0:
        return {}
    idx = starts[:, None] + np.arange(DRIFT_BLOCK)[None, :]
    dt = WINDOW_STRIDE / SAMPLE_RATE_HZ
    d_pred = pred[idx].sum(axis=1) * dt
    d_true = true[idx].sum(axis=1) * dt
    # A stretch that barely moved has no meaningful percentage: dividing a
    # small absolute error by a near-zero distance manufactures a huge one.
    moving = d_true > 30.0
    if not moving.any():
        return {}
    err = d_pred[moving] - d_true[moving]
    pct = np.abs(err) / d_true[moving] * 100
    return {
        "drift30_mean_pct": float(pct.mean()),
        "drift30_median_pct": float(np.median(pct)),
        "drift30_p90_pct": float(np.percentile(pct, 90)),
        # SIGNED, and reported separately, because a model that is 10 % long
        # and one that is 10 % short have the same mean and are different bugs.
        "drift30_signed_pct": float((err / d_true[moving]).mean() * 100),
        "blocks": int(moving.sum()),
    }


def metrics(pred: np.ndarray, true: np.ndarray, ids: np.ndarray | None = None) -> dict[str, float]:
    err = pred - true
    ss_res = float((err**2).sum())
    ss_tot = float(((true - true.mean()) ** 2).sum())
    out = {
        "mae_mps": float(np.abs(err).mean()),
        "rmse_mps": float(np.sqrt((err**2).mean())),
        "r2": 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan"),
        "mae_kph": float(np.abs(err).mean() * 3.6),
        "bias_mps": float(err.mean()),
        # The one case a navigation system must not get wrong: a phantom 5 m/s
        # at a red light integrates into a hundred metres of imaginary travel,
        # and an aggregate MAE hides it entirely.
        "mae_stopped_mps": float(np.abs(err[true < 0.5]).mean()) if (true < 0.5).any() else 0.0,
    }
    if ids is not None:
        out.update(drift_metrics(pred, true, ids))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--batch-size", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--patience", type=int, default=10)
    ap.add_argument(
        "--heteroscedastic",
        action="store_true",
        help=(
            "Predict log-variance alongside the mean, under Gaussian NLL. "
            "Phase 2, 2.2 — a model that cannot be down-weighted is a model "
            "that has to be right."
        ),
    )
    ap.add_argument(
        "--out",
        type=str,
        default="model.pt",
        help="Filename under ml/results/, so a variance run does not overwrite the shipped one.",
    )
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
    s_va, s_te = npz["s_val"], npz["s_test"]

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = SpeedCNN(heteroscedastic=args.heteroscedastic).to(device)
    print(f"SpeedCNN {model.n_params} params on {device}")
    print(f"train {tuple(Xtr.shape)}  val {tuple(Xva.shape)}  test {tuple(Xte.shape)}\n")

    # Huber rather than MSE: a few windows sit right where the vehicle brakes
    # hard, and MSE would let those dominate the gradient.
    huber = nn.HuberLoss(delta=1.0)

    def gaussian_nll(out: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        """Negative log-likelihood of a Gaussian the model parameterises itself.

        ★ THE LOSS THAT MAKES UNCERTAINTY MEAN SOMETHING ★

            L = 0.5 * ( log_var + (y - mu)^2 / exp(log_var) )

        The second term is a squared error the model may DIVIDE by its own
        predicted variance, which is the whole mechanism: on a window it cannot
        read, inflating the variance buys down the error term. The first term
        is what stops it inflating everything — variance is only worth claiming
        where it is genuinely earned.

        Clamped, because the failure mode is degenerate rather than
        approximate: a model that drives log_var to minus infinity on the
        windows it happens to fit divides by zero and takes the gradient with
        it. -6 is a sigma of 5 cm and 6 is 20 m/s, and nothing outside that is
        a claim about road speed.
        """
        mu = out[:, 0]
        log_var = out[:, 1].clamp(-6.0, 6.0)
        return 0.5 * (log_var + (target - mu) ** 2 / log_var.exp()).mean()

    def loss_fn(out: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        return gaussian_nll(out, target) if args.heteroscedastic else huber(out, target)

    def mean_of(out: torch.Tensor) -> torch.Tensor:
        return out[:, 0] if args.heteroscedastic else out
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
            val_out = model(Xva.to(device)).cpu()
            val_loss = loss_fn(val_out, yva).item()
            val_pred = mean_of(val_out)
        sched.step()

        m = metrics(np.clip(val_pred.numpy(), 0, None), yva.numpy(), s_va)
        history.append({"epoch": epoch, "train_loss": train_loss, "val_loss": val_loss, **m})

        # ★ STOPPED ON DRIFT, NOT ON LOSS ★
        #
        # Selecting the epoch with the lowest validation loss selects the model
        # with the best per-window score, which is NOT the model that drifts
        # least — and the gap between those two is not small. Trained
        # identically and stopped on loss, the previous model reached a
        # respectable 2.909 m/s MAE while over-stating distance by 13.5 % on
        # every 30 s stretch of a held-out journey. Stopping on the integrated
        # error instead lands on a nearly unbiased epoch: signed drift -0.8 %,
        # mean 30 s drift 24.1 % -> 19.8 %, p90 54.1 % -> 39.9 %.
        #
        # Loss is still recorded every epoch — it is the number to look at when
        # the training itself has gone wrong — it just no longer chooses.
        score = m.get("drift30_mean_pct", m["mae_mps"])
        flag = ""
        if score < best_val - 1e-4:
            best_val, bad_epochs = score, 0
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            flag = " *"
        else:
            bad_epochs += 1
        if epoch % 5 == 0 or flag or epoch == 1:
            print(
                f"  epoch {epoch:>3}  train {train_loss:.4f}  val {val_loss:.4f}  "
                f"MAE {m['mae_mps']:.3f}  drift30 {score:5.2f}%  "
                f"signed {m.get('drift30_signed_pct', float('nan')):+6.2f}%{flag}"
            )
        if bad_epochs >= args.patience:
            print(f"  early stop at epoch {epoch} — no drift improvement for {args.patience}")
            break

    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        te_out = model(Xte.to(device)).cpu().numpy()
    te_cnn = te_out[:, 0] if args.heteroscedastic else te_out
    cnn_m = metrics(np.clip(te_cnn, 0, None), yte.numpy(), s_te)

    # ★ IS THE UNCERTAINTY WORTH ANYTHING? ★
    #
    # A variance head that is merely present proves nothing. The claim it has
    # to earn is that predicted sigma CORRELATES with actual error — that the
    # windows it says it cannot read are the windows it gets wrong. Reported
    # as the error on the most-confident and least-confident deciles: if they
    # are the same number, the head has learned to emit a constant and
    # shipping it is worse than the gate it replaces.
    unc = None
    if args.heteroscedastic:
        sigma = np.exp(0.5 * np.clip(te_out[:, 1], -6.0, 6.0))
        err = np.abs(np.clip(te_cnn, 0, None) - yte.numpy())
        order = np.argsort(sigma)
        d = max(1, len(order) // 10)
        unc = {
            "sigma_p10": float(np.quantile(sigma, 0.1)),
            "sigma_p50": float(np.quantile(sigma, 0.5)),
            "sigma_p90": float(np.quantile(sigma, 0.9)),
            "mae_most_confident_decile": float(err[order[:d]].mean()),
            "mae_least_confident_decile": float(err[order[-d:]].mean()),
            "spearman_sigma_vs_error": float(
                np.corrcoef(np.argsort(np.argsort(sigma)), np.argsort(np.argsort(err)))[0, 1]
            ),
        }
        print(
            f"\n  uncertainty head: sigma p10 {unc['sigma_p10']:.2f} "
            f"p50 {unc['sigma_p50']:.2f} p90 {unc['sigma_p90']:.2f} m/s"
        )
        print(
            f"  MAE on most-confident decile {unc['mae_most_confident_decile']:.3f} "
            f"vs least-confident {unc['mae_least_confident_decile']:.3f} m/s "
            f"(rank corr {unc['spearman_sigma_vs_error']:.3f})"
        )

    # ── Baselines ────────────────────────────────────────────────────────────
    ridge = ridge_baseline()
    ridge.fit(npz["F_train"], npz["y_train"])
    ridge_m = metrics(np.clip(ridge.predict(npz["F_test"]), 0, None), yte.numpy(), s_te)

    # The dumbest thing that could work: always answer the training mean.
    # If a model cannot beat this it has learned nothing at all.
    const_m = metrics(np.full_like(yte.numpy(), float(ytr.mean())), yte.numpy(), s_te)

    print(f"\n  trained in {time.time()-t0:.1f}s over {len(history)} epochs\n")
    print(
        f"  {'model':<22}{'MAE m/s':>9}{'RMSE':>8}{'R2':>7}{'bias':>8}"
        f"{'stopped':>9}{'drift30%':>10}{'signed%':>9}"
    )
    for name, m in (("constant (mean)", const_m), ("ridge (42 stats)", ridge_m), ("SpeedCNN", cnn_m)):
        print(
            f"  {name:<22}{m['mae_mps']:>9.3f}{m['rmse_mps']:>8.3f}{m['r2']:>7.3f}"
            f"{m['bias_mps']:>8.3f}{m['mae_stopped_mps']:>9.3f}"
            f"{m.get('drift30_mean_pct', float('nan')):>10.2f}"
            f"{m.get('drift30_signed_pct', float('nan')):>9.2f}"
        )

    torch.save(
        {
            "state_dict": model.state_dict(),
            "n_params": model.n_params,
            "heteroscedastic": args.heteroscedastic,
        },
        RESULTS / args.out,
    )
    (RESULTS / (args.out.replace(".pt", "_metrics.json"))).write_text(
        json.dumps(
            {
                "epochs_run": len(history),
                "best_val_drift30_pct": best_val,
                "n_params": model.n_params,
                "test": {"cnn": cnn_m, "ridge": ridge_m, "constant": const_m},
                "heteroscedastic": args.heteroscedastic,
                "uncertainty": unc,
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
    fig.savefig(RESULTS / args.out.replace(".pt", "_curves.png"), dpi=150)
    print(f"\n✔ {RESULTS/args.out}, curves and metrics beside it")


if __name__ == "__main__":
    main()
