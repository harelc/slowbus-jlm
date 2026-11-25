#!/usr/bin/env python3
"""
Extract Jerusalem route metadata (route_id -> line, agency_id, shape_ids) and
normalized [0..10000] GTFS shape polylines from /tmp/israel-gtfs.zip into
/tmp/jlm-gtfs-shapes.pkl for ultra-fast map-matching.
"""
import csv
import io
import math
import pickle
import time
import zipfile
from collections import defaultdict

GTFS_ZIP = "/tmp/israel-gtfs.zip"
OUT_PKL = "/tmp/jlm-gtfs-shapes.pkl"

LAT_MIN, LAT_MAX = 31.715, 31.835
LON_MIN, LON_MAX = 35.145, 35.285
# Margin around bbox so routes entering/exiting Jerusalem keep continuity near edges
LAT_PAD, LON_PAD = 0.015, 0.015


def to_nx(lon):
    return (lon - LON_MIN) / (LON_MAX - LON_MIN) * 10000.0


def to_ny(lat):
    return (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * 10000.0


def douglas_peucker(pts, eps):
    n = len(pts)
    if n <= 2:
        return pts
    eps2 = eps * eps
    keep = bytearray(n)
    keep[0] = 1
    keep[n - 1] = 1
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx = bx - ax
        dy = by - ay
        l2 = dx * dx + dy * dy
        max_d2 = -1.0
        idx = -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if l2 == 0.0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / l2
                if t < 0.0:
                    t = 0.0
                elif t > 1.0:
                    t = 1.0
                qx = ax + t * dx
                qy = ay + t * dy
                d2 = (px - qx) ** 2 + (py - qy) ** 2
            if d2 > max_d2:
                max_d2 = d2
                idx = i
        if max_d2 > eps2 and idx != -1:
            keep[idx] = 1
            stack.append((a, idx))
            stack.append((idx, b))
    return [pts[i] for i in range(n) if keep[i]]


def main():
    t0 = time.time()
    route_info = {}  # int(route_id) -> (route_short_name, int(agency_id))
    route_to_shapes = defaultdict(set)  # int(route_id) -> set(shape_id)
    shape_pts_raw = defaultdict(list)  # shape_id -> [(seq, lat, lon), ...]
    jlm_shapes = set()

    with zipfile.ZipFile(GTFS_ZIP) as z:
        # 1) All Israel routes (tiny: 1 MB) -> gives complete line_ref -> line_name!
        with z.open("routes.txt") as f:
            for row in csv.DictReader(io.TextIOWrapper(f, "utf-8-sig")):
                rid = int(row["route_id"])
                nm = (row.get("route_short_name") or "").strip()
                ag = int(row.get("agency_id") or 0)
                if nm and nm not in ("NaN", "nan", "None"):
                    route_info[rid] = (nm, ag)

        # 2) Map route_id -> shape_id via trips.txt
        with z.open("trips.txt") as f:
            for row in csv.DictReader(io.TextIOWrapper(f, "utf-8-sig")):
                sid = row.get("shape_id")
                if sid:
                    route_to_shapes[int(row["route_id"])].add(sid)

        # 3) Stream shapes.txt and keep only shapes that pass through Jerusalem bbox!
        print(f"Loaded {len(route_info):,} routes, streaming shapes.txt...", flush=True)
        with z.open("shapes.txt") as f:
            r = csv.reader(io.TextIOWrapper(f, "utf-8-sig"))
            header = next(r)
            idx_id = header.index("shape_id")
            idx_lat = header.index("shape_pt_lat")
            idx_lon = header.index("shape_pt_lon")
            idx_seq = header.index("shape_pt_sequence")

            cur_sid = None
            cur_pts = []
            cur_in_jlm = False

            def flush_shape(sid, pts, in_jlm):
                if not in_jlm or len(pts) < 2:
                    return
                pts.sort(key=lambda p: p[0])
                # Clip to slightly padded Jerusalem bbox, convert to normalized float coords
                norm = []
                for _, lat, lon in pts:
                    if (
                        LAT_MIN - LAT_PAD <= lat <= LAT_MAX + LAT_PAD
                        and LON_MIN - LON_PAD <= lon <= LON_MAX + LON_PAD
                    ):
                        norm.append((to_nx(lon), to_ny(lat)))
                if len(norm) >= 2:
                    simp = douglas_peucker(norm, 8.0)
                    # Precompute cumulative arc length for fast projection
                    cum = [0.0]
                    for i in range(1, len(simp)):
                        cum.append(
                            cum[-1]
                            + math.hypot(
                                simp[i][0] - simp[i - 1][0],
                                simp[i][1] - simp[i - 1][1],
                            )
                        )
                    shape_pts_raw[sid] = (simp, cum)
                    jlm_shapes.add(sid)

            for row in r:
                sid = row[idx_id]
                lat = float(row[idx_lat])
                lon = float(row[idx_lon])
                seq = int(row[idx_seq])
                if sid != cur_sid:
                    if cur_sid is not None:
                        flush_shape(cur_sid, cur_pts, cur_in_jlm)
                    cur_sid = sid
                    cur_pts = []
                    cur_in_jlm = False
                cur_pts.append((seq, lat, lon))
                if LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX:
                    cur_in_jlm = True
            if cur_sid is not None:
                flush_shape(cur_sid, cur_pts, cur_in_jlm)

    # Keep only route_to_shapes entries that exist in jlm_shapes
    jlm_route_shapes = {}
    for rid, sids in route_to_shapes.items():
        matched = [s for s in sids if s in jlm_shapes]
        if matched:
            jlm_route_shapes[rid] = matched

    # Also build (agency_id, route_short_name) -> list of shape_ids as backup
    by_line = defaultdict(list)
    for rid, sids in jlm_route_shapes.items():
        info = route_info.get(rid)
        if info:
            for s in sids:
                if s not in by_line[info]:
                    by_line[info].append(s)

    payload = {
        "route_info": route_info,
        "route_shapes": jlm_route_shapes,
        "by_line": dict(by_line),
        "shapes": dict(shape_pts_raw),
    }
    with open(OUT_PKL, "wb") as f:
        pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)

    print(
        f"Saved {OUT_PKL}: {len(route_info):,} Israel routes, "
        f"{len(jlm_route_shapes):,} JLM route_ids, {len(jlm_shapes):,} JLM shapes in {time.time() - t0:.1f}s",
        flush=True,
    )


if __name__ == "__main__":
    main()
