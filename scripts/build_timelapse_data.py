#!/usr/bin/env python3
"""
Build real Jerusalem road geometry + 7-day SIRI bus telemetry for the SlowBus JLM timelapse.

Sources:
  - Road network: Versatiles OSM vector tiles (z14, `streets` layer)
  - Bus telemetry: Open Bus Stride API (/siri_vehicle_locations/list),
    Sun 2026-11-15 00:00 -> Sat 2026-11-21 23:40 Asia/Jerusalem (+02:00),
    2-minute snapshot every 20 minutes (504 slices across the full week).

Output:
  data/jlm-timelapse.json
"""
import concurrent.futures
import datetime
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

# Jerusalem framing bbox (16:9 friendly around Greater Jerusalem)
LAT_MIN, LAT_MAX = 31.715, 31.835
LON_MIN, LON_MAX = 35.145, 35.285

ROAD_TIER = {
    "motorway": 0, "motorway_link": 0, "trunk": 0, "trunk_link": 0,
    "primary": 1, "primary_link": 1,
    "secondary": 2, "secondary_link": 2,
    "tertiary": 3, "tertiary_link": 3, "busway": 2,
    "unclassified": 4, "residential": 4, "living_street": 4, "road": 4,
}

# --- Minimal MVT protobuf decoder (matches app.js, handles MVT v1 & v2) ---
def varint(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s; s += 7
        if not (x & 0x80):
            return r, i

def fields(b):
    i = 0; n = len(b)
    while i < n:
        tag, i = varint(b, i)
        f, w = tag >> 3, tag & 7
        if w == 0:
            v, i = varint(b, i); yield f, w, v
        elif w == 2:
            l, i = varint(b, i); yield f, w, b[i:i + l]; i += l
        elif w == 5:
            yield f, w, b[i:i + 4]; i += 4
        elif w == 1:
            yield f, w, b[i:i + 8]; i += 8
        else:
            raise ValueError(f"bad wire {w}")

def decode_streets_tile(buf, tx, ty, z):
    ways = []
    n_tiles = 1 << z
    for tf, tw, layer_buf in fields(buf):
        if tf != 3 or tw != 2:
            continue
        name = ""; extent = 4096
        feats = []; keys = []; vals = []
        for lf, lw, lv in fields(layer_buf):
            if lf == 1: name = lv.decode("utf-8", "replace")
            elif lf == 2: feats.append(lv)
            elif lf == 3: keys.append(lv.decode("utf-8", "replace"))
            elif lf == 4:
                val = None
                for vf, vw, vv in fields(lv):
                    if vf == 1: val = vv.decode("utf-8", "replace")
                    elif vf == 7: val = bool(vv)
                    else: val = vv
                vals.append(val)
            elif lf == 5: extent = lv
        if name != "streets":
            continue
        for fb in feats:
            ftype = 0; tags = []; geom = []
            for ff, fw, fv in fields(fb):
                if ff == 2 and fw == 2:
                    ii = 0
                    while ii < len(fv):
                        t, ii = varint(fv, ii); tags.append(t)
                elif fw == 0 and (ff == 3 or (ff == 1 and fv <= 3)):
                    ftype = fv
                elif fw == 2 and ff in (3, 4):
                    ii = 0
                    while ii < len(fv):
                        t, ii = varint(fv, ii); geom.append(t)
            if ftype != 2:
                continue
            props = {}
            for i in range(0, len(tags) - 1, 2):
                k = keys[tags[i]] if tags[i] < len(keys) else ""
                v = vals[tags[i + 1]] if tags[i + 1] < len(vals) else None
                props[k] = v
            kind = props.get("kind")
            if kind not in ROAD_TIER:
                continue
            tier = ROAD_TIER[kind]
            x = y = i = 0; line = None
            while i < len(geom):
                cmd = geom[i] & 7; count = geom[i] >> 3; i += 1
                for _ in range(count):
                    if cmd in (1, 2):
                        dx = (geom[i] >> 1) ^ -(geom[i] & 1)
                        dy = (geom[i + 1] >> 1) ^ -(geom[i + 1] & 1)
                        i += 2; x += dx; y += dy
                        lon = (tx + x / extent) / n_tiles * 360.0 - 180.0
                        nn = math.pi * (1.0 - 2.0 * (ty + y / extent) / n_tiles)
                        lat = math.degrees(math.atan(math.sinh(nn)))
                        if cmd == 1:
                            if line and len(line) > 1:
                                ways.append((tier, line))
                            line = []
                        line.append((lat, lon))
            if line and len(line) > 1:
                ways.append((tier, line))
    return ways

def fetch_roads():
    z = 14; n = 1 << z
    tx = lambda lon: int((lon + 180.0) / 360.0 * n)
    ty = lambda lat: int((1.0 - math.log(math.tan(math.radians(lat)) + 1.0 / math.cos(math.radians(lat))) / math.pi) / 2.0 * n)
    x0, x1 = tx(LON_MIN), tx(LON_MAX)
    y0, y1 = ty(LAT_MAX), ty(LAT_MIN)
    tiles = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    print(f"Fetching {len(tiles)} Versatiles z14 road tiles...", flush=True)

    def get_tile(xy):
        x, y = xy
        url = f"https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}.pbf"
        req = urllib.request.Request(url, headers={"User-Agent": "slowbus-jlm-timelapse/1.0"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    return decode_streets_tile(r.read(), x, y, z)
            except Exception:
                if attempt == 2:
                    return []
                time.sleep(1.0)

    ways = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        for res in ex.map(get_tile, tiles):
            ways.extend(res)
    print(f"Decoded {len(ways)} raw road polylines", flush=True)

    # Convert to segments (<=120m pieces) inside bbox and build spatial bucket index
    lat0 = (LAT_MIN + LAT_MAX) / 2.0
    m_lat = 110540.0
    m_lon = 111320.0 * math.cos(math.radians(lat0))
    to_xy = lambda lat, lon: (lon * m_lon, lat * m_lat)

    segments = []  # (tier, lat1, lon1, lat2, lon2, ax, ay, bx, by)
    seen = set()
    for tier, coords in ways:
        for i in range(len(coords) - 1):
            a, b = coords[i], coords[i + 1]
            if not (LAT_MIN - 0.005 <= a[0] <= LAT_MAX + 0.005 and LON_MIN - 0.005 <= a[1] <= LON_MAX + 0.005):
                if not (LAT_MIN - 0.005 <= b[0] <= LAT_MAX + 0.005 and LON_MIN - 0.005 <= b[1] <= LON_MAX + 0.005):
                    continue
            ax, ay = to_xy(a[0], a[1]); bx, by = to_xy(b[0], b[1])
            dist = math.hypot(bx - ax, by - ay)
            if dist < 6.0:
                continue
            pieces = max(1, math.ceil(dist / 120.0))
            for s in range(pieces):
                f0, f1 = s / pieces, (s + 1) / pieces
                la1 = a[0] + (b[0] - a[0]) * f0; lo1 = a[1] + (b[1] - a[1]) * f0
                la2 = a[0] + (b[0] - a[0]) * f1; lo2 = a[1] + (b[1] - a[1]) * f1
                # Deduplicate overlapping tile-border segments
                k = (round(la1, 4), round(lo1, 4), round(la2, 4), round(lo2, 4))
                if k in seen:
                    continue
                seen.add(k)
                segments.append((
                    tier, la1, lo1, la2, lo2,
                    ax + (bx - ax) * f0, ay + (by - ay) * f0,
                    ax + (bx - ax) * f1, ay + (by - ay) * f1,
                ))
    print(f"Built {len(segments)} unique road segments", flush=True)
    return segments, to_xy

def build_spatial_index(segments):
    cell = 80.0
    buckets = {}
    for idx, seg in enumerate(segments):
        _, _, _, _, _, ax, ay, bx, by = seg
        for x, y in ((ax, ay), (bx, by), ((ax + bx) * 0.5, (ay + by) * 0.5)):
            k = (int(x // cell), int(y // cell))
            buckets.setdefault(k, []).append(idx)
    return buckets, cell

def snap_point(px, py, segments, buckets, cell, snap_m=50.0):
    gx, gy = int(px // cell), int(py // cell)
    best = -1; best_d = snap_m
    for cx in (gx - 1, gx, gx + 1):
        for cy in (gy - 1, gy, gy + 1):
            for idx in buckets.get((cx, cy), ()):
                _, _, _, _, _, ax, ay, bx, by = segments[idx]
                dx, dy = bx - ax, by - ay
                l2 = dx * dx + dy * dy
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2)) if l2 else 0.0
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
                if d < best_d:
                    best_d = d; best = idx
    return best

def fetch_week_slices(segments, buckets, cell, to_xy):
    # Full week: Sun 2026-11-15 00:00 -> Sat 2026-11-21 23:40 (+02:00), every 20 min = 504 slices
    start = datetime.datetime(2026, 11, 15, 0, 0, 0)
    step_min = 20
    total_slices = 7 * (24 * 60 // step_min)  # 504
    base_url = "https://open-bus-stride-api.hasadna.org.il/siri_vehicle_locations/list"

    def fetch_one(i):
        dt0 = start + datetime.timedelta(minutes=i * step_min)
        dt1 = dt0 + datetime.timedelta(minutes=2)
        q = urllib.parse.urlencode({
            "limit": 5000,
            "recorded_at_time_from": dt0.strftime("%Y-%m-%dT%H:%M:%S+02:00"),
            "recorded_at_time_to": dt1.strftime("%Y-%m-%dT%H:%M:%S+02:00"),
            "lat__greater_or_equal": LAT_MIN, "lat__lower_or_equal": LAT_MAX,
            "lon__greater_or_equal": LON_MIN, "lon__lower_or_equal": LON_MAX,
        })
        url = f"{base_url}?{q}"
        data = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "slowbus-jlm-timelapse/1.0"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = json.load(r)
                break
            except Exception as e:
                if attempt == 3:
                    print(f"  WARN slice {i} ({dt0}): {e}", flush=True)
                    data = []
                else:
                    time.sleep(1.5 * (attempt + 1))

        rides = set()
        vel_all = []
        vel_mov = []
        seg_agg = {}  # segIdx -> [count, velSum, movCount, movSum]
        for p in data:
            v = p.get("velocity")
            if v is None or v < 0 or v > 100:
                continue
            lat, lon = p.get("lat"), p.get("lon")
            if lat is None or lon is None:
                continue
            rid = p.get("siri_ride__id")
            if rid is not None:
                rides.add(rid)
            vel_all.append(v)
            if v > 0:
                vel_mov.append(v)
            px, py = to_xy(lat, lon)
            sidx = snap_point(px, py, segments, buckets, cell)
            if sidx >= 0:
                a = seg_agg.get(sidx)
                if a is None:
                    seg_agg[sidx] = [1, v, 1 if v > 0 else 0, v if v > 0 else 0]
                else:
                    a[0] += 1; a[1] += v
                    if v > 0:
                        a[2] += 1; a[3] += v

        # Pack per-segment stats: [segIdx, count, avgSpeedAll]
        packed = []
        for sidx, (cnt, vsum, mcnt, mvsum) in seg_agg.items():
            # Use moving avg if available for richer visual speed contrast, fallback to all
            spd = round(mvsum / mcnt) if mcnt > 0 else round(vsum / cnt)
            packed.extend((sidx, cnt, spd))

        avg_all = round(sum(vel_all) / len(vel_all), 1) if vel_all else 0.0
        avg_mov = round(sum(vel_mov) / len(vel_mov), 1) if vel_mov else 0.0
        return i, {
            "d": i // (24 * 60 // step_min),           # day 0..6 (Sun..Sat)
            "m": (i * step_min) % (24 * 60),          # minute of day 0..1420
            "b": len(rides),                          # unique active buses
            "p": len(vel_all),                        # valid GPS pings
            "va": avg_all,                            # avg speed incl stopped
            "vm": avg_mov,                            # avg speed moving
            "s": packed,                              # flat [segIdx, count, speed, ...]
        }

    t0 = time.time()
    results = [None] * total_slices
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(fetch_one, i) for i in range(total_slices)]
        for f in concurrent.futures.as_completed(futs):
            i, rec = f.result()
            results[i] = rec
            done += 1
            if done % 48 == 0 or done == total_slices:
                print(f"  Fetched {done}/{total_slices} slices ({time.time() - t0:.1f}s)", flush=True)
    return results

def main():
    segments, to_xy = fetch_roads()
    buckets, cell = build_spatial_index(segments)
    slices = fetch_week_slices(segments, buckets, cell, to_xy)

    # Compact road table: keep all segments, encode normalized [0..10000] coords
    def nx(lon): return round((lon - LON_MIN) / (LON_MAX - LON_MIN) * 10000)
    def ny(lat): return round((LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * 10000)

    # Remap active segment indices so active segments come first, background-only after
    active_ids = set()
    for sl in slices:
        s = sl["s"]
        for j in range(0, len(s), 3):
            active_ids.add(s[j])
    print(f"Active road segments across the week: {len(active_ids)} / {len(segments)}", flush=True)

    # Keep all active segments + all tier<=3 arterials + 1-in-1 residential for crisp urban texture
    old_to_new = {}
    roads_out = []  # flat [tier, x1, y1, x2, y2, ...]
    for old_idx, seg in enumerate(segments):
        tier, la1, lo1, la2, lo2, *_ = seg
        if old_idx in active_ids or tier <= 4:
            new_idx = len(roads_out) // 5
            old_to_new[old_idx] = new_idx
            roads_out.extend((tier, nx(lo1), ny(la1), nx(lo2), ny(la2)))

    for sl in slices:
        s = sl["s"]
        for j in range(0, len(s), 3):
            s[j] = old_to_new[s[j]]

    landmarks = [
        {"name": "Old City", "x": nx(35.2305), "y": ny(31.7767)},
        {"name": "Central Station", "x": nx(35.2033), "y": ny(31.7892)},
        {"name": "Mt. Scopus", "x": nx(35.2426), "y": ny(31.7931)},
        {"name": "Ramot", "x": nx(35.1970), "y": ny(31.8165)},
        {"name": "Pisgat Ze'ev", "x": nx(35.2405), "y": ny(31.8240)},
        {"name": "Gilo", "x": nx(35.1885), "y": ny(31.7320)},
        {"name": "Malha", "x": nx(35.1880), "y": ny(31.7515)},
        {"name": "Talpiot", "x": nx(35.2195), "y": ny(31.7510)},
        {"name": "Givat Shaul", "x": nx(35.1855), "y": ny(31.7905)},
        {"name": "Har Homa", "x": nx(35.2225), "y": ny(31.7240)},
    ]

    out = {
        "meta": {
            "city": "Jerusalem",
            "startDate": "2026-11-15",
            "endDate": "2026-11-21",
            "days": ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
            "stepMinutes": 20,
            "bbox": [LAT_MIN, LON_MIN, LAT_MAX, LON_MAX],
            "roadCount": len(roads_out) // 5,
            "activeRoadCount": len(active_ids),
            "source": "Open Bus Stride API (Hasadna) & OpenStreetMap via Versatiles",
        },
        "landmarks": landmarks,
        "roads": roads_out,
        "slices": slices,
    }

    os.makedirs("data", exist_ok=True)
    out_path = "data/jlm-timelapse.json"
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"Wrote {out_path} ({size_mb:.2f} MB)", flush=True)

if __name__ == "__main__":
    main()
