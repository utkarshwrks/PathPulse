# Recorded sensor logs

JSONL — one `SensorSample` per line.

Ground-truth methodology (Phase 7): drive a route with **good** GNSS and record
it. The recorded GNSS positions are the ground truth. The eval harness then
deletes GNSS from an artificial outage window and measures how far the dead
reckoning estimate strays from that truth. Honest, and reproducible without
needing a real tunnel.
