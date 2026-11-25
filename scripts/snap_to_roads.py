#!/usr/bin/env python3
"""
Offline OSM road-graph map-matching for Jerusalem SIRI bus trajectories.

Reads data/jlm-timelapse.json (69,782 OSM road segments in [0..10000] space)
and snaps + routes consecutive 1-minute GPS pings in data/real-day{0..6}.bin
along the actual road network using corridor-bounded A* with road-class weights
and Douglas-Peucker simplification.

Output stays 100% compatible with the SBJ1 binary format!
"""
import heapq
import json
import math
import os
import struct
import sys
import time
from collections import defaultdict

ROADS_JSON = "data/jlm-timelapse.json"

# Road-class cost multipliers (0=highway, 1=primary, 2=secondary, 3=tertiary, 4=residential)
TIER_WEIGHT = (0.94, 1.00, 1.06, 1.18, 1.48)
# Snap bonus (in normalized units ~1.33m) so pings near an arterial prefer it over an adjacent alley
TIER_SNAP_PENALTY = (0.0, 1.5, 3.0, 6.0, 14.0)

CELL_SIZE = 40  # ~53 meters per spatial hash cell
MAX_SNAP_DIST = 55.0  # ~73 meters max snap radius


def load_road_graph(path=ROADS_JSON):
    t0 = time.time()
    with open(path, "r") as f:
        data = json.load(f)
    raw = data["roads"]

    coord_to_id = {}
    node_x = []
    node_y = []
    node_min_tier = []
    adj = []

    def get_node(x, y, tier):
        key = (x << 14) | y
        nid = coord_to_id.get(key)
        if nid is None:
            nid = len(node_x)
            coord_to_id[key] = nid
            node_x.append(x)
            node_y.append(y)
            node_min_tier.append(tier)
            adj.append([])
        elif tier < node_min_tier[nid]:
            node_min_tier[nid] = tier
        return nid

    n_segs = len(raw) // 5
    for i in range(0, len(raw), 5):
        tier = raw[i]
        x1, y1, x2, y2 = raw[i + 1], raw[i + 2], raw[i + 3], raw[i + 4]
        if x1 == x2 and y1 == y2:
            continue
        if not (0 <= x1 <= 10000 and 0 <= y1 <= 10000 and 0 <= x2 <= 10000 and 0 <= y2 <= 10000):
            continue
        u = get_node(x1, y1, tier)
        v = get_node(x2, y2, tier)
        d = math.hypot(x2 - x1, y2 - y1)
        w = d * TIER_WEIGHT[tier]
        adj[u].append((v, w, d))
        adj[v].append((u, w, d))

    # Build 2D spatial hash of nodes
    grid = defaultdict(list)
    for nid in range(len(node_x)):
        cx = node_x[nid] // CELL_SIZE
        cy = node_y[nid] // CELL_SIZE
        grid[(cx, cy)].append(nid)

    print(
        f"Loaded road graph: {n_segs:,} segments, {len(node_x):,} nodes in {time.time() - t0:.2f}s",
        flush=True,
    )
    return node_x, node_y, node_min_tier, adj, grid


def build_snapper(node_x, node_y, node_min_tier, grid):
    snap_cache = {}
    max_d2 = MAX_SNAP_DIST * MAX_SNAP_DIST

    def snap(x, y):
        key = (x << 14) | y
        res = snap_cache.get(key)
        if res is not None:
            return res
        cx = x // CELL_SIZE
        cy = y // CELL_SIZE
        best_id = -1
        best_score = 1e18
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                bucket = grid.get((cx + dx, cy + dy))
                if not bucket:
                    continue
                for nid in bucket:
                    ddx = node_x[nid] - x
                    ddy = node_y[nid] - y
                    d2 = ddx * ddx + ddy * ddy
                    if d2 > max_d2:
                        continue
                    score = math.sqrt(d2) + TIER_SNAP_PENALTY[node_min_tier[nid]]
                    if score < best_score:
                        best_score = score
                        best_id = nid
        snap_cache[key] = best_id
        return best_id

    return snap


