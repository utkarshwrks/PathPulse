"""
★ THE POSITION PLOT — the artefact ISRO requires with the proposal.
(Phase 8, step 8A-3.)

    "Teams are required to include the preliminary AI models and the results of
     the position plot inferenced from the subset of IO-VNBD dataset as part of
     their proposals submitted for evaluation."

Take a test sequence the model has never seen, predict speed from the phone's
IMU alone, dead reckon a trajectory, and compare it to the recorded GPS path.

★ SCORED OVER OUTAGE WINDOWS, NOT THE WHOLE DRIVE. ★

The first version of this script integrated a whole 88-minute sequence in one
go and reported 131 % drift — for the CNN, for the ridge baseline, and for
PERFECT ground-truth speed alike. That last number is the tell: with a speed
error of exactly zero the trajectory was still 131 km from the truth, because
heading was being integrated for 5280 seconds and a yaw-rate bias of 0.001 rad/s
integrates to 300 degrees over that time. The figure was measuring heading
divergence and calling it a speed result.

Dead reckoning is not for 88 minutes. It is for the tunnel, the underpass, the
basement — 30 seconds to 5 minutes. So this samples outage windows of realistic
length across the sequence, re-anchors position and heading at the start of each
(exactly as the engine does when GNSS drops), and reports the distribution. That
is both honest and directly comparable to `pnpm ablation`, which scores the
shipped engine the same way.

    python ml/evaluate_position.py [--sequence Vw02]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "data"))
from config import (  # noqa: E402
    PROCESSED,
    RAW,
    RESULTS,
    SAMPLE_RATE_HZ,
    TEST_SEQUENCES,
    WINDOW_SAMPLES,
)
from models.speed_cnn import SpeedCNN, ridge_baseline  # noqa: E402
from preprocess import load_sequence, statistical_features  # noqa: E402

DT = 1.0 / SAMPLE_RATE_HZ
OUTAGE_SECONDS = [30, 60, 120, 300]
OUTAGE_STRIDE_S = 60


def gps_track(seq: str, n: int):
    """The recorded GPS path as local ENU metres, plus GPS heading and its rate.

    This is the reference every estimate is scored against. Using recorded
    position rather than an integration of recorded speed means the score
    contains nothing we invented.
    """
    rows = list(
        csv.reader(
            io.StringIO((RAW / seq / "vehicle.csv").read_bytes().decode("utf-8", "replace"))
        )
    )[1:][:n]

    def col(i):
        out = []
        for r in rows:
            try:
                out.append(float(r[i]))
            except (ValueError, IndexError):
                out.append(np.nan)
        return np.array(out)

    lat, lon, hdg = col(2), col(3), col(5)
    lat0 = np.nanmean(lat)
    east = (lon - np.nanmean(lon)) * 111_320.0 * np.cos(np.deg2rad(lat0))
    north = (lat - np.nanmean(lat)) * 111_132.0
    rate = np.gradient(np.unwrap(np.deg2rad(hdg))) * SAMPLE_RATE_HZ
    return np.nan_to_num(east), np.nan_to_num(north), np.nan_to_num(hdg), rate


def heading_rate(seq: str, data: dict, n: int):
    """Vehicle heading rate, sign resolved against GPS rather than assumed.

    ★ WHY NOT THE PHONE'S GYROSCOPE, WHICH IS WHAT WE SHIP? ★
    Because in this dataset it does not work. Correlated against GPS-derived
    heading rate over the moving samples, IO-VNBD's smartphone gyroscope tracks
    the vehicle in S1 and S3c and in essentially none of the other 23 sequences
    (|r| < 0.15), under no axis convention that explains the difference — and
    the GRAVITY columns are the constant [0, 0, 9.81] rather than a measurement,
    so the gravity projection nav-core uses cannot even be reconstructed.

    So heading comes from the CAR's yaw sensor, identically for the reference
    and for every estimate. That is deliberate: it makes the speed model the
    only thing that differs between the curves, which is the only claim this
    plot is entitled to make. The phone-gyro yaw path is real and is what runs
    on the handset — it is tested in packages/nav-core/test/attitude.test.ts,
    not here.
    """
    _, _, _, gps_rate = gps_track(seq, n)
    yaw = data["yaw_rate"][:n]
    moving = data["speed"][:n] > 3.0  # GPS heading is noise at a standstill
    ok = np.isfinite(yaw) & np.isfinite(gps_rate) & moving
    corr = float(np.corrcoef(yaw[ok], gps_rate[ok])[0, 1]) if ok.sum() > 200 else float("nan")
    sign = -1 if corr < 0 else 1
    return yaw * sign, abs(corr), sign


def dead_reckon(speed, yaw_rate, heading0):
    """Integrate speed and heading rate from a known anchor into an x/y track.

    No constraints, no map, no filter — this isolates what the SPEED MODEL
    contributes. nav-core's NHC, ZUPT and road snapping would improve every
    curve here and hide the very thing being measured.
    """
    heading = heading0 + np.cumsum(np.nan_to_num(yaw_rate)) * DT
    ds = np.nan_to_num(speed) * DT
    return np.cumsum(ds * np.sin(heading)), np.cumsum(ds * np.cos(heading))


def predict_speed(model, X, mean, std, device):
    Xn = ((X - mean) / std).astype(np.float32)
    with torch.no_grad():
        t = torch.tensor(Xn).permute(0, 2, 1).to(device)
        return np.clip(model(t).cpu().numpy(), 0, None)


def per_sample(windowed, n):
    """A per-window prediction held across the samples it covers.

    Window k ends at its label, so it governs samples
    [k*stride + W-1, (k+1)*stride + W-1). Before the first full window there is
    no prediction; that gap takes the first one rather than zero, which would
    inject a fake standstill at the start of every run.
    """
    out = np.full(n, np.nan)
    stride = WINDOW_SAMPLES // 2
    for k, v in enumerate(windowed):
        a = k * stride + WINDOW_SAMPLES - 1
        if a < n:
            out[a : min(n, a + stride)] = v
    idx = np.flatnonzero(~np.isnan(out))
    if len(idx):
        out[: idx[0]] = out[idx[0]]
        out[idx[-1] + 1 :] = out[idx[-1]]
    return np.nan_to_num(out)


def score_windows(sources, truth_speed, yaw, gx, gy, hdg, m):
    """Drift over every outage window, for every speed source."""
    rows = []
    for dur in OUTAGE_SECONDS:
        w = int(dur * SAMPLE_RATE_HZ)
        step = int(OUTAGE_STRIDE_S * SAMPLE_RATE_HZ)
        for s in range(0, m - w, step):
            e = s + w
            # Distance actually covered, from the reference, not from us.
            travelled = float(np.sum(truth_speed[s:e]) * DT)
            if travelled < 50:  # a window spent parked says nothing about speed
                continue
            tx = gx[s:e] - gx[s]
            ty = gy[s:e] - gy[s]
            h0 = np.deg2rad(hdg[s])
            for name, sp in sources.items():
                x, y = dead_reckon(sp[s:e], yaw[s:e], h0)
                err = float(np.hypot(x[-1] - tx[-1], y[-1] - ty[-1]))
                rows.append(
                    {
                        "duration_s": dur,
                        "model": name,
                        "start": s,
                        "travelled_m": travelled,
                        "final_error_m": err,
                        "drift_pct": err / travelled * 100,
                    }
                )
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sequence", default=None)
    args = ap.parse_args()
    seq = args.sequence or TEST_SEQUENCES[0]
    RESULTS.mkdir(parents=True, exist_ok=True)

    npz = np.load(PROCESSED / "windows.npz")
    mean, std = npz["scaler_mean"], npz["scaler_std"]
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    ckpt = torch.load(RESULTS / "model.pt", map_location=device, weights_only=True)
    model = SpeedCNN().to(device)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    data = load_sequence(seq)
    imu, truth_speed = data["imu"], data["speed"]
    m = len(imu)

    stride = WINDOW_SAMPLES // 2
    starts = list(range(0, m - WINDOW_SAMPLES + 1, stride))
    X = np.stack([imu[s : s + WINDOW_SAMPLES] for s in starts])

    cnn = per_sample(predict_speed(model, X, mean, std, device), m)
    ridge = ridge_baseline()
    ridge.fit(npz["F_train"], npz["y_train"])
    rdg = per_sample(np.clip(ridge.predict(statistical_features(X)), 0, None), m)
    const = np.full(m, float(npz["y_train"].mean()))

    yaw, corr, sign = heading_rate(seq, data, m)
    gx, gy, hdg, _ = gps_track(seq, m)

    sources = {
        "Truth speed (DR floor)": truth_speed[:m],
        "CNN (ours)": cnn,
        "Ridge baseline": rdg,
        "Constant speed": const,
    }
    distance = float(np.sum(truth_speed) * DT)

    print(f"sequence {seq}: {m} samples, {m*DT/60:.1f} min, {distance/1000:.1f} km")
    print(f"  heading: vehicle yaw sensor, sign {sign:+d}, |r| vs GPS rate = {corr:.3f}")
    print(f"  reference: recorded GPS path")
    print(f"  speed MAE over the whole sequence:")
    for name, sp in sources.items():
        print(f"    {name:<24}{np.abs(sp - truth_speed[:m]).mean():>6.2f} m/s")

    rows = score_windows(sources, truth_speed, yaw, gx, gy, hdg, m)

    print(f"\n  drift % over {len({r['start'] for r in rows})} outage windows"
          f" x {len(OUTAGE_SECONDS)} durations:\n")
    header = f"  {'outage':<9}" + "".join(f"{n:>26}" for n in sources)
    print(header)
    print(f"  {'':<9}" + "".join(f"{'mean':>10}{'median':>9}{'n':>7}" for _ in sources))
    summary = {}
    for dur in OUTAGE_SECONDS:
        line = f"  {str(dur)+' s':<9}"
        for name in sources:
            d = [r["drift_pct"] for r in rows if r["duration_s"] == dur and r["model"] == name]
            if d:
                summary[f"{name}|{dur}"] = {
                    "mean": float(np.mean(d)),
                    "median": float(np.median(d)),
                    "p90": float(np.percentile(d, 90)),
                    "n": len(d),
                }
                line += f"{np.mean(d):>9.1f}%{np.median(d):>8.1f}%{len(d):>7}"
        print(line)

    results = {
        "sequence": seq,
        "minutes": m * DT / 60,
        "distance_km": distance / 1000,
        "heading_source": "vehicle yaw sensor",
        "heading_corr_vs_gps": corr,
        "speed_mae_mps": {k: float(np.abs(v - truth_speed[:m]).mean()) for k, v in sources.items()},
        "drift_by_outage": summary,
    }
    (RESULTS / "position_results.json").write_text(json.dumps(results, indent=2))

    # ── Figures ──────────────────────────────────────────────────────────────
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    # A representative 120 s window. Two rules, both fixed before looking at
    # the numbers: it must contain real turning, and among those it is the one
    # where the CNN lands nearest ITS OWN MEDIAN drift — so the picture is
    # typical rather than flattering.
    #
    # The turning rule matters for honesty as much as for looks. The median
    # window overall is a straight motorway run where every trajectory, including
    # "assume a constant 46 km/h", lies on top of the truth. That picture makes
    # dead reckoning look far better than it is, because a straight line is the
    # one case where heading cannot go wrong.
    w120 = 120 * SAMPLE_RATE_HZ
    turn = {
        r["start"]: float(np.sum(np.abs(yaw[r["start"] : r["start"] + w120])) * DT)
        for r in rows if r["duration_s"] == 120 and r["model"] == "CNN (ours)"
    }
    cand = [r for r in rows if r["duration_s"] == 120 and r["model"] == "CNN (ours)"
            and turn.get(r["start"], 0) > np.deg2rad(90)]
    if not cand:  # a sequence with no turns at all — fall back rather than crash
        cand = [r for r in rows if r["duration_s"] == 120 and r["model"] == "CNN (ours)"]
    med = float(np.median([r["drift_pct"] for r in cand]))
    pick = min(cand, key=lambda r: abs(r["drift_pct"] - med))
    s0 = pick["start"]
    w = 120 * SAMPLE_RATE_HZ
    e0 = s0 + w

    colours = {
        "Truth speed (DR floor)": "tab:cyan",
        "CNN (ours)": "tab:red",
        "Ridge baseline": "tab:green",
        "Constant speed": "tab:gray",
    }

    fig = plt.figure(figsize=(15, 11))
    fig.suptitle(
        f"PathPulse — IO-VNBD speed model, dead-reckoned position  ·  held-out sequence {seq}  ·  "
        f"{m*DT/60:.0f} min, {distance/1000:.0f} km  ·  speed from phone IMU only, no GNSS",
        fontsize=13, fontweight="bold",
    )

    # Fig 1 — a representative outage.
    ax = fig.add_subplot(2, 2, 1)
    tx, ty = gx[s0:e0] - gx[s0], gy[s0:e0] - gy[s0]
    ax.plot(tx, ty, color="tab:blue", lw=2.4, label="Ground truth (recorded GPS)")
    h0 = np.deg2rad(hdg[s0])
    for name in ("CNN (ours)", "Ridge baseline", "Constant speed"):
        x, y = dead_reckon(sources[name][s0:e0], yaw[s0:e0], h0)
        d = next(r for r in rows if r["duration_s"] == 120 and r["model"] == name and r["start"] == s0)
        ax.plot(x, y, color=colours[name], lw=1.6, label=f"{name} — {d['drift_pct']:.1f}% drift")
    ax.plot(0, 0, "ko", ms=9, label="Outage begins")
    ax.set_aspect("equal"); ax.grid(alpha=0.3)
    ax.set_xlabel("East (m)"); ax.set_ylabel("North (m)")
    ax.set_title(
        f"Figure 1 — A typical 120 s GNSS outage with turns "
        f"({pick['travelled_m']:.0f} m, {np.rad2deg(turn[s0]):.0f}° of turning)"
    )
    ax.legend(fontsize=8)

    # Fig 2 — speed tracking across the whole drive.
    ax = fig.add_subplot(2, 2, 2)
    t_min = np.arange(m) * DT / 60
    ax.plot(t_min, truth_speed[:m] * 3.6, color="tab:blue", lw=1.2, label="Ground truth (wheel speed)")
    ax.plot(t_min, cnn * 3.6, color="tab:red", lw=0.5, alpha=0.35, label="CNN, raw per-window")
    # A 5 s moving average — what the engine actually consumes. Per-window
    # predictions are independent, so their noise is uncorrelated and averages
    # down; the engine already holds each value for half a window anyway.
    k = 5 * SAMPLE_RATE_HZ
    smooth = np.convolve(cnn, np.ones(k) / k, mode="same")
    ax.plot(t_min, smooth * 3.6, color="tab:red", lw=1.3, label="CNN, 5 s mean")
    ax.set_xlabel("time (minutes)"); ax.set_ylabel("speed (km/h)")
    ax.set_title(
        f"Figure 2 — Speed over time  (MAE {np.abs(cnn - truth_speed[:m]).mean():.2f} m/s raw, "
        f"{np.abs(smooth - truth_speed[:m]).mean():.2f} m/s smoothed)"
    )
    ax.grid(alpha=0.3); ax.legend(fontsize=8)

    # Fig 3 — the money chart: drift vs outage length.
    ax = fig.add_subplot(2, 2, 3)
    width = 0.2
    xs = np.arange(len(OUTAGE_SECONDS))
    for i, name in enumerate(sources):
        vals = [summary.get(f"{name}|{d}", {}).get("mean", np.nan) for d in OUTAGE_SECONDS]
        ax.bar(xs + (i - 1.5) * width, vals, width, label=name, color=colours[name])
    ax.axhline(10, ls="--", color="k", lw=1, label="PS target <10 %")
    ax.set_xticks(xs); ax.set_xticklabels([f"{d} s" for d in OUTAGE_SECONDS])
    ax.set_xlabel("outage duration"); ax.set_ylabel("mean drift (% of distance)")
    ax.set_title("Figure 3 — Drift vs outage length, all windows")
    ax.grid(alpha=0.3, axis="y"); ax.legend(fontsize=8)

    # Fig 4 — the distribution, because a mean hides the tail.
    ax = fig.add_subplot(2, 2, 4)
    box = [[r["drift_pct"] for r in rows if r["duration_s"] == 120 and r["model"] == n]
           for n in sources]
    bp = ax.boxplot(box, tick_labels=[n.replace(" (", "\n(") for n in sources], showfliers=False,
                    patch_artist=True)
    for patch, name in zip(bp["boxes"], sources):
        patch.set_facecolor(colours[name]); patch.set_alpha(0.65)
    ax.axhline(10, ls="--", color="k", lw=1)
    ax.set_ylabel("drift (% of distance)")
    ax.set_title(f"Figure 4 — Spread over {len(box[0])} separate 120 s outages")
    ax.grid(alpha=0.3, axis="y")

    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(RESULTS / "position_plot.png", dpi=300)
    print(f"\n✔ {RESULTS/'position_plot.png'} (300 dpi)")
    print(f"✔ {RESULTS/'position_results.json'}")


if __name__ == "__main__":
    main()
