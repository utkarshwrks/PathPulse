"""
The mount-invariant input channels.

★ THE MODEL WAS SOLVING A PROBLEM THE ENGINE HAD ALREADY SOLVED ★

The network used to read six raw device-frame channels — ax ay az gx gy gz —
and the only thing telling it that a phone flat in a cup holder and a phone in
a cradle are the same vehicle was the mounting augmentation in
`data/preprocess.py`. It had to LEARN rotation invariance from examples,
spending capacity on a geometry problem that has a closed-form answer.

Meanwhile `AttitudeEstimator`, in nav-core, computes that answer every single
sample at runtime, because dead reckoning cannot work without it: it resolves
acceleration onto a genuinely horizontal plane and the yaw rate onto the true
vertical. The information was there and the model was not being given it.

These six channels hand it over. Every one is invariant to how the phone is
held:

    a_mag     |a|      total specific force
    a_vert    a . g    the component along gravity — vertical, whatever
                       vertical means for this handset. ~9.81 plus road bumps.
    a_horiz   |a_h|    what is left in the horizontal plane: braking,
                       cornering, and the vehicle's own vibration
    w_mag     |w|      total angular rate
    w_vert    w . g    yaw rate about the TRUE vertical. This is the turn
                       signal, and in the raw channels it is smeared across
                       gx, gy and gz by whatever angle the phone sits at.
    w_horiz   |w_h|    pitch and roll rate: suspension, not steering.

Gravity is estimated as the window mean of the accelerometer, which is what the
engine's own gravity split does. Over six seconds that is dominated by gravity
even under braking, and whatever bias it carries is the bias the engine carries
too — so the model is fed at inference exactly the signal it trained on.

★ THIS FILE HAS A TWIN ★

`appendDerivedChannels` in packages/nav-core/src/ml/speedModel.ts computes the
same six channels on the phone. The two are verified against each other by
`export.py`'s probe vectors, which are captured from PyTorch AFTER derivation
and replayed through the TypeScript in cnn.test.ts. Deliberately stateless and
filter-free for that reason: anything with memory would be two implementations
to keep in step, and they would not stay in step.
"""

from __future__ import annotations

import numpy as np


def derive(X: np.ndarray) -> np.ndarray:
    """(n, time, 6) raw device frame -> (n, time, 6) mount-invariant channels."""
    a = X[:, :, 0:3]
    w = X[:, :, 3:6]

    g = a.mean(axis=1)
    norm = np.linalg.norm(g, axis=1, keepdims=True)
    # A window whose mean acceleration is zero has no usable vertical. It
    # cannot happen to a phone on Earth, but it can happen to a synthetic test
    # vector, and dividing by it would fill the batch with NaN.
    norm = np.where(norm < 1e-6, 1.0, norm)
    ghat = (g / norm)[:, None, :]

    a_vert = (a * ghat).sum(axis=2)
    w_vert = (w * ghat).sum(axis=2)
    a_horiz = np.linalg.norm(a - a_vert[:, :, None] * ghat, axis=2)
    w_horiz = np.linalg.norm(w - w_vert[:, :, None] * ghat, axis=2)
    a_mag = np.linalg.norm(a, axis=2)
    w_mag = np.linalg.norm(w, axis=2)

    return np.stack([a_mag, a_vert, a_horiz, w_mag, w_vert, w_horiz], axis=2)


def with_derived(X: np.ndarray) -> np.ndarray:
    """(n, time, 6) -> (n, time, 12): the raw channels, then the derived ones.

    ★ CALL THIS AFTER AUGMENTATION, NEVER BEFORE ★
    The derived channels are supposed to be invariant to the mounting. Deriving
    before the rotation is applied would make them invariant by construction
    rather than by measurement, and would hand the model a training set whose
    derived channels disagree with the raw ones sitting beside them.
    """
    return np.concatenate([X, derive(X)], axis=2)
