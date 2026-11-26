"use strict";
const API = "https://open-bus-stride-api.hasadna.org.il";
const JERUSALEM = { latMin: 31.72, latMax: 31.82, lonMin: 35.17, lonMax: 35.27, center: [31.7683, 35.2137] };
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const PAGE = 5000, SNAP_M = 35, MAX_VEL = 100; // km/h; SIRI velocity >100 in Jerusalem is GPS error (sample max was 255)

const $ = (id) => document.getElementById(id);
const map = L.map("map").setView(JERUSALEM.center, 13);
// CARTO's free basemap now watermarks tiles with "API KEY REQUIRED", so use plain OSM
// tiles (no key) and desaturate them client-side via CSS filter (.desat-tiles below).
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, className: "desat-tiles",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const roadRenderer = L.canvas({ padding: 0.5 }); // canvas: thousands of road pieces without SVG DOM cost
let layer = L.layerGroup().addTo(map);          // coloured speed pieces / cells
let greyLayer = L.layerGroup().addTo(map);      // grey no-data network (persistent across time changes)
let renderedGreyKey = "", lastRender = { key: "", res: null }, lastRoadsKey = "";
let controller = null;
const roadsCache = new Map();  // tile-range key -> road index (LRU, bounded below)
const pointsCache = new Map(); // "from|to|bbox|max" -> raw points for that exact window+viewport (LRU)
let pointsCacheHit = false;
function cacheSet(map_, key, val, maxEntries) {
  if (map_.has(key)) map_.delete(key);
  map_.set(key, val);
  while (map_.size > maxEntries) map_.delete(map_.keys().next().value); // evict oldest
}

$("date").value = new Date(Date.now() - 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
$("load").addEventListener("click", () => {
  if (loading) { pendingReload = false; controller?.abort(); } // button cancels its own load
  else load();
});
$("cancel").addEventListener("click", () => { pendingReload = false; controller?.abort(); });

let statusText = "Idle", loadStarted = 0, progressTimer = null, progressPct = 0, loading = false, pendingReload = false;
async function fetchT(url, signal, ms, opts = {}) {
  const c = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; c.abort(); }, ms);
  if (signal) { if (signal.aborted) c.abort(); else signal.addEventListener("abort", () => c.abort(), { once: true }); }
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  catch (e) { if (timedOut && !signal?.aborted) throw new Error(`Request timed out after ${ms / 1000}s (${new URL(url).hostname}) — server slow, try again or a smaller window`); throw e; }
  finally { clearTimeout(timer); }
}
function setProgress(pct) {
  progressPct = Math.max(0, Math.min(100, pct));
  $("loadBar").style.width = progressPct + "%";
}
function setStatus(t) {
  statusText = t; $("status").textContent = t;
  if (loadStarted) {
    $("loadLabel").textContent = `${t} ${Math.round(progressPct)}%`;
    $("stats").innerHTML = `⏳ ${t}<br><span class="hint">${Math.round((Date.now() - loadStarted) / 1000)}s elapsed — SIRI/road servers can take 20–60s. You can Cancel.</span>`;
  }
}
function color(v) { return v < 8 ? "#d7301f" : v < 15 ? "#fc8d59" : v < 25 ? "#f2c94c" : v < 35 ? "#91cf60" : "#1a9850"; }
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; }

// Asia/Jerusalem UTC offset (handles DST) for an ISO date/time string.
function jerusalemIso(date, time) {
  const naive = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", timeZoneName: "longOffset", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(naive);
  const off = (parts.find(p => p.type === "timeZoneName").value.match(/GMT([+-]\d{2}):(\d{2})/) || []);
  return `${date}T${time}:00${off[1] || "+02"}:${off[2] || "00"}`;
}
// Fetch exactly the shown viewport — no fixed Jerusalem box, no padding.
// (The API filters server-side by this bbox, so zooming in genuinely fetches less.)
function queryBbox() {
  const b = map.getBounds();
  return { latMin: b.getSouth(), latMax: b.getNorth(), lonMin: b.getWest(), lonMax: b.getEast() };
}
let fetchCapped = false;

