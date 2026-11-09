"""Extract per-trip stop-sequence paths from a GTFS static zip.

TransLink's static GTFS carries no shapes.txt, so a trip's path is built
from its ordered stops (stop_times.txt joined to stops.txt). For the route
ids given on the command line, writes one JSON per route:

    {trips: {trip_id: {dir: 0|1, pts: [[lon, lat], ...], ids: [stop_id, ...],
                        names: [stop_name, ...]}}}

The card draws a vehicle's "path so far" by projecting it onto its trip's
stop polyline. Branch-exact: every trip keeps its own sequence.

    uv run --no-project python extract_shapes.py translink.zip 6613 6641 --out out/

Rerun whenever the static feed updates (the zip gtfs2 keeps in
/config/gtfs2/ is always current).
"""
import argparse
import csv
import io
import json
import sys
import zipfile
from pathlib import Path


def read_csv(zf, name):
    try:
        raw = zf.read(name)
    except KeyError:
        return []
    return csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("zip")
    ap.add_argument("routes", nargs="+")
    ap.add_argument("--out", default="out")
    args = ap.parse_args()
    wanted = set(args.routes)

    with zipfile.ZipFile(args.zip) as zf:
        stops = {}
        for row in read_csv(zf, "stops.txt"):
            try:
                stops[row["stop_id"]] = (
                    round(float(row["stop_lon"]), 6), round(float(row["stop_lat"]), 6),
                    row.get("stop_name", ""),
                )
            except (KeyError, ValueError):
                continue

        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        for rid in sorted(wanted):
            # trips of this route, each with its ordered stop ids
            seqs = {}
            for row in read_csv(zf, "trips.txt"):
                if row.get("route_id") == rid and row.get("trip_id"):
                    seqs[row["trip_id"]] = {"dir": row.get("direction_id"), "ids": []}
            if not seqs:
                print(f"{rid}: no trips in feed", file=sys.stderr)
                continue
            for row in read_csv(zf, "stop_times.txt"):
                t = seqs.get(row.get("trip_id"))
                if t is not None and row.get("stop_id") in stops:
                    # stop_times are already in riding order in TransLink's
                    # feed; trust the file order, sorting would need times
                    # that repeat across loops
                    t["ids"].append(row["stop_id"])
            trips = {}
            for tid, t in seqs.items():
                pts, names = [], []
                for sid in t["ids"]:
                    lon, lat, name = stops[sid]
                    if not pts or pts[-1] != [lon, lat]:
                        pts.append([lon, lat])
                    names.append(name)
                if len(pts) >= 2:
                    trips[tid] = {"dir": t["dir"], "pts": pts, "names": names}
            doc = {"trips": trips}
            path = out / f"{rid}_shapes.json"
            path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
            print(f"{rid}: {len(trips)} trips with paths, {path.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
