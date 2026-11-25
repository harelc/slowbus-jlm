#!/usr/bin/env python3
"""
Fetch 100% real Jerusalem SIRI GPS vehicle trajectories for a full week
(Sun 2026-11-15 -> Sat 2026-11-21) from Open Bus Stride and pack into
compact per-day binary files: data/real-day0.bin .. data/real-day6.bin.

Outage backfill (same weekday one week earlier, real GPS data):
  - Wed 2026-11-18 21:40..24:00 -> Wed 2026-11-11
  - Thu 2026-11-19 00:00..17:00 -> Thu 2026-11-12
"""
import concurrent.futures
import datetime
import json
import os
import struct
import sys
import time
import urllib.parse
import urllib.request

LAT_MIN, LAT_MAX = 31.715, 31.835
LON_MIN, LON_MAX = 35.145, 35.285
API_BASE = "https://open-bus-stride-api.hasadna.org.il"
UA = {"User-Agent": "slowbus-jlm-real/1.0"}


def api_get(path, params, timeout=30):
    url = f"{API_BASE}{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as e:
            if attempt == 4:
                print(f"  WARN {path} failed: {e}", flush=True)
                return []
            time.sleep(1.2 * (attempt + 1))


def load_known_line_refs():
    ref_to_line = {}
    try:
        with open("data/jlm-lines.json") as f:
            for item in json.load(f):
                ln = str(item["line"])
                for lr in item.get("lineRefs", []):
                    ref_to_line[int(lr)] = ln
    except Exception:
        pass
    return ref_to_line


def resolve_missing_line_refs(missing_refs, ref_to_line):
    if not missing_refs:
        return
    refs = sorted(missing_refs)
    print(f"  Resolving {len(refs)} extra line_refs via gtfs_routes...", flush=True)
    # Fetch in chunks by querying gtfs_routes for line_ref
    def lookup(lr):
        rows = api_get("/gtfs_routes/list", {"line_ref": lr, "limit": 1, "order_by": "date desc"}, timeout=15)
        if rows and rows[0].get("route_short_name"):
            return lr, str(rows[0]["route_short_name"])
        return lr, None

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        for lr, name in ex.map(lookup, refs):
            if name:
                ref_to_line[lr] = name


def fetch_window(dt0, dt1):
    """Fetch all vehicle locations in [dt0, dt1). Auto-bisects if limit=5000 is hit."""
    rows = api_get("/siri_vehicle_locations/list", {
        "limit": 5000,
        "recorded_at_time_from": dt0.strftime("%Y-%m-%dT%H:%M:%S+02:00"),
        "recorded_at_time_to": dt1.strftime("%Y-%m-%dT%H:%M:%S+02:00"),
        "lat__greater_or_equal": LAT_MIN,
        "lat__lower_or_equal": LAT_MAX,
        "lon__greater_or_equal": LON_MIN,
        "lon__lower_or_equal": LON_MAX,
    })
    if len(rows) >= 5000 and (dt1 - dt0).total_seconds() > 30:
        mid = dt0 + (dt1 - dt0) / 2
        return fetch_window(dt0, mid) + fetch_window(mid, dt1)
    return rows


def parse_iso_sec_of_day(iso_str):
    # API returns UTC like "2026-11-15T06:00:37+00:00"; Jerusalem is UTC+2 in November
    # Fast parse without slow strptime
    hh = int(iso_str[11:13])
    mm = int(iso_str[14:16])
    ss = int(iso_str[17:19])
    # Convert UTC to +02:00
    if iso_str.endswith("+00:00") or iso_str.endswith("Z"):
        hh = (hh + 2) % 24
    return hh * 3600 + mm * 60 + ss


def nx(lon):
    v = round((lon - LON_MIN) / (LON_MAX - LON_MIN) * 10000)
    return 0 if v < 0 else (10000 if v > 10000 else v)


