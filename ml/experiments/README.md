# Speed-model experiments

The measurements behind the 6-second window, the derived channels and the
drift-based early stopping. Everything asserted in `ml/config.py`,
`ml/derived.py` and `packages/nav-core/src/ml/speedModel.ts` was produced here.

```bash
./ml/.venv/bin/python ml/experiments/cache_long.py   # once, ~2 min
./ml/.venv/bin/python ml/experiments/run2.py         # window length + capacity
./ml/.venv/bin/python ml/experiments/run3.py         # drift, and the block loss
```

`cache_long.py` writes 6-second windows with their sequence ids. A shorter
window is the TAIL of a longer one — the label is the speed at the window's end
— so every arm can be cut from one cache and gets identical windows, identical
labels and identical alignment. A difference between two rows is then the thing
named in the row and nothing else.

## What was measured

`run2.py` — window length, channels, capacity. Test MAE on Vw02 + S1:

| arm | mode | window | MAE m/s | r2 | params |
| --- | --- | --- | --- | --- | --- |
| shipped | raw | 2 s | 2.909 | 0.788 | 26081 |
| both ch | both | 2 s | 2.909 | 0.787 | 27041 |
| 4 s window | both | 4 s | 2.897 | 0.794 | 27041 |
| **6 s window** | **both** | **6 s** | **2.758** | **0.814** | **27041** |
| 6 s, raw ch | raw | 6 s | 2.994 | 0.781 | 26081 |
| 6 s, both, x1.5 | both | 6 s | 3.018 | 0.777 | 58993 |
| 6 s, both, x2 | both | 6 s | 3.246 | 0.753 | 103233 |

Two things worth keeping. The 6 s raw-only row is WORSE than the 2 s raw-only
row: more of a signal the model cannot align is not more information, so the
window length and the derived channels are not independent changes and must not
be reasoned about separately. And capacity does not help — 59k and 103k
parameters are both worse than 27k, on 40k training windows.

`run3.py` — the same arms scored on DRIFT rather than MAE, plus a loss term
that penalises the summed error over a 30-window block:

| arm | MAE | bias | drift30 mean | p90 | signed |
| --- | --- | --- | --- | --- | --- |
| shipped (raw, 2 s) | 2.909 | +0.05 | 24.11 % | 54.10 % | **+13.54 %** |
| **6 s + derived** | 3.059 | -1.08 | **19.76 %** | 39.88 % | **-0.76 %** |
| + block loss 0.5 | 3.498 | -2.08 | 20.67 % | 38.21 % | -9.22 % |
| + block loss 2 | 3.310 | -1.73 | 18.91 % | 36.65 % | -7.94 % |
| + block loss 5 | 3.375 | -1.39 | 18.69 % | 36.60 % | -6.36 % |

**The block loss is not shipped, and the reason is the signed column.** It buys
a tighter spread — mean drift 19.8 % to 18.7 %, p90 39.9 % to 36.6 % — by
teaching the model to under-predict, and it lands every arm between 6 % and 9 %
SHORT. For a system that integrates this output that is the wrong trade: a bias
compounds predictably over an outage where a zero-mean error cancels, so a
model that is 8 % short is a marker that falls steadily behind the vehicle,
which is worse than one that is occasionally further off in either direction.
An unbiased model at -0.8 % is the one to ship.

The rows are from a controlled retrain, so they measure the CHANGE. What the
actually-shipped weights did, measured directly against the same held-out
sequences, is in `ml/README.md`.