async function fetchPoints(bb, signal) {
  const max = +$("maxPoints").value, from = jerusalemIso($("date").value, $("from").value), to = jerusalemIso($("date").value, $("to").value);
  if (from >= to) throw new Error("From time must be before To time.");
  // Same time window + same viewport (to ~10 m) + same cap as a previous load? Skip the network.
  const cacheKey = `${from}|${to}|${[bb.latMin, bb.latMax, bb.lonMin, bb.lonMax].map(x => x.toFixed(4)).join(",")}|${max}`;
  pointsCacheHit = false;
  if (pointsCache.has(cacheKey)) {
    const hit = pointsCache.get(cacheKey); cacheSet(pointsCache, cacheKey, hit, 5);
    fetchCapped = hit.capped; pointsCacheHit = true;
    setProgress(58); setStatus(`Cached points — same window & viewport (${hit.raw.length})`);
    const inc0 = $("includeStopped").checked;
    return inc0 ? hit.raw : hit.raw.filter(p => p.v > 0);
  }
  const pts = [], CONCURRENCY = 4; // parallel page downloads (was sequential); modest cap to be polite to the API
  const fetchPage = async (offset) => {
    const limit = Math.min(PAGE, max - offset);
    const q = new URLSearchParams({
      limit, offset, recorded_at_time_from: from, recorded_at_time_to: to,
      lat__greater_or_equal: bb.latMin, lat__lower_or_equal: bb.latMax,
      lon__greater_or_equal: bb.lonMin, lon__lower_or_equal: bb.lonMax,
    });
    const r = await fetchT(`${API}/siri_vehicle_locations/list?${q}`, signal, 30000);
    if (!r.ok) throw new Error(`SIRI API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const page = await r.json();
    pts.push(...page); setProgress(2 + 58 * pts.length / max); setStatus(`Fetching SIRI points… ${pts.length}`);
    return page.length;
  };
  for (let offset = 0; offset < max; offset += PAGE * CONCURRENCY) {
    const offsets = Array.from({ length: CONCURRENCY }, (_, i) => offset + i * PAGE).filter(o => o < max);
    const sizes = await Promise.all(offsets.map(fetchPage));
    if (sizes.some((s, i) => s < Math.min(PAGE, max - offsets[i]))) break; // a short page = end of results
  }
  fetchCapped = pts.length >= max; // hit the user cap: viewport may contain more points than shown
  const raw = pts.filter(p => Number.isFinite(p.velocity) && p.velocity <= MAX_VEL)
                 .map(p => ({ lat: p.lat, lon: p.lon, v: p.velocity, line: p.siri_route__line_ref, t: p.recorded_at_time }));
  // Session cache only: historical windows are effectively immutable, but the source can backfill,
  // so we don't persist across page sessions. Capped results are cached too, but only ever
  // served back for the identical window+viewport+cap key, where they are exactly what a refetch returns first.
  cacheSet(pointsCache, cacheKey, { raw, capped: fetchCapped }, 5);
  const include0 = $("includeStopped").checked;
  return include0 ? raw : raw.filter(p => p.v > 0);
}

// --- OSM roads via Overpass, split into <=60 m pieces, bucketed in a metre grid ---
const M_PER_LAT = 110540, mPerLon = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
function toXY(lat, lon, lat0) { return [lon * mPerLon(lat0), lat * M_PER_LAT]; }
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

// --- Minimal Mapbox Vector Tile (protobuf) decoder: just enough for the `streets` layer ---
function mvtVarint(b, i) { let r = 0, s = 0; while (true) { const x = b[i++]; r += (x & 0x7f) * 2 ** s; s += 7; if (!(x & 0x80)) return [r, i]; } }
function* mvtFields(b) {
  let i = 0;
  while (i < b.length) {
    let tag; [tag, i] = mvtVarint(b, i); const f = tag >> 3, w = tag & 7;
    if (w === 0) { let v; [v, i] = mvtVarint(b, i); yield [f, v]; }
    else if (w === 2) { let l; [l, i] = mvtVarint(b, i); yield [f, b.subarray(i, i + l)]; i += l; }
    else if (w === 5) { yield [f, b.subarray(i, i + 4)]; i += 4; }
    else if (w === 1) { yield [f, b.subarray(i, i + 8)]; i += 8; }
    else throw new Error("bad protobuf wire type");
  }
}
const mvtText = (b) => new TextDecoder().decode(b);
function mvtValue(b) {
  for (const [f, v] of mvtFields(b)) {
    if (f === 1) return mvtText(v);
    if (f === 2) return new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true);
    if (f === 3) return new DataView(v.buffer, v.byteOffset, 8).getFloat64(0, true);
    if (f === 7) return !!v;
    if (f >= 4) return v;
  } return null;
}
function decodeStreets(buf, tx, ty, z) {
  const ways = [], ROAD_KINDS = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service", "busway", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "road"]);
  for (const [tf, layerBuf] of mvtFields(new Uint8Array(buf))) {
    if (tf !== 3) continue;
    let name = "", extent = 4096; const feats = [], keys = [], vals = [];
    for (const [f, v] of mvtFields(layerBuf)) {
      if (f === 1) name = mvtText(v); else if (f === 2) feats.push(v);
      else if (f === 3) keys.push(mvtText(v)); else if (f === 4) vals.push(mvtValue(v)); else if (f === 5) extent = v;
    }
    if (name !== "streets") continue;
    for (const featBuf of feats) {
      let type = 0, tags = [], geom = [];
      for (const [f, v] of mvtFields(featBuf)) {
        // Versatiles uses MVT v1 field order (id=1, tags=2, type=3, geometry=4);
        // MVT v2 uses (type=1, tags=2, geometry=3, id=4). Accept both.
        const packed = (arr) => { let i = 0; while (i < v.length) { let t; [t, i] = mvtVarint(v, i); arr.push(t); } };
        if (f === 2) packed(tags);
        else if (typeof v === "number" && (f === 3 || (f === 1 && v <= 3))) type = v;
        else if (v instanceof Uint8Array && (f === 3 || f === 4)) packed(geom);
      }
      if (type !== 2) continue; // LineString only
      const props = {}; for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = vals[tags[i + 1]];
      if (!ROAD_KINDS.has(props.kind)) continue;
      // geometry: MoveTo/LineTo commands, zig-zag delta coords in tile extent space
      let x = 0, y = 0, i = 0, line = null;
      const toLatLon = (cx, cy) => {
        const lon = (tx + cx / extent) / 2 ** z * 360 - 180;
        const n = Math.PI * (1 - 2 * (ty + cy / extent) / 2 ** z);
        return [Math.atan(Math.sinh(n)) * 180 / Math.PI, lon];
      };
      while (i < geom.length) {
        const cmd = geom[i] & 7, count = geom[i] >> 3; i++;
        for (let c = 0; c < count; c++) {
          if (cmd === 1 || cmd === 2) {
            x += (geom[i] >> 1) ^ -(geom[i] & 1); y += (geom[i + 1] >> 1) ^ -(geom[i + 1] & 1); i += 2;
            if (cmd === 1) { if (line?.length > 1) ways.push({ name: props.name || 'Unnamed road', highway: props.kind, coords: line }); line = []; }
            line.push(toLatLon(x, y));
          } else i += 0; // ClosePath: no coords
        }
      }
      if (line?.length > 1) ways.push({ name: props.name || 'Unnamed road', highway: props.kind, coords: line });
    }
  }
  return ways;
}

function buildRoadIndex(ways, bb) {
  const lat0 = (bb.latMin + bb.latMax) / 2, segments = [], buckets = new Map(), CELL = 60;
  const bucket = (x, y, seg) => { const k = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`; (buckets.get(k) || buckets.set(k, []).get(k)).push(seg); };
  ways.forEach((w, wi) => {
    for (let i = 0; i < w.coords.length - 1; i++) {
      const a = w.coords[i], b = w.coords[i + 1];
      const [ax, ay] = toXY(a[0], a[1], lat0), [bx, by] = toXY(b[0], b[1], lat0);
      const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 60));
      for (let s = 0; s < pieces; s++) {
        const seg = {
          name: w.name, highway: w.highway,
          latlngs: [[a[0] + (b[0] - a[0]) * s / pieces, a[1] + (b[1] - a[1]) * s / pieces],
                    [a[0] + (b[0] - a[0]) * (s + 1) / pieces, a[1] + (b[1] - a[1]) * (s + 1) / pieces]],
          xy: [ax + (bx - ax) * s / pieces, ay + (by - ay) * s / pieces, ax + (bx - ax) * (s + 1) / pieces, ay + (by - ay) * (s + 1) / pieces],
          sum: 0, n: 0, vals: [],
        };
        segments.push(seg); bucket(seg.xy[0], seg.xy[1], seg); bucket(seg.xy[2], seg.xy[3], seg);
      }
    }
  });
  return { segments, buckets, lat0 };
}

