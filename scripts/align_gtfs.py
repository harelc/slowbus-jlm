#!/usr/bin/env python3
"""
Hybrid GTFS-shape + stitched-OSM road alignment for Jerusalem SIRI GPS rides.

1) Primary: projects consecutive 1-min GPS pings monotonically onto the ride's
   official Israel MOT GTFS shape polyline (from /tmp/jlm-gtfs-shapes.pkl),
   inserting exact route vertices with arc-length-interpolated timestamps.
2) Fallback (for genuine detours or routes missing from today's GTFS):
   routes along the tile-seam-stitched OSM road graph (main connected component
   of data/jlm-timelapse.json) with arterial preference.
"""
import heapq
import json
import math
import pickle
import time
from collections import defaultdict, deque

GTFS_PKL = "/tmp/jlm-gtfs-shapes.pkl"
ROADS_JSON = "data/jlm-timelapse.json"

TIER_WEIGHT = (0.92, 1.00, 1.08, 1.22, 1.68)
TIER_SNAP_PENALTY = (0.0, 1.5, 3.5, 7.0, 18.0)
CELL_SIZE = 40
MAX_SNAP_DIST = 55.0
MAX_SHAPE_DIST = 85.0  # ~113m max perpendicular distance to stay on GTFS shape


def clamp_coord(v):
    iv = int(round(v))
    return 0 if iv < 0 else (10000 if iv > 10000 else iv)


def project_onto_shape(x, y, pts, cum, seg_start=0, seg_end=None):
    """Project (x, y) onto polyline pts[seg_start..seg_end]. Returns (dist, seg_idx, s, px, py)."""
    n = len(pts)
    if seg_end is None or seg_end > n - 1:
        seg_end = n - 1
    best_d2 = 1e18
    best_seg = seg_start
    best_s = cum[seg_start]
    best_px = pts[seg_start][0]
    best_py = pts[seg_start][1]

    for i in range(seg_start, seg_end):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        dx = bx - ax
        dy = by - ay
        l2 = dx * dx + dy * dy
        if l2 == 0.0:
            t = 0.0
            px, py = ax, ay
        else:
            t = ((x - ax) * dx + (y - ay) * dy) / l2
            if t < 0.0:
                t = 0.0
            elif t > 1.0:
                t = 1.0
            px = ax + t * dx
            py = ay + t * dy
        d2 = (x - px) * (x - px) + (y - py) * (y - py)
        if d2 < best_d2:
            best_d2 = d2
            best_seg = i
            best_s = cum[i] + t * (cum[i + 1] - cum[i])
            best_px = px
            best_py = py

    return math.sqrt(best_d2), best_seg, best_s, best_px, best_py


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