def douglas_peucker(pts, eps):
    """Simplify list of (x, y) tuples keeping endpoints; eps in normalized units."""
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
                d2 = (px - ax) * (px - ax) + (py - ay) * (py - ay)
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / l2
                if t < 0.0:
                    t = 0.0
                elif t > 1.0:
                    t = 1.0
                qx = ax + t * dx
                qy = ay + t * dy
                d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy)
            if d2 > max_d2:
                max_d2 = d2
                idx = i
        if max_d2 > eps2 and idx != -1:
            keep[idx] = 1
            stack.append((a, idx))
            stack.append((idx, b))
    return [pts[i] for i in range(n) if keep[i]]


def build_router(node_x, node_y, adj):
    path_cache = {}
    stats = {"cache_hit": 0, "routed": 0, "fallback": 0}

    def route(u, v):
        if u == v:
            return None
        key = (u, v)
        cached = path_cache.get(key)
        if cached is not None:
            stats["cache_hit"] += 1
            return cached

        ux, uy = node_x[u], node_y[u]
        vx, vy = node_x[v], node_y[v]
        straight = math.hypot(vx - ux, vy - uy)
        if straight < 14.0 or straight > 1800.0:
            return None

        # Corridor-bounded A*
        max_cost = straight * 2.25 + 110.0
        min_x = min(ux, vx) - straight * 0.50 - 90
        max_x = max(ux, vx) + straight * 0.50 + 90
        min_y = min(uy, vy) - straight * 0.50 - 90
        max_y = max(uy, vy) + straight * 0.50 + 90

        # Heuristic multiplier <= min(TIER_WEIGHT) so A* stays admissible
        h_scale = 0.92
        pq = [(straight * h_scale, 0.0, u)]
        g_score = {u: 0.0}
        parent = {}
        expansions = 0
        max_expansions = 2200

        found = False
        while pq and expansions < max_expansions:
            f, g, cur = heapq.heappop(pq)
            if g > g_score.get(cur, 1e18):
                continue
            if cur == v:
                found = True
                break
            expansions += 1
            for nb, w, _ in adj[cur]:
                ng = g + w
                if ng > max_cost:
                    continue
                nx_nb = node_x[nb]
                ny_nb = node_y[nb]
                if nx_nb < min_x or nx_nb > max_x or ny_nb < min_y or ny_nb > max_y:
                    continue
                if ng < g_score.get(nb, 1e18):
                    g_score[nb] = ng
                    parent[nb] = cur
                    h = math.hypot(vx - nx_nb, vy - ny_nb) * h_scale
                    if ng + h <= max_cost:
                        heapq.heappush(pq, (ng + h, ng, nb))

        if not found:
            stats["fallback"] += 1
            if len(path_cache) < 250000:
                path_cache[key] = ()
            return ()

        # Reconstruct path
        chain = [v]
        cur = v
        while cur != u:
            cur = parent[cur]
            chain.append(cur)
        chain.reverse()

        pts = [(node_x[nid], node_y[nid]) for nid in chain]
        # Simplify nearly-collinear road vertices (5.5 units ≈ 7.3m — tighter than a street width)
        simp = douglas_peucker(pts, 5.5)
        # Store as tuple of (x, y)
        res = tuple(simp)
        stats["routed"] += 1
        if len(path_cache) < 250000:
            path_cache[key] = res
            path_cache[(v, u)] = tuple(reversed(res))
        return res

    return route, stats