// Roads from Versatiles OSM vector tiles (streets layer, z13) — Overpass is capacity-limited
// and kept only as a fallback. Attribution: versatiles.org / © OpenStreetMap contributors.
async function fetchRoads(bb, signal, quiet = false) {
  // Tile zoom follows the map: z14 up close (minor streets), coarser when zoomed out.
  let Z = Math.max(11, Math.min(14, map.getZoom()));
  const tileRange = (z) => { const nn = 2 ** z, cx = (lon) => Math.floor((lon + 180) / 360 * nn), cy = (lat) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * nn);
    return [cx(bb.lonMin), cx(bb.lonMax), cy(bb.latMax), cy(bb.latMin)]; };
  while (Z > 10) { const [x0, x1, y0, y1] = tileRange(Z); if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 64) break; Z--; }
  const [x0, x1, y0, y1] = tileRange(Z), n = 2 ** Z;
  const tiles = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([x, y]);
  const key = `${Z}:${x0}-${x1}:${y0}-${y1}`; // cache by tile range, so small pans/return visits reuse roads
  lastRoadsKey = key;
  if (roadsCache.has(key)) { const hit = roadsCache.get(key); cacheSet(roadsCache, key, hit, 4); return hit; }
  const ways = [];
  for (let i = 0; i < tiles.length; i += 8) { // parallel batches of 8
    if (!quiet) { setProgress(62 + 30 * i / tiles.length); setStatus(`Fetching OSM road tiles… ${i}/${tiles.length} (${ways.length} streets)`); } // quiet: running in parallel with points, which own the progress bar
    await Promise.all(tiles.slice(i, i + 8).map(async ([x, y]) => {
      const r = await fetchT(`https://tiles.versatiles.org/tiles/osm/${Z}/${x}/${y}.pbf`, signal, 15000);
      if (!r.ok) throw new Error(`Road tiles ${r.status} — falling back`);
      ways.push(...decodeStreets(await r.arrayBuffer(), x, y, Z));
    }));
  }
  if (!ways.length) throw new Error("No streets in road tiles for this view");
  const index = buildRoadIndex(ways, bb);
  cacheSet(roadsCache, key, index, 4);
  return index;
}

const yieldFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
let currentWorker = null;

// Snapping runs in worker.js (off the main thread). Falls back to a clear error
// rather than ever running the heavy loop on the UI thread.
function aggregateInWorker(pts, roadData, signal) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker("worker.js"); } catch (e) { reject(e); return; }
    currentWorker = worker;
    const cleanup = () => { worker.terminate(); if (currentWorker === worker) currentWorker = null; };
    worker.onmessage = (e) => {
      if (e.data.type === "progress") setStatus(`Snapping points to roads… ${e.data.done}/${e.data.total}`);
      else { cleanup(); resolve(e.data); }
    };
    worker.onerror = (e) => { cleanup(); reject(new Error("Worker failed: " + e.message)); };
    signal?.addEventListener("abort", () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    const { segments, lat0 } = roadData;
    worker.postMessage({
      minSamples: +$("minSamples").value, snapM: SNAP_M,
      pts: pts.map(p => { const [x, y] = toXY(p.lat, p.lon, lat0); return { x, y, v: p.v }; }),
      segments: segments.map(s => ({ name: s.name, highway: s.highway, latlngs: s.latlngs, xy: s.xy })),
    });
  });
}

async function renderRoads(pts, roadData, signal) {
  const { segments } = roadData;
  // Grey network persists across loads: only (re)drawn when the road set (tile range) changed
  if ($("showNoData").checked) {
    if (renderedGreyKey !== lastRoadsKey) {
      greyLayer.clearLayers();
      L.polyline(segments.map(s => s.latlngs), { renderer: roadRenderer, color: "#646c74", weight: 1.7, opacity: .85 }).addTo(greyLayer);
      renderedGreyKey = lastRoadsKey;
    }
  } else { greyLayer.clearLayers(); renderedGreyKey = ""; }
  setStatus("Snapping points to roads (worker)…");
  const { matched, shown } = await aggregateInWorker(pts, roadData, signal);
  // Add coloured pieces in per-frame chunks so the tab stays responsive while drawing
  for (let i = 0; i < shown.length; i += 250) {
    for (const s of shown.slice(i, i + 250))
      L.polyline(s.latlngs, { renderer: roadRenderer, color: color(s.avg), weight: 2.5 + Math.min(6, Math.log2(s.n + 1)), opacity: .95 })
        .bindPopup(`<b>${s.name}</b> (${s.highway})<br>Avg ${s.avg.toFixed(1)} km/h · median ${s.med.toFixed(1)} km/h<br>${s.n} samples`).addTo(layer);
    if (i + 250 < shown.length) { setStatus(`Drawing road pieces… ${i + 250}/${shown.length}`); await yieldFrame(); }
  }
  return { matched, units: shown.length, aggregates: shown.map(s => ({ label: s.name, avg: s.avg, n: s.n })) };
}

