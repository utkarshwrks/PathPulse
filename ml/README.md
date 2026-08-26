# ML — IO-VNBD speed model

Built in Phase 8. Trains a small 1D-CNN to regress vehicle speed from a
2-second IMU window, and produces the **position plot** ISRO requires as a
screening artefact for the proposal.

Exports to ONNX/TFLite (<100 KB) for on-device inference. No cloud API.