class HybridRoadAligner:
    def __init__(self, gtfs_pkl=GTFS_PKL, roads_json=ROADS_JSON):
        t0 = time.time()
        with open(gtfs_pkl, "rb") as f:
            g = pickle.load(f)
        self.route_info = g["route_info"]
        self.route_shapes = g["route_shapes"]
        self.by_line = g["by_line"]
        self.shapes = g["shapes"]

        # Load and stitch OSM road graph (only keep main connected component!)
        self._load_stitched_osm(roads_json)
        self.snap_cache = {}
        self.path_cache = {}
        self.stats = {
            "gtfs_segs": 0,
            "osm_segs": 0,
            "raw_segs": 0,
            "gtfs_rides": 0,
            "total_rides": 0,
        }
        print(
            f"HybridRoadAligner ready in {time.time() - t0:.2f}s "
            f"({len(self.shapes):,} GTFS shapes, {len(self.main_nodes):,} stitched OSM nodes)",
            flush=True,
        )

    def _load_stitched_osm(self, roads_json):
        with open(roads_json, "r") as f:
            raw = json.load(f)["roads"]

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
            adj[u].append((v, w))
            adj[v].append((u, w))

        # Stitch vector-tile seams & rounding gaps within 6 units (~8m)
        stitch_grid = defaultdict(list)
        for nid in range(len(node_x)):
            stitch_grid[(node_x[nid] // 6, node_y[nid] // 6)].append(nid)

        for u in range(len(node_x)):
            ux, uy = node_x[u], node_y[u]
            cx, cy = ux // 6, uy // 6
            existing = {nb for nb, _ in adj[u]}
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for v in stitch_grid.get((cx + dx, cy + dy), ()):
                        if v <= u or v in existing:
                            continue
                        ddx = node_x[v] - ux
                        ddy = node_y[v] - uy
                        if abs(ddx) <= 6 and abs(ddy) <= 6:
                            d = math.hypot(ddx, ddy)
                            if d <= 6.5:
                                t = min(node_min_tier[u], node_min_tier[v])
                                w = d * TIER_WEIGHT[t]
                                adj[u].append((v, w))
                                adj[v].append((u, w))

        # Keep largest connected component(s) with >= 300 nodes so snaps never land on dead islands
        seen = bytearray(len(node_x))
        main_nodes = set()
        for start in range(len(node_x)):
            if seen[start]:
                continue
            comp = []
            q = deque([start])
            seen[start] = 1
            while q:
                c = q.popleft()
                comp.append(c)
                for nb, _ in adj[c]:
                    if not seen[nb]:
                        seen[nb] = 1
                        q.append(nb)
            if len(comp) >= 300:
                main_nodes.update(comp)

        grid = defaultdict(list)
        for nid in main_nodes:
            grid[(node_x[nid] // CELL_SIZE, node_y[nid] // CELL_SIZE)].append(nid)

        self.node_x = node_x
        self.node_y = node_y
        self.node_min_tier = node_min_tier
        self.adj = adj
        self.main_nodes = main_nodes
        self.grid = grid

    def _snap_osm(self, x, y):
        key = (x << 14) | y
        res = self.snap_cache.get(key)
        if res is not None:
            return res
        cx, cy = x // CELL_SIZE, y // CELL_SIZE
        best_id = -1
        best_score = 1e18
        max_d2 = MAX_SNAP_DIST * MAX_SNAP_DIST
        nx_arr = self.node_x
        ny_arr = self.node_y
        nt_arr = self.node_min_tier
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                bucket = self.grid.get((cx + dx, cy + dy))
                if not bucket:
                    continue
                for nid in bucket:
                    ddx = nx_arr[nid] - x
                    ddy = ny_arr[nid] - y
                    d2 = ddx * ddx + ddy * ddy
                    if d2 > max_d2:
                        continue
                    score = math.sqrt(d2) + TIER_SNAP_PENALTY[nt_arr[nid]]
                    if score < best_score:
                        best_score = score
                        best_id = nid
        self.snap_cache[key] = best_id
        return best_id

    def _route_osm(self, u, v):
        if u == v or u < 0 or v < 0:
            return None
        key = (u, v)
        cached = self.path_cache.get(key)
        if cached is not None:
            return cached
        ux, uy = self.node_x[u], self.node_y[u]
        vx, vy = self.node_x[v], self.node_y[v]
        straight = math.hypot(vx - ux, vy - uy)
        if straight < 14.0 or straight > 1800.0:
            return None

        max_cost = straight * 2.2 + 100.0
        min_x = min(ux, vx) - straight * 0.45 - 80
        max_x = max(ux, vx) + straight * 0.45 + 80
        min_y = min(uy, vy) - straight * 0.45 - 80
        max_y = max(uy, vy) + straight * 0.45 + 80

        h_scale = 0.90
        pq = [(straight * h_scale, 0.0, u)]
        g_score = {u: 0.0}
        parent = {}
        expansions = 0
        found = False
        nx_arr = self.node_x
        ny_arr = self.node_y
        adj = self.adj

        while pq and expansions < 2000:
            _, g, cur = heapq.heappop(pq)
            if g > g_score.get(cur, 1e18):
                continue
            if cur == v:
                found = True
                break
            expansions += 1
            for nb, w in adj[cur]:
                ng = g + w
                if ng > max_cost:
                    continue
                nx_nb = nx_arr[nb]
                ny_nb = ny_arr[nb]
                if nx_nb < min_x or nx_nb > max_x or ny_nb < min_y or ny_nb > max_y:
                    continue
                if ng < g_score.get(nb, 1e18):
                    g_score[nb] = ng
                    parent[nb] = cur
                    h = math.hypot(vx - nx_nb, vy - ny_nb) * h_scale
                    if ng + h <= max_cost:
                        heapq.heappush(pq, (ng + h, ng, nb))

        if not found:
            if len(self.path_cache) < 200000:
                self.path_cache[key] = ()
            return ()

        chain = [v]
        cur = v
        while cur != u:
            cur = parent[cur]
            chain.append(cur)
        chain.reverse()
        pts = [(nx_arr[nid], ny_arr[nid]) for nid in chain]
        res = tuple(douglas_peucker(pts, 5.0))
        if len(self.path_cache) < 200000:
            self.path_cache[key] = res
            self.path_cache[(v, u)] = tuple(reversed(res))
        return res

    def _pick_shape(self, line_ref, line_name, op_ref, raw_pts):
        sids = self.route_shapes.get(line_ref)
        if not sids and line_name:
            sids = self.by_line.get((line_name, op_ref))
        if not sids:
            return None
        if len(sids) == 1:
            return self.shapes.get(sids[0])

        # Score candidate shapes using up to 5 evenly-spaced sample pings
        n = len(raw_pts)
        step = max(1, (n - 1) // 4)
        sample = [raw_pts[i] for i in range(0, n, step)][:5]
        best_shape = None
        best_score = 1e18
        for sid in sids:
            sh = self.shapes.get(sid)
            if not sh:
                continue
            spts, scum = sh
            dists = []
            s_vals = []
            for _, x, y in sample:
                d, _, s, _, _ = project_onto_shape(x, y, spts, scum)
                dists.append(d)
                s_vals.append(s)
            avg_d = sum(dists) / len(dists)
            # Penalize backward direction along the shape
            prog = s_vals[-1] - s_vals[0]
            score = avg_d + (250.0 if prog < -40.0 else 0.0)
            if score < best_score:
                best_score = score
                best_shape = sh
        return best_shape

    def align_ride(self, line_ref, line_name, op_ref, raw_pts):
        """
        raw_pts: list of (t2, x, y) sorted by t2.
        Returns aligned list of (t2, x, y) with strictly non-decreasing t2.
        """
        self.stats["total_rides"] += 1
        n = len(raw_pts)
        if n < 2:
            return raw_pts

        sh = self._pick_shape(line_ref, line_name, op_ref, raw_pts)
        if sh is not None:
            self.stats["gtfs_rides"] += 1

        # Pre-project all pings onto GTFS shape if available
        proj = [None] * n  # (seg_idx, s, px, py) or None if off-shape
        if sh is not None:
            spts, scum = sh
            n_segs = len(spts) - 1
            prev_seg = -1
            prev_s = -1.0
            for k in range(n):
                t2, x, y = raw_pts[k]
                if prev_seg >= 0:
                    # Search local forward window first (fast + handles self-intersecting loops!)
                    seg0 = max(0, prev_seg - 2)
                    dt_min = max(0.5, (t2 - raw_pts[k - 1][0]) / 30.0)
                    max_s = prev_s + max(900.0, dt_min * 1650.0)
                    seg1 = seg0
                    while seg1 < n_segs and scum[seg1] < max_s:
                        seg1 += 1
                    d, sg, s, px, py = project_onto_shape(x, y, spts, scum, seg0, min(n_segs, seg1 + 2))
                    if d <= MAX_SHAPE_DIST and s >= prev_s - 25.0:
                        proj[k] = (sg, s, clamp_coord(px), clamp_coord(py))
                        prev_seg = sg
                        prev_s = max(prev_s, s)
                        continue
                # Full-shape search (for first ping or re-acquiring after detour)
                d, sg, s, px, py = project_onto_shape(x, y, spts, scum)
                if d <= MAX_SHAPE_DIST:
                    proj[k] = (sg, s, clamp_coord(px), clamp_coord(py))
                    prev_seg = sg
                    prev_s = s
                else:
                    prev_seg = -1

        out = []
        for k in range(n):
            t2, x, y = raw_pts[k]
            pk = proj[k]
            cur_x, cur_y = (pk[2], pk[3]) if pk is not None else (x, y)

            if k == 0:
                if pk is None:
                    nid = self._snap_osm(x, y)
                    if nid >= 0:
                        cur_x, cur_y = self.node_x[nid], self.node_y[nid]
                out.append((t2, cur_x, cur_y))
                continue

            pt2, px_raw, py_raw = raw_pts[k - 1]
            dt2 = t2 - pt2
            p_prev = proj[k - 1]

            # Case 1: Both consecutive pings are on the official GTFS shape!
            if (
                sh is not None
                and p_prev is not None
                and pk is not None
                and 0 < dt2 <= 165
                and pk[1] > p_prev[1] + 8.0
                and (pk[1] - p_prev[1]) <= max(1200.0, (dt2 / 30.0) * 1800.0)
            ):
                spts, scum = sh
                sg0, s0 = p_prev[0], p_prev[1]
                sg1, s1 = pk[0], pk[1]
                span_s = s1 - s0
                self.stats["gtfs_segs"] += 1
                # Emit exact intermediate shape vertices strictly between s0 and s1
                for j in range(sg0 + 1, sg1 + 1):
                    sj = scum[j]
                    if sj <= s0 + 2.0 or sj >= s1 - 2.0:
                        continue
                    vx, vy = spts[j]
                    if vx < 0 or vx > 10000 or vy < 0 or vy > 10000:
                        continue
                    frac = (sj - s0) / span_s
                    it2 = pt2 + int(round(dt2 * frac))
                    if it2 <= out[-1][0] or it2 >= t2:
                        continue
                    out.append((it2, clamp_coord(vx), clamp_coord(vy)))
                out.append((t2, cur_x, cur_y))
                continue

            # Case 2: Off-shape / detour / missing GTFS shape -> stitched OSM road fallback!
            if pk is None:
                nid = self._snap_osm(x, y)
                if nid >= 0:
                    cur_x, cur_y = self.node_x[nid], self.node_y[nid]
            if 0 < dt2 <= 165:
                u = self._snap_osm(out[-1][1], out[-1][2])
                v = self._snap_osm(cur_x, cur_y)
                routed = self._route_osm(u, v) if (u >= 0 and v >= 0 and u != v) else None
                if routed and len(routed) >= 3:
                    self.stats["osm_segs"] += 1
                    cum = [0.0]
                    for j in range(1, len(routed)):
                        cum.append(
                            cum[-1]
                            + math.hypot(
                                routed[j][0] - routed[j - 1][0],
                                routed[j][1] - routed[j - 1][1],
                            )
                        )
                    tot = cum[-1]
                    if tot > 0.0:
                        for j in range(1, len(routed) - 1):
                            it2 = pt2 + int(round(dt2 * (cum[j] / tot)))
                            if it2 <= out[-1][0] or it2 >= t2:
                                continue
                            out.append((it2, routed[j][0], routed[j][1]))
                    out.append((t2, cur_x, cur_y))
                    continue

            self.stats["raw_segs"] += 1
            out.append((t2, cur_x, cur_y))

        return out[:65535]
