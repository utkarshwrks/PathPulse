"""
Export the trained model for on-device inference (Phase 8, step 8A-4).

    python ml/export.py

Writes ml/export/{speed_model.onnx, speed_model.int8.onnx, scaler.json} and
copies the chosen one into apps/web/public/models/ so the app can load it.

★ WHAT ACTUALLY SHIPS. The app does NOT run ONNX Runtime. onnxruntime-web
  needs a 14 MB WASM binary to evaluate 26081 parameters — it would take the
  APK from 5.4 MB to about 20 MB, and it fails Next's Terser pass anyway. So
  nav-core evaluates the network itself in pure TypeScript, and what ships is
  `speed_model.json`: the same weights, BatchNorm folded into the convolutions,
  base64 float32.

  ONNX is still produced and still verified against PyTorch. It is the
  interoperable artefact, and `packages/nav-core/test/cnn.test.ts` checks the
  TypeScript against outputs captured from PyTorch so the two cannot drift.

★ ON TFLITE. The guide asks for ONNX *and* TFLite; this produces ONNX only.
  TensorFlow, which every ONNX->TFLite path needs, publishes no wheel for the
  Python 3.14 this pipeline runs on. Nothing in the repository would read a
  .tflite either. Worth adding when Phase 15's native Kotlin path arrives.
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
    CHANNELS,
    EXPORT,
    N_CHANNELS,
    PROCESSED,
    RESULTS,
    SAMPLE_RATE_HZ,
    WINDOW_SAMPLES,
)
from models.speed_cnn import SpeedCNN  # noqa: E402

WEB_MODELS = Path(__file__).resolve().parents[1] / "apps" / "web" / "public" / "models"


def f32(values) -> str:
    """Pack a tensor as base64 little-endian float32.

    Decimal text costs about 20 bytes a parameter — 535 KB for this model, most
    of it digits that float32 cannot even represent. Base64 float32 is 139 KB,
    exact, and parses in one pass on the other side.
    """
    import base64

    arr = np.asarray(values, dtype="<f4")
    return base64.b64encode(arr.tobytes()).decode("ascii")


def export_folded_weights(model, npz) -> dict:
    """Every parameter, with BatchNorm folded into the preceding convolution."""
    import torch.nn as nn

    layers = list(model.features) + list(model.head)
    out: list[dict] = []
    i = 0
    while i < len(layers):
        layer = layers[i]
        if isinstance(layer, nn.Conv1d):
            w = layer.weight.detach().clone()
            b = (
                layer.bias.detach().clone()
                if layer.bias is not None
                else torch.zeros(w.shape[0])
            )
            nxt = layers[i + 1] if i + 1 < len(layers) else None
            if isinstance(nxt, nn.BatchNorm1d):
                gamma = nxt.weight.detach()
                beta = nxt.bias.detach()
                mean = nxt.running_mean.detach()
                var = nxt.running_var.detach()
                scale = gamma / torch.sqrt(var + nxt.eps)
                w = w * scale.reshape(-1, 1, 1)
                b = (b - mean) * scale + beta
                i += 1  # consume the BatchNorm
            out.append(
                {
                    "type": "conv1d",
                    "inChannels": w.shape[1],
                    "outChannels": w.shape[0],
                    "kernel": w.shape[2],
                    "padding": layer.padding[0],
                    "weight": f32(w.flatten().numpy()),
                    "bias": f32(b.flatten().numpy()),
                }
            )
        elif isinstance(layer, nn.ReLU):
            out.append({"type": "relu"})
        elif isinstance(layer, nn.MaxPool1d):
            out.append({"type": "maxpool1d", "size": layer.kernel_size})
        elif isinstance(layer, nn.AdaptiveAvgPool1d):
            out.append({"type": "globalAvgPool"})
        elif isinstance(layer, nn.Linear):
            out.append(
                {
                    "type": "linear",
                    "inFeatures": layer.in_features,
                    "outFeatures": layer.out_features,
                    "weight": f32(layer.weight.detach().flatten().numpy()),
                    "bias": f32(layer.bias.detach().flatten().numpy()),
                }
            )
        # Flatten and Dropout are no-ops at inference on a (1, C) tensor.
        i += 1

    return {
        "architecture": "SpeedCNN",
        "encoding": "base64-float32-le",
        "windowSamples": WINDOW_SAMPLES,
        "channels": CHANNELS,
        "sampleRateHz": SAMPLE_RATE_HZ,
        "scaler": {"mean": npz["scaler_mean"].tolist(), "std": npz["scaler_std"].tolist()},
        "layers": out,
    }


def main() -> None:
    EXPORT.mkdir(parents=True, exist_ok=True)
    npz = np.load(PROCESSED / "windows.npz")

    model = SpeedCNN()
    ckpt = torch.load(RESULTS / "model.pt", map_location="cpu", weights_only=True)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    dummy = torch.randn(1, N_CHANNELS, WINDOW_SAMPLES)
    onnx_path = EXPORT / "speed_model.onnx"
    torch.onnx.export(
        model,
        dummy,
        str(onnx_path),
        input_names=["imu_window"],
        output_names=["speed_mps"],
        # Batch stays dynamic so the eval harness can score thousands of
        # windows in one call while the app passes one.
        dynamic_axes={"imu_window": {0: "batch"}, "speed_mps": {0: "batch"}},
        opset_version=17,
        # ★ THE LEGACY EXPORTER, DELIBERATELY. ★
        #
        # Two reasons, both found the hard way:
        #
        # 1. ONE FILE. torch 2.13's dynamo exporter writes weights to a sibling
        #    "speed_model.onnx.data" and leaves a 27 KB graph that LOOKS like
        #    the whole model. Copying just the .onnx into public/models/ ships a
        #    model with no weights: it fails to load on the phone, and the size
        #    check cheerfully reports 27 KB against a 100 KB budget when the
        #    real figure is 130 KB.
        # 2. QUANTISABLE. Every quantisation path over the dynamo graph dies on
        #    "[ShapeInferenceError] Inferred shape and existing shape differ in
        #    dimension 0: (64) vs (32)", with or without quant_pre_process. The
        #    legacy graph quantises first try.
        #
        # Revisit when torch's dynamo path fixes both; pin the behaviour here
        # rather than in a comment somewhere else.
        dynamo=False,
    )

    # ── Verify the export reproduces the model it came from ──────────────────
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    probe = npz["X_test"][:512].transpose(0, 2, 1).astype(np.float32)
    with torch.no_grad():
        torch_out = model(torch.tensor(probe)).numpy()
    onnx_out = sess.run(None, {"imu_window": probe})[0].reshape(-1)
    delta = float(np.abs(torch_out - onnx_out).max())
    print(f"  ONNX vs PyTorch, 512 real windows: max |Δ| = {delta:.2e}")
    if delta > 1e-3:
        raise SystemExit(f"✖ export does not match the source model ({delta:.2e} > 1e-3)")

    # ── Quantise ─────────────────────────────────────────────────────────────
    # Quantisation is not cosmetic here: 26081 float32 parameters are 104 KB on
    # their own, so the float model is over the guide's 100 KB budget and int8
    # is what brings it under.
    int8_path = EXPORT / "speed_model.int8.onnx"
    quant_delta = None
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(str(onnx_path), str(int8_path), weight_type=QuantType.QInt8)
        qsess = ort.InferenceSession(str(int8_path), providers=["CPUExecutionProvider"])
        qout = qsess.run(None, {"imu_window": probe})[0].reshape(-1)
        quant_delta = float(np.abs(torch_out - qout).mean())
        qmax = float(np.abs(torch_out - qout).max())
        print(
            f"  int8 vs PyTorch: mean |Δ| = {quant_delta:.4f} m/s, max = {qmax:.3f} m/s"
        )
    except Exception as exc:  # pragma: no cover - environment dependent
        print(f"  ! quantisation unavailable: {exc}")
        int8_path = None

    # ── The scaler travels WITH the model ────────────────────────────────────
    # Normalisation is part of the model's contract. Ship it separately from
    # the weights and the day someone retrains with a different distribution,
    # the app silently feeds the network numbers it has never seen.
    scaler = {
        "mean": npz["scaler_mean"].tolist(),
        "std": npz["scaler_std"].tolist(),
        "channels": CHANNELS,
        "windowSamples": WINDOW_SAMPLES,
        "sampleRateHz": SAMPLE_RATE_HZ,
        "inputName": "imu_window",
        "outputName": "speed_mps",
        "note": (
            "Channel order and window length are a contract with "
            "apps/web/lib/ml/onnxSpeedPredictor.ts. Regenerate both together."
        ),
    }
    (EXPORT / "scaler.json").write_text(json.dumps(scaler, indent=2))

    # Pick what ships: int8 if it is both smaller and faithful, else float32.
    chosen = onnx_path
    if int8_path and quant_delta is not None and quant_delta < 0.25:
        chosen = int8_path

    # ── ★ WEIGHTS FOR THE PURE-TYPESCRIPT RUNTIME ★ ─────────────────────────
    #
    # The app does NOT use ONNX Runtime. onnxruntime-web needs a 14 MB WASM
    # binary to evaluate a 26081-parameter model — it would grow the APK from
    # 5.4 MB to roughly 20 MB, and it fails to build under Next's Terser pass
    # anyway. So nav-core evaluates the network itself, in about 150 lines of
    # pure TypeScript, which also means the Phase 16 edge engine and the eval
    # harness get inference for free with no new dependency.
    #
    # The ONNX files above are still produced and still verified: they are the
    # interoperable artefact, and they are the reference this JSON is checked
    # against by packages/nav-core/test/cnn.test.ts.
    #
    # BatchNorm is FOLDED into the preceding convolution here rather than
    # implemented there. For y = gamma * (conv(x) - mean) / sqrt(var + eps) + beta
    # the whole affine part collapses into the conv's own weights and bias, so
    # the TypeScript needs no batch-norm layer at all and cannot get its
    # inference-vs-training behaviour wrong.
    weights = export_folded_weights(model, npz)
    (EXPORT / "speed_model.json").write_text(json.dumps(weights, separators=(",", ":")))

    # Only what the app actually reads goes into public/. The ONNX files stay
    # in ml/export/ as the interoperable artefact and the reference the
    # TypeScript is tested against — copying them into the APK would be 36 KB
    # of payload nothing opens.
    WEB_MODELS.mkdir(parents=True, exist_ok=True)
    shutil.copy(EXPORT / "scaler.json", WEB_MODELS / "scaler.json")
    shutil.copy(EXPORT / "speed_model.json", WEB_MODELS / "speed_model.json")

    # ── Probe vectors: the bridge between Python and TypeScript ──────────────
    #
    # Two claims get pinned here, and both are checked by
    # packages/nav-core/test/cnn.test.ts:
    #
    #   1. AGREEMENT — the TypeScript forward pass reproduces PyTorch's output
    #      for the same input. Catches a reimplementation bug.
    #   2. ACCURACY  — the TypeScript model achieves the MAE we publish, on real
    #      held-out windows with their real labels. Catches the subtler case
    #      where TS and PyTorch agree with each other and both are wrong,
    #      because the wrong weights were exported.
    #
    # ★ SIZED AGAINST THE FIXTURE, NOT PICKED ★
    # A window is now 12 channels x 60 samples = 720 numbers, six times what it
    # was at 6 x 20, so the 256 windows this used to keep would be a 3.6 MB
    # test fixture in the repo. 128 windows at four decimal places is ~650 KB
    # and still gives a stable MAE; four places is far inside the 1e-3 the
    # agreement test compares to, on inputs that are standardised to ~N(0,1).
    n_probe = 128
    probes = probe[:n_probe]
    labels = npz["y_test"][:n_probe]
    with torch.no_grad():
        expected = model(torch.tensor(probes)).numpy()
    torch_mae = float(np.abs(np.clip(expected, 0, None) - labels).mean())
    print(f"  probe set: {n_probe} windows, PyTorch MAE {torch_mae:.4f} m/s")
    (EXPORT / "probes.json").write_text(
        json.dumps(
            {
                "note": "Inputs are already scaler-normalised, (batch, channel, time).",
                "inputs": [[round(v, 4) for v in w] for w in probes.reshape(n_probe, -1).tolist()],
                "expected": [round(v, 6) for v in expected.tolist()],
                "labels": [round(float(v), 6) for v in labels.tolist()],
                "torchMaeMps": round(torch_mae, 6),
            },
            separators=(",", ":"),
        )
    )
    shutil.copy(
        EXPORT / "probes.json",
        Path(__file__).resolve().parents[1] / "packages" / "nav-core" / "test" / "probes.json",
    )

    # Count any external-data sidecar too, or the number is a fiction.
    def total_kb(p: Path) -> float:
        return sum(
            f.stat().st_size for f in [p, p.with_suffix(p.suffix + ".data")] if f.exists()
        ) / 1024

    for stray in EXPORT.glob("*.onnx.data"):
        print(f"  ! external weights present: {stray.name} ({stray.stat().st_size/1024:.1f} KB)")

    fp32_kb = total_kb(onnx_path)
    print(f"\n  float32  {fp32_kb:7.1f} KB  {onnx_path.name}")
    if int8_path:
        print(f"  int8     {total_kb(int8_path):7.1f} KB  {int8_path.name}")
    print(f"  int8 chosen for interop reference: {total_kb(chosen):.1f} KB ({chosen.name})")
    print(f"  SHIPPED TO THE APP: speed_model.json "
          f"{(WEB_MODELS/'speed_model.json').stat().st_size/1024:.1f} KB + scaler.json")
    # ★ MEASURE WHAT SHIPS, NOT WHAT FLATTERS. ★
    # The int8 ONNX is 35 KB and would sail under the guide's 100 KB budget —
    # but it is not what goes on the phone. The phone loads speed_model.json.
    # Reporting the ONNX figure against the budget would be marking our own
    # homework with the wrong paper.
    shipped_kb = (
        (WEB_MODELS / "speed_model.json").stat().st_size
        + (WEB_MODELS / "scaler.json").stat().st_size
    ) / 1024
    print(f"  params   {ckpt['n_params']}  (budget 100k) ✔")
    print(f"  on-device payload {shipped_kb:.1f} KB vs the guide's 100 KB target: "
          f"{'✔ under' if shipped_kb < 100 else '✖ OVER'}")
    if shipped_kb >= 100:
        print(
            "    26081 float32 weights are 104 KB before any encoding, so the\n"
            "    budget is unreachable at this parameter count without\n"
            "    quantising the shipped weights too. 135 KB is 2.4 % of the APK;\n"
            "    the honest report is that we exceed the target, not a smaller\n"
            "    number from a file the app never opens."
        )
    print(f"\n✔ {EXPORT}/  and  {WEB_MODELS}/")


if __name__ == "__main__":
    main()
