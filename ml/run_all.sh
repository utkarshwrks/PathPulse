#!/usr/bin/env bash
# Reproduce every Phase 8 artefact from nothing.
#
#   ./ml/run_all.sh
#
# Needs Python 3.11+ and network access for the first step only. Everything is
# seeded (ml/config.py: SEED), so a rerun reproduces the committed numbers.
set -euo pipefail
cd "$(dirname "$0")/.."

PY=ml/.venv/bin/python
if [ ! -x "$PY" ]; then
  echo "→ creating ml/.venv"
  python3 -m venv ml/.venv
  ml/.venv/bin/pip install --quiet --upgrade pip
  ml/.venv/bin/pip install --quiet -r ml/requirements.txt
fi

echo "→ 1/5  download IO-VNBD subset (skips what is already on disk)"
$PY ml/data/download.py

echo "→ 2/5  preprocess into windows"
$PY ml/data/preprocess.py

echo "→ 3/5  train the CNN and the ridge baseline"
$PY ml/train.py

echo "→ 4/5  position plot — the artefact the proposal needs"
$PY ml/evaluate_position.py

echo "→ 5/5  export to ONNX for on-device inference"
$PY ml/export.py

echo
echo "✔ ml/results/position_plot.png       the plot for the deck"
echo "✔ ml/results/training_curves.png     loss and validation MAE"
echo "✔ ml/results/train_metrics.json      CNN vs ridge vs constant"
echo "✔ ml/results/position_results.json   drift by outage length"
echo "✔ apps/web/public/models/            what the app loads"
