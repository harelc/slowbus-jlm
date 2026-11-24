# SlowBus JLM — Jerusalem bus speeds on an OSM map

A zero-build map viewer that overlays **average bus speeds aggregated onto roads**
in Jerusalem, from the [Open Bus Stride API](https://open-bus-stride-api.hasadna.org.il/docs)
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
- Data lag/coverage is whatever Stride's SIRI ETL has ingested; empty windows
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

## Files

- `index.html` — page, controls, legend, method notes
- `app.js` — Stride fetching/pagination, vector-tile road fetch/decoder, snapping, aggregation, rendering
- `styles.css` — layout

Data: © Open Bus Stride / Hasadna (SIRI, via Israel MOT). Map: © OpenStreetMap contributors.
