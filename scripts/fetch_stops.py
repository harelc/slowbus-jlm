#!/usr/bin/env python3
"""
Fetch all Jerusalem bus + light-rail station coordinates for the timelapse
week (pinned to Sat 2026-11-21) from Hasadna GTFS stops (SIRI API) and pack into
a compact static file: data/jlm-stops.json.

The browser never calls the API for this — it loads the frozen file, same as
data/jlm-lightrail.json. Coordinates are stored normalized [0..10000] over the
timelapse bbox, exactly like the light-rail patterns, so timelapse.js can map
them with its existing toScreenX/toScreenY.

Output: [{"c": stop_code, "n": name, "x": nx, "y": ny}, ...] sorted by code.
"""
import json
import os
import urllib.parse
import urllib.request

LAT_MIN, LAT_MAX = 31.715, 31.835
LON_MIN, LON_MAX = 35.145, 35.285
API_BASE = "https://open-bus-stride-api.hasadna.org.il"
UA = {"User-Agent": "slowbus-jlm-stops/1.0"}
DATE = "2026-11-21"  # Saturday of the timelapse week; stop set is stable across the week
PAGE = 5000


def get(ep, params):
    url = f"{API_BASE}{ep}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def nx(lon):
    return round((lon - LON_MIN) / (LON_MAX - LON_MIN) * 10000)


def ny(lat):
    return round((LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * 10000)


def main():
    rows = []
    offset = 0
    while True:
        page = get("/gtfs_stops/list", {
            "city": "ירושלים",
            "date_from": DATE,
            "date_to": DATE,
            "limit": PAGE,
            "offset": offset,
        })
        rows.extend(page)
        print(f"  fetched {len(rows)} stops…", flush=True)
        if len(page) < PAGE:
            break
        offset += PAGE

    # One row per stop code (API can repeat a stop); keep stops inside the map bbox
    by_code = {}
    for r in rows:
        lat, lon, code = r.get("lat"), r.get("lon"), r.get("code")
        if lat is None or lon is None or code is None:
            continue
        if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
            continue
        by_code[int(code)] = {
            "c": int(code),
            "n": (r.get("name") or "").strip(),
            "x": nx(lon),
            "y": ny(lat),
        }

    stops = [by_code[c] for c in sorted(by_code)]
    os.makedirs("data", exist_ok=True)
    out_path = "data/jlm-stops.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(stops, f, ensure_ascii=False, separators=(",", ":"))
    kb = os.path.getsize(out_path) / 1024
    print(f"Wrote {out_path}: {len(stops)} stops ({kb:.1f} KB)")


if __name__ == "__main__":
    main()
