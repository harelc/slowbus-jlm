"use strict";
// Off-main-thread road snapping + aggregation. Receives plain segment geometry
// (latlngs + metre-space xy) and points, returns only the aggregates to draw —
// the page thread never runs the O(n_points x segments) loop.
self.onmessage = (e) => {
  const { pts, segments, minSamples, snapM } = e.data;
  const CELL = 60, buckets = new Map();
  const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  segments.forEach((s, idx) => {
    s.sum = 0; s.n = 0; s.vals = [];
    for (const [x, y] of [[s.xy[0], s.xy[1]], [s.xy[2], s.xy[3]]]) {
      const k = key(x, y);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(idx);
    }
  });
  const distToSeg = (px, py, s) => {
    const dx = s.xy[2] - s.xy[0], dy = s.xy[3] - s.xy[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((px - s.xy[0]) * dx + (py - s.xy[1]) * dy) / L2)) : 0;
    return Math.hypot(px - (s.xy[0] + t * dx), py - (s.xy[1] + t * dy));
  };
  let matched = 0;
  for (let pi = 0; pi < pts.length; pi++) {
    const p = pts[pi];
    let best = -1, bestD = snapM;
    const gx = Math.floor(p.x / CELL), gy = Math.floor(p.y / CELL);
    for (let cx = gx - 1; cx <= gx + 1; cx++) for (let cy = gy - 1; cy <= gy + 1; cy++)
      for (const idx of buckets.get(`${cx},${cy}`) || []) {
        const d = distToSeg(p.x, p.y, segments[idx]);
        if (d < bestD) { bestD = d; best = idx; }
      }
    if (best >= 0) { const s = segments[best]; s.sum += p.v; s.n++; s.vals.push(p.v); matched++; }
    if (pi % 5000 === 4999) self.postMessage({ type: "progress", done: pi + 1, total: pts.length });
  }
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  const shown = segments.filter(s => s.n >= minSamples).map(s => ({
    name: s.name, highway: s.highway, latlngs: s.latlngs,
    avg: s.sum / s.n, med: median(s.vals), n: s.n,
  }));
  self.postMessage({ type: "done", matched, shown });
};