async function renderAggregates(pts, mode) {
  const min = +$("minSamples").value, cells = new Map();
  for (const p of pts) {
    const k = mode === "grid" ? `${Math.round(p.lat * 1000)},${Math.round(p.lon * 1000)}` : `${p.lat},${p.lon}`;
    const c = cells.get(k) || cells.set(k, { lat: p.lat, lon: p.lon, sum: 0, n: 0, vals: [] }).get(k);
    c.sum += p.v; c.n++; c.vals.push(p.v);
  }
  const shown = [...cells.values()].filter(c => c.n >= min), aggregates = [];
  for (let ci = 0; ci < shown.length; ci++) {
    const c = shown[ci];
    const avg = c.sum / c.n; aggregates.push({ label: `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`, avg, n: c.n });
    const marker = mode === "grid"
      ? L.rectangle([[c.lat - .0005, c.lon - .0005], [c.lat + .0005, c.lon + .0005]], { color: color(avg), weight: 1, fillColor: color(avg), fillOpacity: .55 })
      : L.circleMarker([c.lat, c.lon], { radius: 4, color: color(avg), fillColor: color(avg), fillOpacity: .8 });
    marker.bindPopup(`Avg ${avg.toFixed(1)} km/h · median ${median(c.vals).toFixed(1)} km/h<br>${c.n} samples`).addTo(layer);
    if (mode === "points" && layer.getLayers().length > 3000) break;
    if (ci % 400 === 399) await yieldFrame();
  }
  return { matched: pts.length, units: shown.length, aggregates };
}

// --- Time-of-day controls: slider + presets set From/To, releasing the slider reloads ---
function syncWindow(hour) {
  const dur = +$("windowMin").value, start = Math.min(hour, 24 - dur / 60);
  const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  $("from").value = fmt(start * 60); $("to").value = fmt(start * 60 + dur);
  $("timeSlider").value = Math.floor(start);
  $("windowLabel").textContent = `${$("from").value}–${$("to").value}`;
}
$("timeSlider").addEventListener("input", (e) => syncWindow(+e.target.value));
$("timeSlider").addEventListener("change", () => load());
$("windowMin").addEventListener("change", () => syncWindow(+$("timeSlider").value));
$("timePrev").addEventListener("click", () => { syncWindow(Math.max(0, +$("timeSlider").value - 1)); load(); });
$("timeNext").addEventListener("click", () => { syncWindow(Math.min(23, +$("timeSlider").value + 1)); load(); });
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { syncWindow(+c.dataset.h); load(); }));
syncWindow(7);
$("howBtn").addEventListener("click", () => $("howDialog").showModal());
$("howClose").addEventListener("click", () => $("howDialog").close());
$("howDialog").addEventListener("click", (e) => { if (e.target === $("howDialog")) $("howDialog").close(); });

