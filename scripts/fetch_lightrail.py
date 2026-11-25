#!/usr/bin/env python3
"""
Fetch 7-day official GTFS timetable + exact station coordinates for
Jerusalem Light Rail L1 and L3 (Kfir, operator_ref=21, route_type=0)
for Sun 2026-11-15 -> Sat 2026-11-21 from Open Bus Stride.
Output: data/jlm-lightrail.json
"""
import datetime
import json
import os
import urllib.parse
import urllib.request

LAT_MIN, LAT_MAX = 31.715, 31.835
LON_MIN, LON_MAX = 35.145, 35.285
API_BASE = "https://open-bus-stride-api.hasadna.org.il"
UA = {"User-Agent": "slowbus-jlm-lightrail/1.0"}


def get(ep, params):
    url = f"{API_BASE}{ep}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)


def parse_utc_to_local_min(iso_str, base_date_str):
    # Returns minutes relative to base_date 00:00:00+02:00
    dt_utc = datetime.datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    dt_local = dt_utc + datetime.timedelta(hours=2)
    base = datetime.datetime.fromisoformat(base_date_str + "T00:00:00+00:00")
    return round((dt_local - base).total_seconds() / 60.0, 2)


def nx(lon):
    return round((lon - LON_MIN) / (LON_MAX - LON_MIN) * 10000)


def ny(lat):
    return round((LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * 10000)


def main():
    start_date = datetime.date(2026, 11, 15)
    # Compact structure:
    # patterns: [ { line: "L1"|"L3", stops: [ [fracT, nx, ny], ... ] } ]
    # days[0..6]: [ [patternIdx, t0Min, t1Min], ... ]
    patterns = []
    pattern_key_to_idx = {}
    days = [[] for _ in range(7)]

    for d in range(7):
        date_str = (start_date + datetime.timedelta(days=d)).isoformat()
        routes = get("/gtfs_routes/list", {
            "operator_refs": "21",
            "date_from": date_str,
            "date_to": date_str,
            "limit": 50,
        })
        l_routes = [r for r in routes if r.get("route_short_name") in ("1", "3")]
        day_rides = []
        for r in l_routes:
            short = "L" + str(r["route_short_name"])
            rides = get("/gtfs_rides/list", {"gtfs_route_id": r["id"], "limit": 1000})
            if not rides:
                continue
            # Fetch stop sequence + relative timing from a representative ride
            sample_stops = get("/gtfs_ride_stops/list", {
                "gtfs_ride_ids": str(rides[0]["id"]),
                "limit": 100,
            })
            sample_stops.sort(key=lambda s: s.get("stop_sequence") or 0)
            pts = []
            t_start = None
            t_end = None
            for s in sample_stops:
                lat, lon = s.get("gtfs_stop__lat"), s.get("gtfs_stop__lon")
                at = s.get("arrival_time") or s.get("departure_time")
                if lat is None or lon is None or not at:
                    continue
                tm = parse_utc_to_local_min(at, date_str)
                if t_start is None:
                    t_start = tm
                t_end = tm
                pts.append((tm, nx(lon), ny(lat)))
            if len(pts) < 2 or t_end <= t_start:
                continue
            span = t_end - t_start
            norm_stops = [[round((tm - t_start) / span, 4), x, y] for (tm, x, y) in pts]
            pkey = (short, tuple((x, y) for _, x, y in norm_stops))
            pidx = pattern_key_to_idx.get(pkey)
            if pidx is None:
                pidx = len(patterns)
                pattern_key_to_idx[pkey] = pidx
                patterns.append({"line": short, "stops": norm_stops})

            for ride in rides:
                st, en = ride.get("start_time"), ride.get("end_time")
                if not st or not en:
                    continue
                t0 = parse_utc_to_local_min(st, date_str)
                t1 = parse_utc_to_local_min(en, date_str)
                if t1 <= t0 or t1 < 0 or t0 > 1440:
                    continue
                day_rides.append([pidx, t0, t1])

        day_rides.sort(key=lambda x: x[1])
        days[d] = day_rides
        l1_c = sum(1 for x in day_rides if patterns[x[0]]["line"] == "L1")
        l3_c = sum(1 for x in day_rides if patterns[x[0]]["line"] == "L3")
        print(f"Day {d} ({date_str}): L1={l1_c} rides, L3={l3_c} rides", flush=True)

    os.makedirs("data", exist_ok=True)
    out = {"patterns": patterns, "days": days}
    with open("data/jlm-lightrail.json", "w") as f:
        json.dump(out, f, separators=(",", ":"))
    kb = os.path.getsize("data/jlm-lightrail.json") / 1024
    print(f"Wrote data/jlm-lightrail.json ({kb:.1f} KB, {len(patterns)} patterns)", flush=True)


if __name__ == "__main__":
    main()
