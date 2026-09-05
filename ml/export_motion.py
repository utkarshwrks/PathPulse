"""
Export the motion-state classifier for on-device inference (Phase 13).

    python ml/export_motion.py

Writes ml/export/motion_model.onnx and copies the folded-weights JSON into
apps/web/public/models/ so the app can load it.

Same arrangement as the speed model: ONNX is produced as the interoperable
artefact and verified against PyTorch, but what SHIPS is the JSON, because
nav-core evaluates the network itself in pure TypeScript rather than carrying a
14 MB WASM runtime to multiply 9736 parameters.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import (  # noqa: E402
    EXPORT,
    MOTION_STATES,
    MOTION_WINDOW_SAMPLES,
    N_RAW_CHANNELS,
    PROCESSED,
    RESULTS,
    SAMPLE_RATE_HZ,
)
from export import export_folded_weights, f32  # noqa: E402
from models.motion_cnn import MotionCNN  # noqa: E402

WEB_MODELS = Path(__file__).resolve().parents[1] / "apps" / "web" / "public" / "models"

# ★ THE CHANNEL NAMES ARE A CONTRACT, NOT A LABEL ★
# These are NOT device axes. They are what the engine can actually produce:
# three quantities resolved into the vehicle frame by Phase 12's alignment, one
# verified vertical rate, and two magnitudes that no axis permutation can
# change. `motionChannels()` in NavigationEngine.ts builds exactly this vector,
# in exactly this order.
MOTION_CHANNEL_NAMES = ["aFwd", "aLat", "aVert", "wUp", "wHorizMag", "aMagResidual"]


def main() -> None:
    EXPORT.mkdir(parents=True, exist_ok=True)
    npz = np.load(PROCESSED / "motion_windows.npz", allow_pickle=True)

    model = MotionCNN(n_classes=len(MOTION_STATES))
    ckpt = torch.load(RESULTS / "motion_model.pt", map_location="cpu", weights_only=True)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    weights = export_folded_weights(model, npz)
    weights["architecture"] = "MotionCNN"
    weights["windowSamples"] = MOTION_WINDOW_SAMPLES
    weights["sampleRateHz"] = SAMPLE_RATE_HZ
    weights["channels"] = MOTION_CHANNEL_NAMES
    weights["classes"] = MOTION_STATES

    # ── Verify the folded weights reproduce the model they came from ─────────
    # BatchNorm folding is an arithmetic identity and is therefore exactly the
    # kind of thing that is silently wrong. Checked here rather than trusted.
    rng = np.random.default_rng(0)
    probe = rng.standard_normal((8, N_RAW_CHANNELS, MOTION_WINDOW_SAMPLES)).astype(np.float32)
    with torch.no_grad():
        reference = model(torch.from_numpy(probe)).numpy()

    folded = _run_folded(weights, probe)
    err = float(np.abs(folded - reference).max())
    if err > 1e-3:
        raise SystemExit(f"folded weights disagree with PyTorch by {err:.2e} — export is wrong")
    print(f"  folded weights match PyTorch to {err:.2e}")

    # ── ONNX, the interoperable artefact ─────────────────────────────────────
    onnx_path = EXPORT / "motion_model.onnx"
    torch.onnx.export(
        model,
        torch.randn(1, N_RAW_CHANNELS, MOTION_WINDOW_SAMPLES),
        str(onnx_path),
        input_names=["imu_window"],
        output_names=["motion_logits"],
        dynamic_axes={"imu_window": {0: "batch"}, "motion_logits": {0: "batch"}},
        opset_version=17,
        # The legacy exporter, for the same two reasons documented in export.py:
        # it writes one file, and the resulting graph quantises.
        dynamo=False,
    )

    json_path = EXPORT / "motion_model.json"
    payload = json.dumps(weights, separators=(",", ":"))
    json_path.write_text(payload)

    WEB_MODELS.mkdir(parents=True, exist_ok=True)
    shutil.copy2(json_path, WEB_MODELS / "motion_model.json")

    size_kb = len(payload) / 1024
    print(f"  wrote {json_path}  ({size_kb:.1f} KB)")
    print(f"  wrote {onnx_path}")
    print(f"  copied into {WEB_MODELS / 'motion_model.json'}")

    # The guide's budget is 500 KB for every model put together. The speed
    # model is 139 KB; this must not be the one that breaks it.
    if size_kb > 200:
        raise SystemExit(f"motion model is {size_kb:.0f} KB — over budget")
    print(f"  parameters {sum(p.numel() for p in model.parameters())}\n")


def _run_folded(weights: dict, x: np.ndarray) -> np.ndarray:
    """Evaluate the exported layer list in numpy — the same maths as cnn.ts.

    A third implementation exists on purpose. PyTorch is the source, TypeScript
    is what ships, and this is the referee: if the two disagree, this says which
    one moved.
    """
    import base64

    def blk(b64: str) -> np.ndarray:
        return np.frombuffer(base64.b64decode(b64), dtype="<f4")

    a = x.copy()
    for layer in weights["layers"]:
        if layer["type"] == "conv1d":
            w = blk(layer["weight"]).reshape(
                layer["outChannels"], layer["inChannels"], layer["kernel"]
            )
            b = blk(layer["bias"])
            pad = layer["padding"]
            padded = np.pad(a, ((0, 0), (0, 0), (pad, pad)))
            n, _, length = padded.shape
            out_len = length - layer["kernel"] + 1
            out = np.empty((n, layer["outChannels"], out_len), dtype=np.float32)
            for o in range(layer["outChannels"]):
                acc = np.zeros((n, out_len), dtype=np.float32)
                for c in range(layer["inChannels"]):
                    for k in range(layer["kernel"]):
                        acc += padded[:, c, k : k + out_len] * w[o, c, k]
                out[:, o] = acc + b[o]
            a = out
        elif layer["type"] == "relu":
            a = np.maximum(a, 0)
        elif layer["type"] == "maxpool1d":
            size = layer["size"]
            usable = (a.shape[2] // size) * size
            a = a[:, :, :usable].reshape(a.shape[0], a.shape[1], -1, size).max(axis=3)
        elif layer["type"] == "globalAvgPool":
            a = a.mean(axis=2, keepdims=True)
        elif layer["type"] == "linear":
            w = blk(layer["weight"]).reshape(layer["outFeatures"], layer["inFeatures"])
            b = blk(layer["bias"])
            a = a.reshape(a.shape[0], -1) @ w.T + b
    return a


if __name__ == "__main__":
    main()