def ny(lat):
    v = round((LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * 10000)
    return 0 if v < 0 else (10000 if v > 10000 else v)


def fetch_day(day_idx, ref_to_line):
    base_date = datetime.datetime(2026, 11, 15, 0, 0, 0) + datetime.timedelta(days=day_idx)
    step_min = 3
    windows = []
    for m in range(0, 1440, step_min):
        dt0 = base_date + datetime.timedelta(minutes=m)
        # Apply real-data backfill for Open Bus Stride collector outages
        if day_idx == 3 and m >= 21 * 60 + 40:  # Wed late evening
            dt0 = dt0 - datetime.timedelta(days=7)
        elif day_idx == 4 and m < 17 * 60:      # Thu 00:00..17:00
            dt0 = dt0 - datetime.timedelta(days=7)
        dt1 = dt0 + datetime.timedelta(minutes=step_min)
        windows.append((m, dt0, dt1))

    t0 = time.time()
    # ride_id -> [line_ref, op_ref, [(t_sec2, x, y), ...]]
    rides = {}
    total_pings = 0
    done = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(fetch_window, dt0, dt1): m for (m, dt0, dt1) in windows}
        for f in concurrent.futures.as_completed(futs):
            rows = f.result()
            done += 1
            for r in rows:
                rid = r.get("siri_ride__id")
                lat = r.get("lat")
                lon = r.get("lon")
                ts = r.get("recorded_at_time")
                if rid is None or lat is None or lon is None or not ts:
                    continue
                if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
                    continue
                sec = parse_iso_sec_of_day(ts)
                t2 = min(43200, max(0, sec // 2))
                x = nx(lon)
                y = ny(lat)
                rec = rides.get(rid)
                if rec is None:
                    lr = r.get("siri_route__line_ref") or 0
                    op = r.get("siri_route__operator_ref") or 0
                    rides[rid] = [int(lr), int(op), [(t2, x, y)]]
                else:
                    rec[2].append((t2, x, y))
                total_pings += 1
            if done % 80 == 0 or done == len(windows):
                print(f"  Day {day_idx} ({base_date.strftime('%a %Y-%m-%d')}): {done}/{len(windows)} windows, {len(rides)} rides, {total_pings} pings ({time.time()-t0:.1f}s)", flush=True)

    # Resolve any unknown line_refs
    missing = {rec[0] for rec in rides.values() if rec[0] and rec[0] not in ref_to_line}
    if missing:
        resolve_missing_line_refs(missing, ref_to_line)

    # Clean, sort, deduplicate timestamps per ride, and strip midnight wraparound glitches
    cleaned_rides = []
    line_names = []
    line_to_idx = {}

    for rid, (lr, op, pts) in rides.items():
        if len(pts) < 2:
            continue
        pts.sort(key=lambda p: p[0])
        dedup = []
        last_t = -1
        for t2, x, y in pts:
            if t2 == last_t:
                continue
            # Drop single-point >2.5km teleport spikes if adjacent to normal points
            dedup.append((t2, x, y))
            last_t = t2
        if len(dedup) < 2:
            continue
        # Remove single-ping GPS spikes
        if len(dedup) >= 3:
            good = [dedup[0]]
            for i in range(1, len(dedup) - 1):
                p0, p1, p2 = good[-1], dedup[i], dedup[i + 1]
                d01 = abs(p1[1] - p0[1]) + abs(p1[2] - p0[2])
                d12 = abs(p2[1] - p1[1]) + abs(p2[2] - p1[2])
                d02 = abs(p2[1] - p0[1]) + abs(p2[2] - p0[2])
                if d01 > 900 and d12 > 900 and d02 < 500:
                    continue
                good.append(p1)
            good.append(dedup[-1])
            dedup = good

        ln = ref_to_line.get(lr, "")
        if ln:
            lidx = line_to_idx.get(ln)
            if lidx is None:
                lidx = len(line_names)
                line_to_idx[ln] = lidx
                line_names.append(ln)
        else:
            lidx = 0xFFFF
        cleaned_rides.append((dedup[0][0], lidx, min(255, max(0, op)), dedup))

    cleaned_rides.sort(key=lambda r: r[0])

    # Pack binary:
    # Header: "SBJ1" (4B), dayIdx (1B), lineCount (2B), [len(1B)+utf8...], rideCount (4B)
    # Per ride: lineIdx (2B), opRef (1B), ptCount (2B), ptCount * (t2:2B, x:2B, y:2B)
    os.makedirs("data", exist_ok=True)
    out_path = f"data/real-day{day_idx}.bin"
    with open(out_path, "wb") as f:
        f.write(b"SBJ1")
        f.write(struct.pack("<BH", day_idx, len(line_names)))
        for ln in line_names:
            b = ln.encode("utf-8")[:255]
            f.write(struct.pack("<B", len(b)))
            f.write(b)
        f.write(struct.pack("<I", len(cleaned_rides)))
        for _, lidx, op, pts in cleaned_rides:
            f.write(struct.pack("<HBH", lidx, op, len(pts)))
            for t2, x, y in pts:
                f.write(struct.pack("<HHH", t2, x, y))

    mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"  Wrote {out_path}: {len(cleaned_rides)} rides, {len(line_names)} lines, {mb:.2f} MB in {time.time()-t0:.1f}s", flush=True)


def main():
    days = [int(a) for a in sys.argv[1:]] if len(sys.argv) > 1 else [0, 6, 1, 2, 3, 4, 5]
    ref_to_line = load_known_line_refs()
    print(f"Loaded {len(ref_to_line)} known lineRefs from data/jlm-lines.json", flush=True)
    for d in days:
        out_path = f"data/real-day{d}.bin"
        if os.path.exists(out_path) and "--force" not in sys.argv:
            print(f"  Skipping day {d} ({out_path} already exists)", flush=True)
            continue
        fetch_day(d, ref_to_line)


if __name__ == "__main__":
    main()
