# SlowBus JLM — Jerusalem bus speeds on an OSM map

A zero-build map viewer that overlays **average bus speeds aggregated onto roads**
in Jerusalem, from [Hasadna's SIRI API](https://open-bus-stride-api.hasadna.org.il/docs)
(Hasadna / Public Knowledge Workshop). No API key, no backend, no build step.

## Run

```bash
cd slowbus-jlm  # this repo
python3 -m http.server 8877
# open http://localhost:8877
```

Pick a date + time window (default: yesterday 07:00–07:30 Asia/Jerusalem), click
**Load speeds**. Start with 15–30 min — Jerusalem produces ≈55k SIRI points/hour.

## How it works

| Step | Detail |
|---|---|
| Basemap | OpenStreetMap raster tiles via Leaflet 1.9.4 (CDN), desaturated with a CSS `grayscale` filter (CARTO's free basemap now watermarks tiles with “API KEY REQUIRED”, so it is not used) |
| Bus data | `GET https://open-bus-stride-api.hasadna.org.il/siri_vehicle_locations/list` with `recorded_at_time_from/to` + `lat/lon__greater_or_equal/lower_or_equal` for the Jerusalem viewport, paged at 5,000 (API allows up to 500k streamed). CORS is `*`, so the browser calls it directly. Each record has `lat`, `lon`, `velocity` (km/h), `bearing`, `siri_route__line_ref`. |
| Cleaning | Drop `velocity > 100 km/h` (GPS errors — a live sample contained 255 km/h). ~49% of points are `velocity = 0` (stops/dwell/traffic); toggleable. |
| Road mode | Fetch OSM streets for the viewport from Versatiles vector tiles (`tiles.versatiles.org`, `streets` layer at z13, decoded in-browser; Overpass was returning 502 'at capacity'), split ways into ≤60 m pieces, project each GPS point to the nearest piece within 35 m (local metre grid + segment-bucket index), then mean/median per piece. Colour = avg speed, width ∝ sample count. |
| Grid mode | Mean/median per ≈110 m cell. Same idea as the API's own `GET /siri_velocity_aggregation/siri_velocity_aggregation?recorded_from=…&lon_min/max&lat_min/max&rounding_precision=…` (returns `rounded_lon/lat`, `total_sample_count`, `average_rolling_avg`, `stddev_rolling_avg`), but done client-side because that endpoint takes only `recorded_from` (no end bound) and was observed to run >80 s for Jerusalem. |
| Points mode | Raw sample dots (capped at 3,000 drawn). |

### Honest limitations

- Road mode is **nearest-segment snapping, not trajectory map-matching** — no
  HMM/route inference, so a point near parallel roads or an intersection can snap
  to the wrong carriageway. Treat segment speeds as indicative, not per-lane truth.
- Averages include dwell time at stops unless you untick “Include stopped buses”.
  The median (in popups/stats) is usually the more robust figure.
- Road tiles are a free community service. If they fail,
  the app automatically falls back to Grid mode (squares) and says so in the stats panel.
- Data lag/coverage is whatever the SIRI ETL has ingested; empty windows
  (nights, Shabbat mornings, future dates) return no points — the app reports that.

## Why not the `openbus-mcp` MCP server?

You don't need MCP for this — the REST API is open and CORS-enabled. But your MCP
setup error is **not** the [skills-il/openbus-mcp](https://github.com/skills-il/mcps/tree/master/openbus-mcp)
package's fault. Reproduced locally (2026-11-24):

```
$ npx -y @skills-il/openbus-mcp
Error: Cannot find module './npm-cli.js'
Require stack:
- /opt/homebrew/lib/node_modules/npm/bin/npx-cli.js
    code: 'MODULE_NOT_FOUND'
```

Root cause: this machine's npm installation is broken — `/opt/homebrew/bin/npm`
doesn't exist and `npm-cli.js` is missing from `/opt/homebrew/lib/node_modules/npm/bin/`
(npm 11.5.1 files alongside Homebrew Node 24.7.0). Cursor spawns
`npx -y @skills-il/openbus-mcp` (your `~/.cursor/mcp.json` entry is correct),
`npx` crashes before the package is even downloaded, the stdio pipe closes, and
Cursor reports the generic “MCP server failed during live tool discovery” error
— the same error this session's `user-openbus` namespace shows.

Fix (system change, run it yourself when ready):

```bash
brew reinstall node        # restores a matching node+npm+npx set
node -v && npm -v && npx -v  # verify all three work
# then restart Cursor / reload MCP servers
```

No changes to `.cursor/mcp.json` are needed; the documented config
(`command: npx`, `args: ["-y", "@skills-il/openbus-mcp"]`) is correct.
Note the MCP server would not have helped this map anyway: it exposes 7 text
tools (arrivals, ride performance, routes, stops, timetables, vehicle locations
capped at 1,000 rows, agencies) and has no velocity-aggregation tool.

## Viewport

The timelapse canvas is **responsive**: its logical size follows the actual
window (width = CSS width × 1.25, clamped 900–1920; height follows the window
aspect), so Jerusalem always fills the screen with no letterbox bars and no
cropping at any window shape. On resize/orientation change, all screen-space
data (roads, GPS trajectories, stop positions, pre-rendered bases) is rebuilt
for the new size. Consequence: WebM recordings capture at the current window
aspect/logical size rather than a fixed 1920×1080.

## Known data seams

Hasadna collector outages were backfilled with the same weekday one week
earlier (`scripts/fetch_real_week.py`): Wed 2026-11-18 21:40→ is Nov 11, and
Thu 2026-11-19 00:00–17:00 is Nov 12. At each splice ~770 rides end within a
minute and ~790 start ~3 min later (Thu 17:00: fleet 924 → 105 → 963), which
read as a sudden death of the fleet. The timelapse crossfades buses through
the two seams (`DATA_SEAMS` in `timelapse.js`, ±6 min); the HUD bus count
still shows the true dip. A ride-level re-stitch of the source data would be
the full fix.

## Timelapse layers (`index.html`)

Two opt-in overlays on the 7-day real-GPS timelapse, both off by default:

- **🚦 Speed (`T`)** — road sections coloured by the average real speed of
  buses on them. Speed per bus is recovered as displacement ÷ time between
  GPS pings (the `real-day*.bin` trajectories pack only `t, x, y`, no SIRI
  velocity), snapped to the nearest road segment and averaged (EMA) per
  segment; segments stay coloured for ~20 playback minutes after a bus was
  measured on them. Bands: <6 / 6–12 / 12–18 / 18–26 / >26 km/h —
  deliberately lower than `speeds.html`'s scale, because they are calibrated
  to per-segment averages including stop dwell (measured on the real data:
  median derivative speed is ~17 km/h at 02:00, ~13 km/h at 17:00, so the old
  >35 km/h top band was essentially motorway-only); crawling bands are drawn
  wider, buses/wakes stay
  operator-coloured, and the legend shows live median speed + %
  crawling/stopped. Speed is smoothed over ~2 min, so brief stop-and-go is
  averaged out. Inside the legend, **🚌 Buses: hidden (`B`)** removes the
  buses/wakes/labels and stays with just the coloured roads (the speed
  computation keeps running underneath; turning the overlay off restores
  the buses).
- **📍 Stops (`S`)** — all 2,053 Jerusalem bus & light-rail stations inside
  the map bbox, frozen by `scripts/fetch_stops.py` from the SIRI API
  `/gtfs_stops/list` (`city=ירושלים`, 2026-11-21) into
  `data/jlm-stops.json` (lazy-loaded on first use). Names appear at zoom ≥ 2.4×.

## Files

- `index.html` + `timelapse.js` / `timelapse.css` — 7-day timelapse (default page)
- `speeds.html` + `app.js` / `styles.css` — page, controls, legend, method notes; SIRI API fetching/pagination, vector-tile road fetch/decoder, snapping, aggregation, rendering
- `scripts/fetch_stops.py` — freeze GTFS stop coordinates into `data/jlm-stops.json`

Data: © Hasadna (SIRI, via Israel MOT). Map: © OpenStreetMap contributors.