function loadKey() {
  const bb = queryBbox();
  return [$("date").value, $("from").value, $("to").value, $("mode").value, $("maxPoints").value, $("includeStopped").checked, $("showNoData").checked, $("minSamples").value,
          bb.latMin.toFixed(4), bb.latMax.toFixed(4), bb.lonMin.toFixed(4), bb.lonMax.toFixed(4)].join("|");
}
let activeLoadKey = "";
async function load() {
  if (loading) { if (loadKey() !== activeLoadKey) pendingReload = true; return; } // queue only real changes
  loading = true; activeLoadKey = loadKey();
  controller = new AbortController(); $("load").classList.add("loading"); $("cancel").disabled = false; // layers cleared only when actually re-rendering (see renderKey check)
  setProgress(2); $("histSection").hidden = true;
  loadStarted = Date.now(); clearInterval(progressTimer);
  progressTimer = setInterval(() => setStatus(statusText), 1000); // tick the elapsed counter in the panel
  try {
    const bb = queryBbox(), mode = $("mode").value;
    setStatus("Fetching SIRI points…");
    // roads are independent of points — download them in parallel, consume after points
    const roadsPromise = mode === "roads" ? fetchRoads(bb, controller.signal, true) : null;
    if (roadsPromise) roadsPromise.catch(() => {}); // handled below; avoid unhandled rejection if points fail first
    const pts = await fetchPoints(bb, controller.signal);
    if (!pts.length) throw new Error("No points in this window/bounds. Try a weekday 07:00–09:00 window, or zoom out.");
    setStatus(mode === "roads" ? "Fetching OSM roads…" : "Aggregating…");
    let res, effectiveMode = mode, renderCacheHit = false;
    const roadsIndex = mode === "roads" ? await roadsPromise.catch(e => e) : null;
    const renderKey = `${activeLoadKey}|${mode}|${mode === "roads" ? lastRoadsKey : ""}|${map.getZoom()}`;
    if (lastRender.key === renderKey && lastRender.res) {
      res = lastRender.res; renderCacheHit = true; // identical window+viewport+settings: keep the drawing as-is
      if (roadsIndex instanceof Error && mode === "roads") { /* cached render exists; ignore road refetch error */ }
    } else if (mode === "roads") {
      if (roadsIndex instanceof Error) { // road tiles failed — degrade to grid instead of failing the whole view
        effectiveMode = "grid"; setStatus(`${roadsIndex.message} Falling back to grid.`);
        greyLayer.clearLayers(); renderedGreyKey = ""; layer.clearLayers();
        res = await renderAggregates(pts, "grid");
      } else { layer.clearLayers(); res = await renderRoads(pts, roadsIndex, controller.signal); }
    } else { greyLayer.clearLayers(); renderedGreyKey = ""; layer.clearLayers(); res = await renderAggregates(pts, mode); }
    if (!renderCacheHit) lastRender = { key: renderKey, res };
    else lastRender.res = res;
    setProgress(96);
    // small histogram of segment/cell average speeds, coloured to match the map legend
    const bins = [[0, 8, "<8"], [8, 15, "8–15"], [15, 25, "15–25"], [25, 35, "25–35"], [35, Infinity, ">35"]];
    const counts = bins.map(([lo, hi]) => res.aggregates.filter(a => a.avg >= lo && a.avg < hi).length);
    const maxCount = Math.max(1, ...counts);
    $("hist").innerHTML = bins.map(([lo, hi, label], i) =>
      `<div class="histRow"><span>${label} km/h</span><div class="histTrack"><div class="histBar" style="width:${(100 * counts[i] / maxCount).toFixed(1)}%;background:${color((lo + Math.min(hi, 45)) / 2)}"></div></div><span class="histCount">${counts[i]}</span></div>`).join("");
    $("histSection").hidden = !res.aggregates.length;
    loadStarted = 0; // stop progress writer before rendering final stats
    const all = pts.map(p => p.v);
    $("stats").innerHTML = `<b>${pts.length.toLocaleString()}</b> points · <b>${res.matched.toLocaleString()}</b> used (${(100 * res.matched / pts.length).toFixed(0)}%) · <b>${res.units.toLocaleString()}</b> ${effectiveMode === "roads" ? "road pieces" : "cells"} shown<br>` +
      `Overall avg <b>${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(1)} km/h</b> · median <b>${median(all).toFixed(1)} km/h</b>${effectiveMode !== mode ? " · shown as grid (road fallback)" : ""}${pointsCacheHit ? " · <span class=\"hint\">points from cache</span>" : ""}${renderCacheHit ? " · <span class=\"hint\">rendering reused (not redrawn)</span>" : ""}${fetchCapped ? "<br><span class=\"hint\">Point cap reached for this viewport — zoom in or raise “Max points” for full coverage.</span>" : ""}`;
    setStatus(`Done — ${$("date").value} ${$("from").value}–${$("to").value} (Asia/Jerusalem), viewport bbox`);
  } catch (e) {
    if (e.name !== "AbortError") { loadStarted = 0; setStatus(`Error: ${e.message}`); $("stats").textContent = e.message; }
    else setStatus("Cancelled");
  } finally {
    clearInterval(progressTimer); loadStarted = 0; loading = false;
    $("load").classList.remove("loading"); $("cancel").disabled = true;
    // Reset immediately and unconditionally: the old "100% then clear after 900ms if idle"
    // could be skipped when a queued reload started inside that window, leaving the bar
    // stranded at a midpoint after the final load finished.
    setProgress(0); $("loadBar").style.width = "0%"; $("loadLabel").textContent = "Load speeds";
    if (pendingReload) { pendingReload = false; setTimeout(load, 100); }
  }
}
// --- Auto-fetch: on page open, and debounced after every pan/zoom ---
let moveTimer = null;
map.on("moveend", () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => { if (loading) { if (loadKey() !== activeLoadKey) pendingReload = true; } else load(); }, 900);
});
setTimeout(load, 400);
