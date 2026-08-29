"""
The speed regressor (Phase 8, step 8A-3) and its baseline.

One job: look at two seconds of accelerometer and gyroscope and say how fast
the vehicle is going. Nothing else. The dead-reckoning maths in nav-core does
the rest — this only fills the hole GNSS leaves, which is that integrating
acceleration to get speed has no reference and drifts without bound.
"""

from __future__ import annotations

import torch
import torch.nn as nn


class SpeedCNN(nn.Module):
    """The guide's 1D-CNN, padded for a 20-sample window.

    The published architecture assumes a 100-sample window and pools twice
    without padding, which on 20 samples leaves 2 timesteps before the third
    convolution's kernel of 3 — it would not run. Same layers, same widths,
    same two pools; 'same' padding keeps the length legal. That is a
    consequence of the dataset being 10 Hz, documented in config.py.
    """

    def __init__(self, in_channels: int = 6, dropout: float = 0.2) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv1d(in_channels, 32, kernel_size=5, padding=2),
            nn.BatchNorm1d(32),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(32, 64, kernel_size=5, padding=2),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(64, 64, kernel_size=3, padding=1),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),  # global average pooling
        )
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(32, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: (batch, channels, time) -> (batch,) speed in m/s.

        No output activation. A ReLU here would look tidy — speed cannot be
        negative — but it kills the gradient for every window the model
        under-predicts to zero, and those are exactly the stopped windows it
        most needs to learn. Clamping happens at inference instead.
        """
        return self.head(self.features(x)).squeeze(-1)

    @property
    def n_params(self) -> int:
        return sum(p.numel() for p in self.parameters() if p.requires_grad)


def ridge_baseline(alpha: float = 1.0):
    """Ridge regression on the 42 hand-built statistics.

    Here to answer "is the deep model actually earning its place?". If the CNN
    cannot beat a linear model on FFT summaries, the honest report is that it
    does not, and the guide says so explicitly.
    """
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    return make_pipeline(StandardScaler(), Ridge(alpha=alpha))


if __name__ == "__main__":
    m = SpeedCNN()
    x = torch.randn(4, 6, 20)
    print(f"SpeedCNN  {m.n_params} parameters  (budget 100k)")
    print(f"  {tuple(x.shape)} -> {tuple(m(x).shape)}")
