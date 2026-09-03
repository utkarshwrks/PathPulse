"""
The motion-state classifier (Phase 13, Model 2).

One job: look at one second of accelerometer and gyroscope and say what the
vehicle is doing — stopped, idling, straight, turning, accelerating, braking,
or being hit by a pothole.

★ WHY SO SMALL ★
The build guide's budget is under 50k parameters; this is about 9.7k, and the
smallness is not thrift. The window is ten samples. A larger network on ten
samples of a six-channel signal memorises the sequences it was shown, and the
split here holds out whole journeys, so memorisation shows up immediately as a
gap between train and test that no amount of training closes.

The architecture mirrors SpeedCNN deliberately — same layer types, same folded
BatchNorm — because packages/nav-core/src/ml/cnn.ts evaluates both, and a layer
type used by only one of them is a layer type the other's tests never exercise.
"""

from __future__ import annotations

import torch
import torch.nn as nn


class MotionCNN(nn.Module):
    def __init__(self, in_channels: int = 6, n_classes: int = 8, dropout: float = 0.2) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv1d(in_channels, 32, kernel_size=5, padding=2),
            nn.BatchNorm1d(32),
            nn.ReLU(),
            # 10 samples -> 5. Only one pool: a second is already short, and
            # pooling twice would leave two timesteps for the next kernel.
            nn.MaxPool1d(2),
            nn.Conv1d(32, 64, kernel_size=3, padding=1),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),
        )
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(32, n_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: (batch, channels, time) -> (batch, n_classes) LOGITS.

        Logits, not probabilities. Softmax lives at inference — in
        nav-core/src/ml/motionModel.ts — because cross-entropy wants raw logits
        and applying it twice quietly flattens every distribution the model
        produces.
        """
        return self.head(self.features(x))

    @property
    def n_params(self) -> int:
        return sum(p.numel() for p in self.parameters())