def process_day(bin_path, out_path, node_x, node_y, snap, route):
    t0 = time.time()
    with open(bin_path, "rb") as f:
        buf = f.read()

    if buf[:4] != b"SBJ1":
        raise ValueError(f"Bad magic in {bin_path}")

    day_idx = buf[4]
    off = 5
    (line_count,) = struct.unpack_from("<H", buf, off)
    off += 2
    lines = []
    for _ in range(line_count):
        ln_len = buf[off]
        off += 1
        lines.append(buf[off : off + ln_len])
        off += ln_len
    (ride_count,) = struct.unpack_from("<I", buf, off)
    off += 4

    out_chunks = [buf[:off]]  # Header identical up to ride_count
    orig_pts_total = 0
    new_pts_total = 0
    segs_total = 0
    segs_snapped = 0

    for _ in range(ride_count):
        line_idx, op_ref, pt_count = struct.unpack_from("<HBH", buf, off)
        off += 5
        orig_pts_total += pt_count

        pts = []
        for _ in range(pt_count):
            t2, x, y = struct.unpack_from("<HHH", buf, off)
            off += 6
            pts.append((t2, x, y))

        # Snap each GPS ping to nearest road node (if within radius)
        snapped_ids = [snap(x, y) for (_, x, y) in pts]

        out_pts = []
        for k in range(pt_count):
            t2, x, y = pts[k]
            nid = snapped_ids[k]
            sx, sy = (node_x[nid], node_y[nid]) if nid >= 0 else (x, y)

            if k == 0:
                out_pts.append((t2, sx, sy))
                continue

            pt2, px, py = pts[k - 1]
            pnid = snapped_ids[k - 1]
            dt2 = t2 - pt2  # in 2-second ticks (165 ticks = 5.5 min)
            segs_total += 1

            routed = None
            if pnid >= 0 and nid >= 0 and pnid != nid and 0 < dt2 <= 165:
                routed = route(pnid, nid)

            if routed and len(routed) >= 3:
                segs_snapped += 1
                # Compute cumulative arc length to interpolate timestamps cleanly
                cum = [0.0]
                for j in range(1, len(routed)):
                    cum.append(
                        cum[-1]
                        + math.hypot(
                            routed[j][0] - routed[j - 1][0],
                            routed[j][1] - routed[j - 1][1],
                        )
                    )
                total_len = cum[-1]
                if total_len > 0.0:
                    for j in range(1, len(routed) - 1):
                        frac = cum[j] / total_len
                        it2 = pt2 + int(round(dt2 * frac))
                        if it2 <= out_pts[-1][0] or it2 >= t2:
                            continue
                        out_pts.append((it2, routed[j][0], routed[j][1]))

            out_pts.append((t2, sx, sy))

        # Deduplicate exact-same consecutive timestamps+coords if any, keep <= 65535
        if len(out_pts) > 65535:
            out_pts = out_pts[:65535]
        new_pts_total += len(out_pts)

        ride_buf = bytearray(5 + len(out_pts) * 6)
        struct.pack_into("<HBH", ride_buf, 0, line_idx, op_ref, len(out_pts))
        roff = 5
        for t2, rx, ry in out_pts:
            struct.pack_into("<HHH", ride_buf, roff, t2, rx, ry)
            roff += 6
        out_chunks.append(bytes(ride_buf))

    with open(out_path, "wb") as f:
        for ch in out_chunks:
            f.write(ch)

    orig_mb = os.path.getsize(bin_path) / (1024 * 1024)
    new_mb = os.path.getsize(out_path) / (1024 * 1024)
    pct = 100.0 * segs_snapped / max(1, segs_total)
    print(
        f"  {bin_path}: {ride_count:,} rides | {segs_snapped:,}/{segs_total:,} segs routed ({pct:.1f}%) | "
        f"pts {orig_pts_total:,} -> {new_pts_total:,} ({new_pts_total/orig_pts_total:.2f}x) | "
        f"{orig_mb:.2f} MB -> {new_mb:.2f} MB | {time.time() - t0:.1f}s",
        flush=True,
    )


def main():
    days = [int(a) for a in sys.argv[1:]] if len(sys.argv) > 1 else list(range(7))
    node_x, node_y, node_min_tier, adj, grid = load_road_graph()
    snap = build_snapper(node_x, node_y, node_min_tier, grid)
    route, stats = build_router(node_x, node_y, adj)

    t_all = time.time()
    for d in days:
        p = f"data/real-day{d}.bin"
        tmp = f"data/real-day{d}.snapped.bin"
        process_day(p, tmp, node_x, node_y, snap, route)
        os.replace(tmp, p)

    print(
        f"Done in {time.time() - t_all:.1f}s | A* stats: routed={stats['routed']:,}, "
        f"cache_hits={stats['cache_hit']:,}, fallback={stats['fallback']:,}",
        flush=True,
    )


if __name__ == "__main__":
    main()
