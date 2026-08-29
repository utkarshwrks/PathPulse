"""
Fetch a subset of IO-VNBD (Phase 8, step 8A-1).

The dataset lives in Git LFS, so the files GitHub serves from `raw.` are
132-byte pointers, not data. Cloning the whole repository to get at them would
pull ~40 hours of driving; we need about six. So this resolves each pointer
through the LFS batch API and downloads only the objects we asked for.

Each sequence directory holds a matched pair, row-for-row synchronised:

    S-<seq>.csv   the SMARTPHONE — accelerometer m/s^2, gyroscope rad/s, GPS
    V-<seq>.csv   the VEHICLE    — CAN bus, including wheel-speed odometry

That pairing is why this dataset is the right one for PathPulse. The input is a
phone's IMU, which is exactly the sensor we deploy on, and the label is the
car's own wheel-speed sensor rather than GPS — so the ground truth stays valid
in the tunnels where GPS would not.

    python ml/data/download.py            # the default subset
    python ml/data/download.py --explore  # describe what was downloaded
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import RAW, TEST_SEQUENCES, TRAIN_SEQUENCES, VAL_SEQUENCES  # noqa: E402

REPO = "onyekpeu/IO-VNBD"
BRANCH = "master"
BASE = "Synchronised V abd S datasets/Categorised IOVNB Dataset"
LFS_BATCH = f"https://github.com/{REPO}.git/info/lfs/objects/batch"
UA = {"User-Agent": "pathpulse-phase8"}

# Sequence -> category directory. Discovered from the repository once and
# cached, because the categories are unevenly named ("Vta (Driver E)") and a
# hardcoded map went stale the moment we wanted more than nine sequences.
_CATEGORY_CACHE: dict[str, str] | None = None


def category_map() -> dict[str, str]:
    """Every sequence in the dataset, mapped to the directory holding it."""
    global _CATEGORY_CACHE
    if _CATEGORY_CACHE is None:
        cache = RAW.parent / "categories.json"
        if cache.exists():
            _CATEGORY_CACHE = json.loads(cache.read_text())
        else:
            m: dict[str, str] = {}
            for cat in _api(BASE):
                if cat["type"] != "dir":
                    continue
                for sub in _api(f"{BASE}/{cat['name']}"):
                    if sub["type"] == "dir":
                        m[sub["name"]] = cat["name"]
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(m, indent=2, sort_keys=True))
            _CATEGORY_CACHE = m
    return _CATEGORY_CACHE


DEFAULT = TRAIN_SEQUENCES + VAL_SEQUENCES + TEST_SEQUENCES


def _get(url: str, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def _api(path: str):
    url = f"https://api.github.com/repos/{REPO}/contents/" + urllib.parse.quote(path)
    return json.loads(_get(url))


def _resolve_lfs(oid: str, size: int) -> str:
    """Pointer -> real download URL. Public repo, so no auth token is needed."""
    body = json.dumps(
        {
            "operation": "download",
            "transfers": ["basic"],
            "objects": [{"oid": oid, "size": size}],
        }
    ).encode()
    req = urllib.request.Request(
        LFS_BATCH,
        data=body,
        headers={
            **UA,
            "Accept": "application/vnd.git-lfs+json",
            "Content-Type": "application/vnd.git-lfs+json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        obj = json.load(r)["objects"][0]
    if "error" in obj:
        raise RuntimeError(f"LFS refused {oid[:12]}: {obj['error']}")
    return obj["actions"]["download"]["href"]


def _download_file(repo_path: str, dest: Path) -> int:
    """Download one LFS-backed file. Returns bytes written; 0 if already there."""
    if dest.exists() and dest.stat().st_size > 10_000:
        return 0
    raw_url = (
        f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/"
        + urllib.parse.quote(repo_path)
    )
    pointer = _get(raw_url).decode("utf-8", errors="replace")
    if "git-lfs" not in pointer:
        # Not LFS after all — what we just fetched IS the file.
        dest.write_text(pointer)
        return len(pointer)
    oid = size = None
    for line in pointer.splitlines():
        if line.startswith("oid sha256:"):
            oid = line.split(":", 1)[1].strip()
        elif line.startswith("size "):
            size = int(line.split()[1])
    if not oid or size is None:
        raise RuntimeError(f"unparseable LFS pointer for {repo_path}")
    data = _get(_resolve_lfs(oid, size))
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return len(data)


def download_sequence(seq: str) -> dict:
    """Fetch the S/V pair for one sequence. Filenames inside are irregular
    (Vta01a holds 'S-Vta1a.csv' — the zero is dropped), so list, don't guess."""
    category = category_map().get(seq)
    if category is None:
        raise SystemExit(f"unknown sequence '{seq}' — not present in the dataset")
    listing = _api(f"{BASE}/{category}/{seq}")
    csvs = [f["name"] for f in listing if f["name"].lower().endswith(".csv")]
    phone = next((n for n in csvs if n.upper().startswith("S-")), None)
    vehicle = next((n for n in csvs if n.upper().startswith("V-")), None)
    if not phone or not vehicle:
        raise SystemExit(f"{seq}: expected an S-*.csv and a V-*.csv, found {csvs}")

    out = RAW / seq
    written = 0
    for name, tag in ((phone, "phone"), (vehicle, "vehicle")):
        n = _download_file(f"{BASE}/{category}/{seq}/{name}", out / f"{tag}.csv")
        written += n
        print(f"    {tag:8} {name:<18} {'cached' if n == 0 else f'{n/1e6:.1f} MB'}")
    return {"sequence": seq, "category": category, "bytes": written}


