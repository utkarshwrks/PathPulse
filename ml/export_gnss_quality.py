"""
Export the GNSS quality classifier for on-device inference (Phase 13, Model 4).

    python ml/export_gnss_quality.py

An MLP is a CNN with no convolutions, so it exports through the same folded
weight writer and is evaluated by the same pure-TypeScript runner as the other
three models. One network implementation, four models.
"""

from __future__ import annotations

import base64
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import EXPORT, GNSS_QUALITY_CLASSES, RESULTS, SAMPLE_RATE_HZ  # noqa: E402
from train_gnss_quality import GnssQualityMLP  # noqa: E402

WEB_MODELS = Path(__file__).resolve().parents[1] / "apps" / "web" / "public" / "models"

# ★ THIS ORDER IS A CONTRACT ★ It must match GNSS_QUALITY_FEATURES in
# packages/nav-core/src/ml/gnssQualityModel.ts. nav-core checks it on load.
FEATURES = [
    "satCount",
    "satDropFromBaseline",
    "meanCn0",
    "cn0Spread",
    "accuracyM",
    "accuracyRatio",
    "jumpM",
    "impliedSpeedMps",
    "imuDisagreementMps",
    "fixIntervalS",
    "hdop",
]


def f32(values) -> str:
    return base64.b64encode(np.asarray(values, dtype="<f4").tobytes()).decode("ascii")


def main() -> None:
    EXPORT.mkdir(parents=True, exist_ok=True)
    ckpt = torch.load(RESULTS / "gnss_quality_model.pt", map_location="cpu", weights_only=True)

    model = GnssQualityMLP(len(FEATURES), len(GNSS_QUALITY_CLASSES))
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    layers = []
    for layer in model.net:
        if isinstance(layer, torch.nn.Linear):
            layers.append(
                {
                    "type": "linear",
                    "inFeatures": layer.in_features,
                    "outFeatures": layer.out_features,
                    "weight": f32(layer.weight.detach().flatten().numpy()),
                    "bias": f32(layer.bias.detach().flatten().numpy()),
                }
            )
        elif isinstance(layer, torch.nn.ReLU):
            layers.append({"type": "relu"})

    weights = {
        "architecture": "GnssQualityMLP",
        "encoding": "base64-float32-le",
        # A feature vector, not a time series: one "sample" of eleven channels.
        "windowSamples": 1,
        "sampleRateHz": SAMPLE_RATE_HZ,
        "channels": FEATURES,
        "classes": GNSS_QUALITY_CLASSES,
        "scaler": {
            "mean": np.asarray(ckpt["mean"], dtype=float).tolist(),
            "std": np.asarray(ckpt["std"], dtype=float).tolist(),
        },
        "layers": layers,
    }

    payload = json.dumps(weights, separators=(",", ":"))
    path = EXPORT / "gnss_quality_model.json"
    path.write_text(payload)
    WEB_MODELS.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, WEB_MODELS / "gnss_quality_model.json")

    print(f"  wrote {path}  ({len(payload) / 1024:.1f} KB)")
    print(f"  copied into {WEB_MODELS / 'gnss_quality_model.json'}")
    print(f"  parameters {sum(p.numel() for p in model.parameters())}\n")


if __name__ == "__main__":
    main()