def explore() -> None:
    """Print what we actually have: columns, units, rate, row counts."""
    import csv
    import io
    import statistics

    seqs = sorted(p for p in RAW.iterdir() if p.is_dir()) if RAW.exists() else []
    if not seqs:
        print("nothing downloaded yet — run without --explore first")
        return

    first = seqs[0]
    for tag in ("phone", "vehicle"):
        text = (first / f"{tag}.csv").read_bytes().decode("utf-8", errors="replace")
        header = next(csv.reader(io.StringIO(text)))
        print(f"\n=== {first.name}/{tag}.csv — {len(header)} columns ===")
        for i, h in enumerate(header):
            print(f"  [{i:2}] {h.strip()}")

    print(f"\n=== {len(seqs)} sequences ===")
    total_rows = 0
    for p in seqs:
        text = (p / "phone.csv").read_bytes().decode("utf-8", errors="replace")
        rows = list(csv.reader(io.StringIO(text)))[1:]
        rows = [r for r in rows if len(r) > 7 and r[7].strip()]
        t = [float(r[7]) for r in rows]
        dts = [t[i + 1] - t[i] for i in range(min(2000, len(t) - 1))]
        hz = 1000 / statistics.median(dts) if dts else float("nan")
        total_rows += len(rows)
        print(f"  {p.name:8} {len(rows):>7} rows  {(t[-1]-t[0])/60000:>5.1f} min  {hz:.1f} Hz")
    print(f"\n  total {total_rows} rows ≈ {total_rows/10/3600:.2f} hours at 10 Hz")
    print("\n  units: accelerometer m/s^2 (gravity included), gyroscope rad/s,")
    print("         vehicle speed km/h (wheel sensors), GPS speed km/h")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sequences", nargs="*", default=DEFAULT, help="sequence names")
    ap.add_argument("--explore", action="store_true", help="describe what is on disk")
    args = ap.parse_args()

    if args.explore:
        explore()
        return

    RAW.mkdir(parents=True, exist_ok=True)
    print(f"IO-VNBD subset -> {RAW}")
    print(f"{len(args.sequences)} sequences: {', '.join(args.sequences)}\n")
    total = 0
    for i, seq in enumerate(args.sequences, 1):
        print(f"[{i}/{len(args.sequences)}] {seq}")
        total += download_sequence(seq)["bytes"]
    print(f"\n✔ {total/1e6:.1f} MB downloaded. Run with --explore to describe it.")


if __name__ == "__main__":
    main()
