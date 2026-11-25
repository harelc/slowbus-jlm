"use strict";

// ============================================================================
// SlowBus JLM — 7-Day Jerusalem Bus Pulse Timelapse
// Real-count luminous buses driving continuously along Jerusalem's OSM road
// network, with Night -> Dawn -> Day -> Dusk -> Night lighting, Web Audio
// ticking-clock soundtrack, and 1080p WebM video recording.
// ============================================================================

const W = 1920, H = 1080;
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { alpha: false });
const $ = (id) => document.getElementById(id);

// --- App state ---
let DATA = null;
let roads = [];         // [{ tier, x1, y1, x2, y2, len, dx, dy }]
let adjStart = [];      // adjacency list at segment start endpoint (x1,y1) -> [{ seg, fromEnd }]
let adjEnd = [];        // adjacency list at segment end endpoint (x2,y2)   -> [{ seg, fromEnd }]
let slices = [];        // full 504-slice week array (Sun Nov 15 -> Sat Nov 21)
let viewStart = 0;
let viewCount = 0;

let segGlow = null;     // Float32Array: warm street-light persistence per segment
let segDensity = null;  // Float32Array: current real bus count per segment
let segSpeed = null;    // Float32Array: real bus speed per segment (used ONLY for driving velocity!)

let bgNight = null;     // offscreen 1920x1080 night road web
let bgDay = null;       // offscreen 1920x1080 day road web
let vignetteNight = null; // pre-rendered low-res vignette (bilinear upscaled = 16x faster in Firefox!)
let vignetteDay = null;
let sunCanvas = null;   // tiny 192x108 solar wash buffer (100x faster than 1080p radial gradient!)
let sunCtx = null;
let busSpriteNight = null; // pre-rendered glowing bus headlight sprite
let busSpriteDay = null;
let labelSpritesNight = null; // Map<lineStr, Canvas> — zero per-frame fillText overhead!
let labelSpritesDay = null;
let viewMaxBuses = 1;
let mapRect = { x: 0, y: 0, w: W, h: H };

let playing = false;
let progress = 0;       // 0..1 across active range
let dayDurationSec = 45; // seconds per 24h day (Full Week is automatically 7x longer!)
function effectiveDurationSec() {
  return dayDurationSec * ($("rangeSelect").value === "week" ? 7 : 1);
}
let lastFrameTs = 0;
let lastTickIndex = -1;
let lastHourMark = -1;
let displayBuses = 0;

// Individual driving buses with smooth multi-point trails
const MAX_BUSES = 1050;
const busesPool = [];   // [{ seg, t, dir, spd, trail: [x,y,...], alpha, dying }]
let activeSegPool = []; // weighted list of currently active segments for spawning
const MAX_EVENTS = 180;
const stationEvents = []; // [{ x, y, colorIdx, kind: "depart"|"arrive", t: 0..1, dur }]

// Real GPS per-line playback + multiselector state
let LINE_CATALOG = [];            // [{ line, opRef, agency, lineRefs, desc }]
const lineTripsCache = new Map(); // key "line:opRef" -> { line, opRef, colorIdx, agency, trips, curve72 }
const selectedLineKeys = new Set(); // Default: All Lines (user can pick specific lines in widget)
const loadingLineKeys = new Set();
let lastLineMinute = -1;
let labelSpriteCacheNight = new Map();
let labelSpriteCacheDay = new Map();

// Recording state
let recorder = null;
let recChunks = [];
let recStartMs = 0;
let isRecording = false;

// ============================================================================
// Clean Harmonic "Clockwork" Web Audio Soundtrack (ZERO continuous engine hum!)
// Pure decaying felt-piano chords (Dm9 -> Fmaj7 -> G6/9 -> Bbmaj7 -> Asus4),
// soft wooden clock tick, and delicate D-Dorian celesta arpeggio notes.
// ============================================================================
class ClockSoundtrack {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.streamDest = null;
    this.noiseBuf = null;
    this.muted = false;
    this.volume = 0.75;
    this.tickParity = 0;
    this.arpStep = 0;
    this.beatCount = 0;
    this.started = false;
    this.currentChord = [146.83, 220.00, 261.63, 329.63]; // Dm9
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;

    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3.0;
    comp.attack.value = 0.008;
    comp.release.value = 0.18;

    this.master.connect(comp);
    comp.connect(this.ctx.destination);

    this.streamDest = this.ctx.createMediaStreamDestination();
    comp.connect(this.streamDest);

    // Warm low-passed echo for gentle acoustic room bloom
    this.delayL = this.ctx.createDelay(0.8);
    this.delayL.delayTime.value = 0.28;
    this.delayFeedback = this.ctx.createGain();
    this.delayFeedback.gain.value = 0.34;
    this.delayWet = this.ctx.createGain();
    this.delayWet.gain.value = 0.24;
    const delayFilter = this.ctx.createBiquadFilter();
    delayFilter.type = "lowpass";
    delayFilter.frequency.value = 1500;

    this.delayL.connect(delayFilter);
    delayFilter.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayL);
    delayFilter.connect(this.delayWet);
    this.delayWet.connect(this.master);

    // Very short soft wooden impulse for gentle clock escapement
    const len = Math.floor(this.ctx.sampleRate * 0.022);
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.12));
    }

    this.started = true;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master && !this.muted) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.04);
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.04);
    }
  }

  updateAtmosphere(daylight, intensity, active, minuteOfDay = 0, isShabbat = false) {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    const targetWet = 0.30 - daylight * 0.08;
    this.delayWet.gain.setTargetAtTime(Math.max(0.14, targetWet), now, 0.30);

    // Choose clean harmonic voicing for current time of day (zero continuous gliding oscillators!)
    const h = minuteOfDay / 60;
    if (isShabbat) {
      this.currentChord = [164.81, 220.00, 293.66, 329.63]; // Asus4 (serene)
    } else if (h < 5.5 || h >= 21.0) {
      this.currentChord = [146.83, 220.00, 261.63, 329.63]; // Dm9 (calm night)
    } else if (h < 9.5) {
      this.currentChord = [174.61, 220.00, 261.63, 329.63]; // Fmaj7 (dawn)
    } else if (h < 15.5) {
      this.currentChord = [196.00, 246.94, 293.66, 329.63]; // G6/9 (sunlit day)
    } else {
      this.currentChord = [174.61, 220.00, 293.66, 349.23]; // Bbmaj7/F (golden hour)
    }
  }

  playFeltChord(intensity) {
    const now = this.ctx.currentTime;
    const dur = 2.1;
    const baseAmp = 0.022 + intensity * 0.018;
    this.currentChord.forEach((f, idx) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const t0 = now + idx * 0.022; // gentle warm roll
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(baseAmp / (1 + idx * 0.25), t0 + 0.055);
      g.gain.exponentialRampToValueAtTime(0.0003, t0 + dur);
      osc.connect(g);
      g.connect(this.master);
      g.connect(this.delayL);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    });
  }

  tick(intensity = 0.5, isSubTick = false) {
    if (!this.started || this.muted) return;
    const now = this.ctx.currentTime;
    const isTick = (this.tickParity++ % 2 === 0);

    // 1) Soft damped wooden clock pulse tuned to D5 / A4
    const osc = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    osc.type = "sine";
    const f0 = isSubTick ? 880 : (isTick ? 587.33 : 440.00);
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.72, now + 0.032);
    const amp = isSubTick ? (0.022 + intensity * 0.025) : (0.060 + intensity * 0.048);
    og.gain.setValueAtTime(0.0001, now);
    og.gain.linearRampToValueAtTime(amp, now + 0.003);
    og.gain.exponentialRampToValueAtTime(0.0004, now + (isSubTick ? 0.045 : 0.075));
    osc.connect(og);
    og.connect(this.master);
    if (!isSubTick) og.connect(this.delayL);
    osc.start(now);
    osc.stop(now + 0.085);

    // Tiny subtle escapement click
    if (!isSubTick) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = isTick ? 1900 : 1450;
      bp.Q.value = 3.2;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(0.038 + intensity * 0.032, now);
      ng.gain.exponentialRampToValueAtTime(0.0005, now + 0.020);
      src.connect(bp); bp.connect(ng); ng.connect(this.master);
      src.start(now);

      // Soft decaying harmonic chord every 4 main beats (pure & clean, no continuous hum!)
      if (this.beatCount++ % 4 === 0) {
        this.playFeltChord(intensity);
      }
    }

    // 2) Delicate D-Dorian felt-piano / celesta arpeggio notes on main beats
    if (!isSubTick && (intensity > 0.12 || this.arpStep % 2 === 0)) {
      const scale = [293.66, 329.63, 349.23, 440.00, 523.25, 587.33, 659.25, 783.99];
      const pattern = [0, 3, 5, 4, 2, 3, 6, 5, 1, 3, 4, 7, 5, 3, 2, 0];
      const noteFreq = scale[pattern[this.arpStep++ % pattern.length]];
      const pluck = this.ctx.createOscillator();
      const overtone = this.ctx.createOscillator();
      const pg = this.ctx.createGain();
      const og2 = this.ctx.createGain();
      pluck.type = "sine";
      overtone.type = "sine";
      pluck.frequency.value = noteFreq;
      overtone.frequency.value = noteFreq * 2;
      const pAmp = 0.026 + intensity * 0.038;
      pg.gain.setValueAtTime(0.0001, now);
      pg.gain.linearRampToValueAtTime(pAmp, now + 0.012);
      pg.gain.exponentialRampToValueAtTime(0.0004, now + 0.55);
      og2.gain.value = 0.14;
      pluck.connect(pg);
      overtone.connect(og2); og2.connect(pg);
      pg.connect(this.master);
      pg.connect(this.delayL);
      pluck.start(now); overtone.start(now);
      pluck.stop(now + 0.58); overtone.stop(now + 0.58);
    }
  }

  chime(kind = "hour") {
    if (!this.started || this.muted) return;
    const now = this.ctx.currentTime;
    const freqs = kind === "major" ? [293.66, 440.00, 523.25, 659.25] // Dm9 bloom
                : kind === "shabbat" ? [220.00, 293.66, 329.63, 440.00] // Asus4 calm
                : [440.00, 587.33];
    const dur = kind === "hour" ? 0.95 : 2.4;
    const amp = kind === "hour" ? 0.032 : 0.072;

    freqs.forEach((f, idx) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const t0 = now + idx * 0.045; // gentle harp-like strum!
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(amp / (1 + idx * 0.35), t0 + 0.025);
      g.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);
      osc.connect(g);
      g.connect(this.master);
      g.connect(this.delayL);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    });
  }
}

const audio = new ClockSoundtrack();

// ============================================================================
// Geometry, Connected Road Graph & Pre-rendered Base Layers
// ============================================================================
function computeMapProjection() {
  const [latMin, lonMin, latMax, lonMax] = DATA.meta.bbox;
  const geoW = (lonMax - lonMin) * Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
  const geoH = (latMax - latMin);
  const geoAspect = geoW / geoH;

  // Keep full north-south Jerusalem span visible (Pisgat Ze'ev down to Har Homa)
  const availH = H * 1.03;
  const availW = availH * geoAspect;
  mapRect = {
    x: Math.round((W - availW) * 0.59),
    y: Math.round((H - availH) * 0.22),
    w: Math.round(availW),
    h: Math.round(availH),
  };
}

function toScreenX(nx) { return mapRect.x + (nx / 10000) * mapRect.w; }
function toScreenY(ny) { return mapRect.y + (ny / 10000) * mapRect.h; }

// Connect road segments that share endpoints using 3x3 spatial grid + exact distance
// (prevents cell-boundary misses that used to create fake dead ends!)
function buildRoadGraph() {
  const n = roads.length;
  adjStart = new Array(n);
  adjEnd = new Array(n);
  for (let i = 0; i < n; i++) { adjStart[i] = []; adjEnd[i] = []; }

  const CELL = 1.0; // pixels — OSM shared vertices match within ~0.25px!
  const MAX_DIST_SQ = 0.65 * 0.65;
  const grid = new Map();
  const keyOf = (gx, gy) => (gx << 16) ^ gy;

  const endpoints = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const r = roads[i];
    const e0 = { seg: i, isEnd: false, x: r.x1, y: r.y1 };
    const e1 = { seg: i, isEnd: true,  x: r.x2, y: r.y2 };
    endpoints[i * 2] = e0;
    endpoints[i * 2 + 1] = e1;
    for (const ep of [e0, e1]) {
      const gx = Math.floor(ep.x / CELL), gy = Math.floor(ep.y / CELL);
      const k = keyOf(gx, gy);
      let b = grid.get(k);
      if (!b) { b = []; grid.set(k, b); }
      b.push(ep);
    }
  }

  for (let i = 0; i < endpoints.length; i++) {
    const A = endpoints[i];
    const gx = Math.floor(A.x / CELL), gy = Math.floor(A.y / CELL);
    const out = A.isEnd ? adjEnd[A.seg] : adjStart[A.seg];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(keyOf(gx + dx, gy + dy));
        if (!bucket) continue;
        for (let j = 0; j < bucket.length; j++) {
          const B = bucket[j];
          if (A.seg === B.seg) continue;
          const ddx = A.x - B.x, ddy = A.y - B.y;
          if (ddx * ddx + ddy * ddy <= MAX_DIST_SQ) {
            out.push({ seg: B.seg, enterAtEnd: B.isEnd });
          }
        }
      }
    }
  }
}

function prerenderRoadBases() {
  bgNight = document.createElement("canvas");
  bgNight.width = W; bgNight.height = H;
  const cn = bgNight.getContext("2d");

  bgDay = document.createElement("canvas");
  bgDay.width = W; bgDay.height = H;
  const cd = bgDay.getContext("2d");

  const nightStyles = [
    { color: "rgba(148, 186, 240, 0.68)", width: 2.4 },
    { color: "rgba(128, 164, 218, 0.56)", width: 1.9 },
    { color: "rgba(110, 144, 196, 0.46)", width: 1.45 },
    { color: "rgba(96, 128, 178, 0.38)",  width: 1.05 },
    { color: "rgba(82, 112, 158, 0.30)",  width: 0.75 },
  ];
  const dayStyles = [
    { color: "rgba(92, 84, 74, 0.56)",    width: 2.4 },
    { color: "rgba(108, 100, 88, 0.46)",  width: 1.9 },
    { color: "rgba(122, 114, 100, 0.38)", width: 1.45 },
    { color: "rgba(136, 128, 114, 0.30)", width: 1.05 },
    { color: "rgba(148, 140, 126, 0.24)", width: 0.75 },
  ];

  cn.lineCap = cd.lineCap = "round";
  for (let tier = 4; tier >= 0; tier--) {
    cn.beginPath(); cd.beginPath();
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i];
      if (r.tier !== tier) continue;
      cn.moveTo(r.x1, r.y1); cn.lineTo(r.x2, r.y2);
      cd.moveTo(r.x1, r.y1); cd.lineTo(r.x2, r.y2);
    }
    cn.strokeStyle = nightStyles[tier].color; cn.lineWidth = nightStyles[tier].width; cn.stroke();
    cd.strokeStyle = dayStyles[tier].color;   cd.lineWidth = dayStyles[tier].width;   cd.stroke();
  }

  // Pre-render vignettes at 1/4 res (480x270) — bilinear upscaling is identical and ~16x faster in Firefox!
  const vw = 480, vh = 270;
  const makeVig = (rgba) => {
    const c = document.createElement("canvas");
    c.width = vw; c.height = vh;
    const gctx = c.getContext("2d");
    const g = gctx.createRadialGradient(vw * 0.54, vh * 0.5, vh * 0.34, vw * 0.5, vh * 0.5, vw * 0.68);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, rgba);
    gctx.fillStyle = g;
    gctx.fillRect(0, 0, vw, vh);
    return c;
  };
  vignetteNight = makeVig("rgba(8, 14, 28, 0.34)");
  vignetteDay = makeVig("rgba(42, 34, 24, 0.20)");

  sunCanvas = document.createElement("canvas");
  sunCanvas.width = 192; sunCanvas.height = 108;
  sunCtx = sunCanvas.getContext("2d");

  // Pre-render crisp, readable operator-colored bus line number sprites (34x16)
  const makeLabelCache = (palette, strokeCol) => {
    const map = new Map();
    const allLines = new Set(JLM_CORRIDOR_LINES.flatMap((c) => c.lines));
    for (const num of allLines) {
      const col = palette[operatorOfLine(num)];
      const c = document.createElement("canvas");
      c.width = 34; c.height = 16;
      const g = c.getContext("2d");
      g.font = '700 11px "JetBrains Mono", monospace';
      g.textBaseline = "middle";
      g.textAlign = "left";
      g.lineWidth = 3.0;
      g.lineJoin = "round";
      g.strokeStyle = strokeCol;
      g.strokeText(num, 2, 8);
      g.fillStyle = rgbStr(col, 0.98);
      g.fillText(num, 2, 8);
      map.set(num, c);
    }
    return map;
  };
  labelSpritesNight = makeLabelCache(OPERATOR_COLORS_NIGHT, "rgba(10, 16, 30, 0.90)");
  labelSpritesDay   = makeLabelCache(OPERATOR_COLORS_DAY,   "rgba(246, 241, 232, 0.92)");
}

// 6 real Jerusalem transit operators (verified from Open Bus Stride GTFS / SIRI operator_ref)
// 0: Egged (3), 1: Superbus (16), 2: Extra JLM (38), 3: East JLM (42..51), 4: Kavim/Tnufa, 5: Light Rail L1/L3 (21)
const OPERATOR_META = [
  { name: "Egged",       night: [ 52, 232, 132], day: [ 16, 134,  68] }, // 0: Iconic Egged Green
  { name: "Superbus",    night: [ 56, 198, 255], day: [  6, 114, 184] }, // 1: Superbus Electric Blue
  { name: "Extra",       night: [255, 148,  64], day: [212,  82,  14] }, // 2: Extra Jerusalem Orange
  { name: "East JLM",    night: [250, 212,  52], day: [176, 116,   6] }, // 3: East Jerusalem Gold
  { name: "Kavim/Tnufa", night: [198, 134, 255], day: [122,  48, 188] }, // 4: Kavim / Tnufa Violet
  { name: "Light Rail",  night: [255,  86, 128], day: [214,  24,  72] }, // 5: Jerusalem Light Rail (L1/L3)
];
const OPERATOR_COLORS_NIGHT = OPERATOR_META.map((o) => o.night);
const OPERATOR_COLORS_DAY   = OPERATOR_META.map((o) => o.day);

// Authentic route -> operator mapping for Jerusalem lines
const LINE_OPERATOR_MAP = {
  // Egged (0)
  "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "10": 0, "12": 0,
  "14": 0, "17": 0, "18": 0, "19": 0, "22": 0, "24": 0, "25": 0, "30": 0,
  "32": 0, "34": 0, "38": 0, "39": 0, "45": 0, "48": 0, "49": 0, "66": 0,
  "68": 0, "83": 0, "405": 0, "480": 0,
  // Superbus (1)
  "31": 1, "33": 1, "71": 1, "72": 1, "74": 1, "75": 1, "77": 1, "78": 1,
  "91": 1, "504": 1, "506": 1, "516": 1, "517": 1, "540": 1,
  // Extra Jerusalem (2)
  "15": 2, "36": 2, "54": 2, "57": 2, "59": 2, "64": 2, "65": 2, "67": 2, "81": 2, "531": 2,
  // East Jerusalem Operators (3)
  "209": 3, "218": 3, "231": 3, "234": 3, "255": 3, "274": 3, "275": 3,
  // Kavim / Tnufa / Intercity (4)
  "100": 4, "110": 4, "111": 4, "163": 4, "185": 4, "304": 4, "383": 4,
};

function operatorGroupFromRef(opRef) {
  if (opRef === 3) return 0; // Egged
  if (opRef === 16) return 1; // Superbus
  if (opRef === 37 || opRef === 38) return 2; // Extra Jerusalem
  if (opRef >= 42 && opRef <= 51) return 3; // East Jerusalem operators
  if (opRef === 21) return 5; // Jerusalem Light Rail (Kfir L1/L3)
  return 4; // Kavim / Tnufa / Intercity
}

function getLabelSprite(num, colorIdx, isNight) {
  const cache = isNight ? labelSpriteCacheNight : labelSpriteCacheDay;
  const key = `${num}:${colorIdx}`;
  let spr = cache.get(key);
  if (spr) return spr;
  const col = (isNight ? OPERATOR_COLORS_NIGHT : OPERATOR_COLORS_DAY)[colorIdx];
  const strokeCol = isNight ? "rgba(10, 16, 30, 0.92)" : "rgba(246, 241, 232, 0.92)";
  const c = document.createElement("canvas");
  c.width = 40; c.height = 16;
  const g = c.getContext("2d");
  g.font = '700 11.5px "JetBrains Mono", monospace';
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.lineWidth = 3.2;
  g.lineJoin = "round";
  g.strokeStyle = strokeCol;
  g.strokeText(num, 2, 8);
  g.fillStyle = rgbStr(col, 0.98);
  g.fillText(num, 2, 8);
  c._tw = Math.min(38, Math.ceil(g.measureText(num).width) + 3);
  cache.set(key, c);
  return c;
}

function operatorOfLine(lineStr) {
  return LINE_OPERATOR_MAP[lineStr] ?? 0;
}

// Real Jerusalem routes mapped to their home corridors/neighborhoods
const JLM_CORRIDOR_LINES = [
  { nx: 5200, ny: 4500, lines: ["18", "74", "75", "78", "480", "405", "517", "14", "66", "110", "185"] }, // Central Station / Jaffa
  { nx: 6350, ny: 5200, lines: ["1", "2", "3", "38", "83", "209", "218", "231", "274", "18"] },           // Old City / East JLM
  { nx: 6950, ny: 4100, lines: ["19", "17", "48", "68", "34", "209", "255", "275", "540"] },              // Mt. Scopus / French Hill
  { nx: 4950, ny: 2450, lines: ["31", "36", "64", "71", "72", "57", "81", "67", "531"] },                 // Ramot / Golda Meir
  { nx: 6950, ny: 2050, lines: ["22", "25", "45", "49", "65", "66", "540", "59", "218"] },                // Pisgat Ze'ev / Neve Yaakov
  { nx: 4350, ny: 6750, lines: ["14", "18", "31", "33", "24", "6", "504", "12", "163"] },                 // Malha / Bayit VeGan
  { nx: 5900, ny: 6750, lines: ["71", "72", "74", "75", "77", "78", "7", "10", "516", "231"] },           // Talpiot / Bakaa
  { nx: 4400, ny: 7950, lines: ["31", "71", "72", "504", "516", "33", "91", "383"] },                     // Gilo
  { nx: 6050, ny: 8450, lines: ["74", "75", "78", "5", "506", "516", "304"] },                            // Har Homa
  { nx: 4100, ny: 4400, lines: ["15", "33", "54", "67", "74", "75", "517", "480", "100", "111"] },        // Givat Shaul / Har Nof
];

const SHABBAT_EAST_JLM_LINES = ["209", "218", "231", "234", "255", "274", "275"];

function pickLineNumber(x, y, isShabbat = false) {
  // During Shabbat in Jerusalem, only East Jerusalem operators (42-51) run!
  if (isShabbat) {
    return SHABBAT_EAST_JLM_LINES[Math.floor(Math.random() * SHABBAT_EAST_JLM_LINES.length)];
  }
  let best = JLM_CORRIDOR_LINES[0], bestD = 1e18;
  for (let i = 0; i < JLM_CORRIDOR_LINES.length; i++) {
    const c = JLM_CORRIDOR_LINES[i];
    const dx = x - toScreenX(c.nx), dy = y - toScreenY(c.ny);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best.lines[Math.floor(Math.random() * best.lines.length)];
}

// ============================================================================
// Solar & Atmosphere Helpers
// ============================================================================
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function mixRGB(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}
function rgbStr(c, a = 1) { return a === 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`; }

function getSolarState(minuteOfDay) {
  const h = minuteOfDay / 60;
  const up = smoothstep(5.2, 7.5, h);
  const down = 1 - smoothstep(15.4, 17.8, h);
  const daylight = up * down;
  const dawnGlow = Math.exp(-Math.pow((h - 6.35) / 0.85, 2));
  const duskGlow = Math.exp(-Math.pow((h - 16.65) / 0.85, 2));
  const sunProgress = clamp((h - 6.1) / (16.8 - 6.1), 0, 1);
  return { daylight, dawnGlow, duskGlow, sunProgress, hour: h };
}

function getPhaseLabel(dayIdx, minuteOfDay) {
  const h = minuteOfDay / 60;
  const isShabbat = (dayIdx === 5 && h >= 16.0) || (dayIdx === 6 && h < 17.75);
  if (isShabbat) return { text: "SHABBAT HUSH", accent: "#a78bfa" };
  if (dayIdx === 6 && h >= 17.75 && h < 20.5) return { text: "MOTZAEI SHABBAT SURGE", accent: "#f59e0b" };
  if (h < 4.75 || h >= 22.5) return { text: "DEEP NIGHT", accent: "#60a5fa" };
  if (h < 6.5) return { text: "DAWN AWAKENING", accent: "#fb923c" };
  if (h < 9.5) return { text: "MORNING RUSH", accent: "#f59e0b" };
  if (h < 15.0) return { text: "MIDDAY PULSE", accent: "#d97706" };
  if (h < 18.5) return { text: "GOLDEN HOUR · EVENING RUSH", accent: "#f97316" };
  return { text: "NIGHT DECAY", accent: "#818cf8" };
}

// ============================================================================
// Living Bus Fleet Simulation (Buses driving continuously along the roads!)
// ============================================================================
function resetSimulation() {
  segGlow = new Float32Array(roads.length);
  segDensity = new Float32Array(roads.length);
  segSpeed = new Float32Array(roads.length);
  busesPool.length = 0;
  activeSegPool.length = 0;
  stationEvents.length = 0;
}

function isHighwayBorderCrossing(x, y, px, py, dtMin) {
  // Inner 8% margin: never emit terminal birth/death right at the map edge
  const mx = mapRect.w * 0.08, my = mapRect.h * 0.08;
  if (x < mapRect.x + mx || x > mapRect.x + mapRect.w - mx ||
      y < mapRect.y + my || y > mapRect.y + mapRect.h - my) return true;
  // Outer 15% highway zone: ignore if bus is moving fast (>12 px/min ~ 15 km/h) -> entering/exiting city!
  const hx = mapRect.w * 0.15, hy = mapRect.h * 0.15;
  const nearOuter = (x < mapRect.x + hx || x > mapRect.x + mapRect.w - hx ||
                     y < mapRect.y + hy || y > mapRect.y + mapRect.h - hy);
  if (nearOuter && dtMin > 0.05) {
    const speedPxPerMin = Math.hypot(x - px, y - py) / dtMin;
    if (speedPxPerMin > 10) return true;
  }
  return false;
}

function emitStationEvent(x, y, colorIdx, kind) {
  if (stationEvents.length >= MAX_EVENTS) return;
  stationEvents.push({
    x, y, colorIdx, kind,
    t: 0,
    dur: kind === "depart" ? 0.65 : 0.85,
  });
}

function updateStationEvents(dt) {
  for (let i = stationEvents.length - 1; i >= 0; i--) {
    const ev = stationEvents[i];
    ev.t += dt / ev.dur;
    if (ev.t >= 1) stationEvents.splice(i, 1);
  }
}

function setRange(val) {
  if (val === "week") {
    viewStart = 0; viewCount = slices.length;
  } else {
    const d = +val, perDay = slices.length / 7;
    viewStart = d * perDay; viewCount = perDay;
  }
  progress = 0;
  lastTickIndex = -1;
  lastHourMark = -1;
  lastLineMinute = -1;
  viewMaxBuses = 1;
  for (let i = 0; i < viewCount; i++) {
    const b = slices[viewStart + i].b;
    if (b > viewMaxBuses) viewMaxBuses = b;
  }
  resetSimulation();
  buildDayMarkers();
  // Ensure any selected lines have data loaded for the newly chosen day / full week!
  for (const key of selectedLineKeys) {
    const [num, opStr] = key.split(":");
    const meta = LINE_CATALOG.find((m) => m.line === num && m.opRef === +opStr);
    if (meta) ensureLineLoaded(meta);
  }
  renderFrame(0, 0.016);
}

function buildDayMarkers() {
  const el = $("dayMarkers");
  const wrap = el.closest(".scrubber-wrap");
  if (viewCount === slices.length) {
    el.classList.add("week-mode");
    if (wrap) wrap.classList.add("week-mode");
    el.innerHTML = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
      .map((d, i) => `<span data-day="${i}" class="${i >= 5 ? "shabbat" : ""}">${d}</span>`)
      .join("");
  } else {
    el.classList.remove("week-mode");
    if (wrap) wrap.classList.remove("week-mode");
    el.innerHTML = ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "24:00"].map(t => `<span>${t}</span>`).join("");
  }
  lastMarkedDay = -1;
}

let lastMarkedDay = -1;
function highlightActiveDayMarker(dayIdx) {
  if (viewCount !== slices.length || dayIdx === lastMarkedDay) return;
  lastMarkedDay = dayIdx;
  const spans = $("dayMarkers").querySelectorAll("span[data-day]");
  spans.forEach((sp, i) => sp.classList.toggle("active-day", i === dayIdx));
}

function sampleState(p) {
  const fIdx = clamp(p, 0, 0.999999) * (viewCount - 1);
  const i0 = Math.floor(fIdx);
  const i1 = Math.min(viewCount - 1, i0 + 1);
  const frac = fIdx - i0;
  const s0 = slices[viewStart + i0];
  const s1 = slices[viewStart + i1];

  const dayIdx = s0.d;
  const m0 = s0.m;
  const m1 = s1.d === s0.d ? s1.m : 1440;
  const minuteOfDay = (m0 + (m1 - m0) * frac) % 1440;
  const buses = lerp(s0.b, s1.b, frac);
  return { s0, s1, frac, dayIdx, minuteOfDay, buses };
}

function updateRoadActivity(s0, s1, frac, dt) {
  const decay = Math.exp(-dt * 2.4);
  for (let i = 0; i < segGlow.length; i++) {
    segGlow[i] *= decay;
    segDensity[i] = 0;
  }

  const applySlice = (arr, weight) => {
    for (let j = 0; j < arr.length; j += 3) {
      const idx = arr[j], cnt = arr[j + 1], spd = arr[j + 2];
      segDensity[idx] += cnt * weight;
      const target = Math.min(1.0, Math.log2(1 + segDensity[idx]) / 3.2);
      if (target > segGlow[idx]) {
        segGlow[idx] = lerp(segGlow[idx], target, Math.min(1, dt * 7.5));
      }
      segSpeed[idx] = segSpeed[idx] > 0 ? lerp(segSpeed[idx], spd, 0.3) : spd;
    }
  };
  applySlice(s0.s, 1 - frac);
  applySlice(s1.s, frac);

  activeSegPool.length = 0;
  for (let i = 0; i < segGlow.length; i++) {
    // Only spawn buses on connected road segments so none are trapped on isolated stubs!
    if (segGlow[i] > 0.08 && (adjStart[i].length > 0 || adjEnd[i].length > 0)) {
      activeSegPool.push(i);
    }
  }
}

function spawnBus(isShabbat = false) {
  if (activeSegPool.length === 0) return null;
  // Pick a random active connected segment (favoring segments with higher real bus density)
  let best = activeSegPool[Math.floor(Math.random() * activeSegPool.length)];
  if (activeSegPool.length > 4) {
    const alt = activeSegPool[Math.floor(Math.random() * activeSegPool.length)];
    if (segDensity[alt] > segDensity[best]) best = alt;
  }
  const r = roads[best];
  const t = Math.random();
  // Prefer starting in a direction that actually has outgoing connections
  let dir;
  if (adjEnd[best].length > 0 && adjStart[best].length === 0) dir = 1;
  else if (adjStart[best].length > 0 && adjEnd[best].length === 0) dir = -1;
  else dir = Math.random() < 0.5 ? 1 : -1;
  const px = lerp(r.x1, r.x2, t), py = lerp(r.y1, r.y2, t);
  const realSpd = segSpeed[best] || 26;
  const line = pickLineNumber(px, py, isShabbat);
  const colorIdx = operatorOfLine(line);
  emitStationEvent(px, py, colorIdx, "depart");
  return {
    seg: best,
    prevSeg: -1,
    prevSeg2: -1,
    line,
    colorIdx,
    t,
    dir,
    // Crisp visible gliding motion along Jerusalem's streets
    pxPerSec: (48 + clamp(realSpd, 10, 55) * 1.5) * (0.85 + Math.random() * 0.30),
    trail: [px, py],
    alpha: 0,
    age: 0,
    maxAge: 9 + Math.random() * 12,
    dying: false,
  };
}

function pickNextSegment(bus) {
  const cur = roads[bus.seg];
  const neighbors = bus.dir > 0 ? adjEnd[bus.seg] : adjStart[bus.seg];
  if (!neighbors || neighbors.length === 0) return null;

  const vx = cur.dx * bus.dir, vy = cur.dy * bus.dir;
  let bestChoice = null, bestScore = -1e9;
  let fallbackChoice = null, fallbackScore = -1e9;

  for (let i = 0; i < neighbors.length; i++) {
    const nb = neighbors[i];
    // Never immediately ping-pong back to the last 2 segments!
    if (nb.seg === bus.prevSeg || nb.seg === bus.prevSeg2) continue;
    const nr = roads[nb.seg];
    const newDir = nb.enterAtEnd ? -1 : 1;
    const dot = vx * (nr.dx * newDir) + vy * (nr.dy * newDir);
    const trafficBonus = segGlow[nb.seg] * 2.2 + (nr.tier <= 2 ? 0.6 : 0);
    const score = dot * 2.0 + trafficBonus + Math.random() * 0.35;
    if (dot >= -0.25 && score > bestScore) {
      bestScore = score;
      bestChoice = { seg: nb.seg, dir: newDir };
    } else if (score > fallbackScore) {
      fallbackScore = score;
      fallbackChoice = { seg: nb.seg, dir: newDir };
    }
  }
  return bestChoice || fallbackChoice;
}

function markBusArriving(b) {
  if (b.dying) return;
  b.dying = true;
  if (b.trail.length >= 2) {
    emitStationEvent(b.trail[b.trail.length - 2], b.trail[b.trail.length - 1], b.colorIdx, "arrive");
  }
}

function updateBusFleet(targetBuses, dt, isShabbat = false) {
  const targetCount = Math.min(MAX_BUSES, Math.max(0, Math.round(targetBuses)));

  // During Shabbat, gracefully retire any non-East-Jerusalem buses (Egged/Superbus/Extra stop running!)
  if (isShabbat) {
    for (let i = 0; i < busesPool.length; i++) {
      if (busesPool[i].colorIdx !== 3 && !busesPool[i].dying) {
        markBusArriving(busesPool[i]);
      }
    }
  }

  // Spawn new buses smoothly to match real active bus count
  const deficit = targetCount - busesPool.length;
  if (deficit > 0 && activeSegPool.length > 0) {
    const toSpawn = Math.min(deficit, Math.max(4, Math.ceil(deficit * 0.22)));
    for (let k = 0; k < toSpawn; k++) {
      const b = spawnBus(isShabbat);
      if (b) busesPool.push(b);
    }
  } else if (deficit < -6) {
    // Gracefully fade out excess buses as traffic decays at night / Shabbat
    let toMark = Math.min(-deficit, Math.max(2, Math.ceil(-deficit * 0.12)));
    for (let i = 0; i < busesPool.length && toMark > 0; i++) {
      if (!busesPool[i].dying) { markBusArriving(busesPool[i]); toMark--; }
    }
  }

  // Advance every bus along its road segment and across intersections!
  for (let i = busesPool.length - 1; i >= 0; i--) {
    const b = busesPool[i];
    b.age += dt;
    if (b.age > b.maxAge) markBusArriving(b);
    b.alpha = b.dying ? b.alpha - dt * 1.8 : Math.min(1, b.alpha + dt * 3.0);
    if (b.alpha <= 0) { busesPool.splice(i, 1); continue; }

    let remDist = b.pxPerSec * dt;
    let steps = 0;
    while (remDist > 0 && steps < 14) {
      steps++;
      const r = roads[b.seg];
      const segLen = Math.max(1.5, r.len);
      const dtSeg = remDist / segLen;
      b.t += dtSeg * b.dir;

      if (b.t >= 0 && b.t <= 1) {
        remDist = 0;
      } else {
        // Reached the end of this segment — drive seamlessly onto the next connected road!
        const overshoot = b.t > 1 ? (b.t - 1) * segLen : -b.t * segLen;
        const next = pickNextSegment(b);
        if (!next) {
          // True cul-de-sac or map edge: arrive at terminal cleanly
          b.prevSeg2 = b.prevSeg;
          b.prevSeg = -1;
          b.dir = -b.dir;
          b.t = clamp(b.t, 0, 1);
          markBusArriving(b);
          remDist = overshoot * 0.5;
          continue;
        }
        b.prevSeg2 = b.prevSeg;
        b.prevSeg = b.seg;
        b.seg = next.seg;
        b.dir = next.dir;
        b.t = b.dir > 0 ? 0 : 1;
        // Gently adapt speed to new street's real speed
        const ns = segSpeed[b.seg] || 26;
        b.pxPerSec = lerp(b.pxPerSec, 48 + clamp(ns, 10, 55) * 1.5, 0.35);
        // Leave a subtle glow wake on streets the bus actually drives over!
        if (segGlow[b.seg] < 0.35) segGlow[b.seg] = Math.min(0.45, segGlow[b.seg] + 0.08);
        remDist = overshoot;
      }
    }

    const r = roads[b.seg];
    const px = lerp(r.x1, r.x2, clamp(b.t, 0, 1));
    const py = lerp(r.y1, r.y2, clamp(b.t, 0, 1));
    b.trail.push(px, py);
    // Keep last 24 trail points (48 numbers) for longer, gracefully fading wakes
    if (b.trail.length > 48) {
      b.trail.splice(0, 2);
      // Anti-stall guard: if a bus is looping in a tiny roundabout/intersection (<6px net travel), fade it out!
      if (!b.dying) {
        const netDx = px - b.trail[0], netDy = py - b.trail[1];
        if (netDx * netDx + netDy * netDy < 36) markBusArriving(b);
      }
    }
  }
}

// ============================================================================
// Interactive Map Camera (Zoom 1x..6x & Pan)
// ============================================================================
const cam = { zoom: 1, x: 0, y: 0, minZoom: 1, maxZoom: 6 };

function camMarkerScale() {
  return 1 / Math.pow(cam.zoom, 0.68);
}

function clampCamera() {
  cam.zoom = clamp(cam.zoom, cam.minZoom, cam.maxZoom);
  if (cam.zoom <= 1.001) {
    cam.zoom = 1; cam.x = 0; cam.y = 0;
  } else {
    const minX = W - W * cam.zoom;
    const minY = H - H * cam.zoom;
    cam.x = clamp(cam.x, minX, 0);
    cam.y = clamp(cam.y, minY, 0);
  }
  const resetBtn = $("zoomResetBtn");
  if (resetBtn) {
    const zoomed = cam.zoom > 1.02;
    resetBtn.hidden = !zoomed;
    if (zoomed) resetBtn.textContent = `${cam.zoom.toFixed(1)}×`;
    canvas.classList.toggle("pannable", zoomed);
  }
}

function zoomAtCanvasPoint(factor, cx, cy) {
  const oldZ = cam.zoom;
  const newZ = clamp(oldZ * factor, cam.minZoom, cam.maxZoom);
  if (Math.abs(newZ - oldZ) < 1e-4) return;
  const wx = (cx - cam.x) / oldZ;
  const wy = (cy - cam.y) / oldZ;
  cam.zoom = newZ;
  cam.x = cx - wx * newZ;
  cam.y = cy - wy * newZ;
  clampCamera();
  if (!playing && DATA) renderFrame(progress, 0.016);
}

function resetCamera() {
  cam.zoom = 1; cam.x = 0; cam.y = 0;
  clampCamera();
  if (!playing && DATA) renderFrame(progress, 0.016);
}

function clientToCanvasXY(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  // Account for object-fit: contain letterboxing on #canvas
  const canvasAspect = W / H;
  const rectAspect = rect.width / rect.height;
  let drawW, drawH, offX, offY;
  if (rectAspect > canvasAspect) {
    drawH = rect.height; drawW = drawH * canvasAspect;
    offX = rect.left + (rect.width - drawW) * 0.5; offY = rect.top;
  } else {
    drawW = rect.width; drawH = drawW / canvasAspect;
    offX = rect.left; offY = rect.top + (rect.height - drawH) * 0.5;
  }
  return [
    ((clientX - offX) / drawW) * W,
    ((clientY - offY) / drawH) * H,
  ];
}

// ============================================================================
// Rendering Pipeline
// ============================================================================
function drawAtmosphere(solar) {
  const { daylight, dawnGlow, duskGlow, sunProgress } = solar;

  // Lighter twilight-slate night so the entire street network stays clearly readable 24/7
  const nightBg = [18, 26, 46];
  const dayBg = [235, 229, 217];
  let bg = mixRGB(nightBg, dayBg, daylight);

  const dawnTint = [56, 28, 48];
  const duskTint = [58, 26, 38];
  if (dawnGlow > 0.02) bg = mixRGB(bg, dawnTint, dawnGlow * 0.42 * (1 - daylight * 0.5));
  if (duskGlow > 0.02) bg = mixRGB(bg, duskTint, duskGlow * 0.46 * (1 - daylight * 0.5));

  ctx.fillStyle = rgbStr(bg);
  ctx.fillRect(0, 0, W, H);

  // Directional solar warmth wash rendered at 1/10th res and bilinear-upscaled (100x faster in Firefox!)
  const washAlpha = daylight * 0.22 + dawnGlow * 0.30 + duskGlow * 0.34;
  if (washAlpha > 0.01) {
    const sw = 192, sh = 108;
    const sunX = lerp(sw * 0.92, sw * 0.08, sunProgress);
    const sunY = lerp(sh * 0.52, sh * 0.14, Math.sin(sunProgress * Math.PI));
    sunCtx.clearRect(0, 0, sw, sh);
    const g = sunCtx.createRadialGradient(sunX, sunY, 4, sunX, sunY, sw * 0.85);
    const sunCol = dawnGlow > duskGlow
      ? mixRGB([255, 165, 96], [255, 248, 226], daylight)
      : mixRGB([255, 118, 72], [255, 248, 226], daylight);
    g.addColorStop(0, rgbStr(sunCol, washAlpha));
    g.addColorStop(0.55, rgbStr(sunCol, washAlpha * 0.28));
    g.addColorStop(1, "rgba(0,0,0,0)");
    sunCtx.fillStyle = g;
    sunCtx.fillRect(0, 0, sw, sh);
    ctx.drawImage(sunCanvas, 0, 0, W, H);
  }
}

const ROAD_NIGHT_RGB = [[148,186,240,0.68],[128,164,218,0.56],[110,144,196,0.46],[96,128,178,0.38],[82,112,158,0.30]];
const ROAD_DAY_RGB   = [[92,84,74,0.56],[108,100,88,0.46],[122,114,100,0.38],[136,128,114,0.30],[148,140,126,0.24]];
const ROAD_WIDTHS    = [2.4, 1.9, 1.45, 1.05, 0.75];

function drawRoadBase(solar) {
  const { daylight } = solar;
  // At 1x..1.35x use pre-rendered offscreen canvases (ultra-fast); when zoomed in, stroke crisp culled vectors!
  if (cam.zoom <= 1.35) {
    if (daylight < 0.99) {
      ctx.globalAlpha = 1 - daylight;
      ctx.drawImage(bgNight, 0, 0);
    }
    if (daylight > 0.01) {
      ctx.globalAlpha = daylight;
      ctx.drawImage(bgDay, 0, 0);
    }
    ctx.globalAlpha = 1;
    return;
  }

  // Viewport-culled vector street network for razor-sharp zoomed detail
  const vx0 = -cam.x / cam.zoom - 40;
  const vy0 = -cam.y / cam.zoom - 40;
  const vx1 = (W - cam.x) / cam.zoom + 40;
  const vy1 = (H - cam.y) / cam.zoom + 40;
  const wScale = 1 / Math.pow(cam.zoom, 0.70);

  ctx.save();
  ctx.lineCap = "round";
  for (let tier = 4; tier >= 0; tier--) {
    const n = ROAD_NIGHT_RGB[tier], d = ROAD_DAY_RGB[tier];
    const col = mixRGB(n, d, daylight);
    const alpha = lerp(n[3], d[3], daylight);
    ctx.beginPath();
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i];
      if (r.tier !== tier) continue;
      if ((r.x1 < vx0 && r.x2 < vx0) || (r.x1 > vx1 && r.x2 > vx1) ||
          (r.y1 < vy0 && r.y2 < vy0) || (r.y1 > vy1 && r.y2 > vy1)) continue;
      ctx.moveTo(r.x1, r.y1);
      ctx.lineTo(r.x2, r.y2);
    }
    ctx.strokeStyle = rgbStr(col, alpha);
    ctx.lineWidth = ROAD_WIDTHS[tier] * wScale;
    ctx.stroke();
  }
  ctx.restore();
}

function drawWarmStreetGlow(solar) {
  // Batched warm-gold street illumination: 4 intensity buckets -> 8 stroke() calls total
  // instead of 5,000 individual beginPath/stroke calls (massive speedup on Firefox!)
  const { daylight } = solar;
  const isNight = daylight < 0.55;
  ctx.save();
  ctx.lineCap = "round";
  ctx.globalCompositeOperation = isNight ? "lighter" : "source-over";

  const haloCol = mixRGB([245, 148, 36], [218, 108, 20], daylight);
  const coreCol = mixRGB([255, 212, 112], [234, 128, 24], daylight);

  // Bucket active segments into 4 glow tiers: [0.14..0.32, 0.32..0.52, 0.52..0.74, 0.74..1.0]
  const buckets = [[], [], [], []];
  for (let i = 0; i < activeSegPool.length; i++) {
    const idx = activeSegPool[i];
    const g = segGlow[idx];
    if (g < 0.14) continue;
    const b = g < 0.32 ? 0 : g < 0.52 ? 1 : g < 0.74 ? 2 : 3;
    buckets[b].push(idx);
  }

  const bucketMid = [0.22, 0.42, 0.63, 0.88];
  const haloWidths = [4.2, 5.8, 7.2, 8.8];
  const coreWidths = [1.3, 1.6, 2.0, 2.5];

  // Pass 1: wide warm halo (max 4 stroke calls)
  for (let b = 0; b < 4; b++) {
    const list = buckets[b];
    if (list.length === 0) continue;
    ctx.beginPath();
    for (let i = 0; i < list.length; i++) {
      const r = roads[list[i]];
      ctx.moveTo(r.x1, r.y1);
      ctx.lineTo(r.x2, r.y2);
    }
    ctx.strokeStyle = rgbStr(haloCol, bucketMid[b] * (isNight ? 0.12 : 0.08));
    ctx.lineWidth = haloWidths[b];
    ctx.stroke();
  }

  // Pass 2: warm corridor trace (max 4 stroke calls)
  for (let b = 0; b < 4; b++) {
    const list = buckets[b];
    if (list.length === 0) continue;
    ctx.beginPath();
    for (let i = 0; i < list.length; i++) {
      const r = roads[list[i]];
      ctx.moveTo(r.x1, r.y1);
      ctx.lineTo(r.x2, r.y2);
    }
    ctx.strokeStyle = rgbStr(coreCol, bucketMid[b] * (isNight ? 0.16 : 0.12));
    ctx.lineWidth = coreWidths[b];
    ctx.stroke();
  }
  ctx.restore();
}

function drawDrivingBuses(solar) {
  // Batched per-operator trails, halos & dots (5 operator buckets -> ultra fast on Firefox!)
  const { daylight } = solar;
  const isNight = daylight < 0.55;
  const nColors = OPERATOR_COLORS_NIGHT.length;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalCompositeOperation = isNight ? "lighter" : "source-over";

  // Group active buses by operator index (0..4)
  const byColor = new Array(nColors);
  for (let c = 0; c < nColors; c++) byColor[c] = [];
  for (let i = 0; i < busesPool.length; i++) {
    const b = busesPool[i];
    if (b.trail.length < 2 || b.alpha < 0.20) continue;
    byColor[b.colorIdx].push(b);
  }

  const trailWidth = isNight ? 2.4 : 2.6;
  const rHalo = isNight ? 5.2 : 4.6;
  const rHead = isNight ? 2.4 : 2.3;

  // 1) Trails + halos + crisp operator-colored dots
  for (let c = 0; c < nColors; c++) {
    const list = byColor[c];
    if (list.length === 0) continue;
    const col = mixRGB(OPERATOR_COLORS_NIGHT[c], OPERATOR_COLORS_DAY[c], daylight);

    // Curved trails with 4-stage lingering comet fade (tail -> mid -> head)
    const segAlpha = isNight ? [0.16, 0.34, 0.56, 0.82] : [0.14, 0.30, 0.52, 0.76];
    const segWidth = isNight ? [1.3, 1.8, 2.3, 2.9] : [1.4, 1.9, 2.4, 3.0];
    for (let tier = 0; tier < 4; tier++) {
      ctx.beginPath();
      for (let i = 0; i < list.length; i++) {
        const tr = list[i].trail;
        const nPts = tr.length >> 1;
        if (nPts < 2) continue;
        const s0 = Math.floor((tier / 4) * (nPts - 1));
        const s1 = Math.ceil(((tier + 1) / 4) * (nPts - 1));
        if (s1 <= s0) continue;
        ctx.moveTo(tr[s0 * 2], tr[s0 * 2 + 1]);
        for (let k = s0 + 1; k <= s1; k++) {
          ctx.lineTo(tr[k * 2], tr[k * 2 + 1]);
        }
      }
      ctx.strokeStyle = rgbStr(col, segAlpha[tier]);
      ctx.lineWidth = segWidth[tier];
      ctx.stroke();
    }

    // Soft colored halo
    ctx.beginPath();
    for (let i = 0; i < list.length; i++) {
      const tr = list[i].trail;
      const hx = tr[tr.length - 2], hy = tr[tr.length - 1];
      ctx.moveTo(hx + rHalo, hy);
      ctx.arc(hx, hy, rHalo, 0, Math.PI * 2);
    }
    ctx.fillStyle = rgbStr(col, isNight ? 0.36 : 0.32);
    ctx.fill();

    // Vivid colored bus core dot
    ctx.beginPath();
    for (let i = 0; i < list.length; i++) {
      const tr = list[i].trail;
      const hx = tr[tr.length - 2], hy = tr[tr.length - 1];
      ctx.moveTo(hx + rHead, hy);
      ctx.arc(hx, hy, rHead, 0, Math.PI * 2);
    }
    ctx.fillStyle = rgbStr(col, 0.98);
    ctx.fill();
  }

  // 2) Readable operator-colored bus route number next to every dot (pre-rendered sprites!)
  ctx.globalCompositeOperation = "source-over";
  for (let i = 0; i < busesPool.length; i++) {
    const b = busesPool[i];
    const tr = b.trail;
    if (tr.length < 2 || b.alpha < 0.35) continue;
    const spr = getLabelSprite(b.line, b.colorIdx, isNight);
    ctx.drawImage(spr, (tr[tr.length - 2] + 4) | 0, (tr[tr.length - 1] - 8) | 0);
  }
  ctx.restore();
}

function drawStationEvents(solar) {
  if (stationEvents.length === 0) return;
  const { daylight } = solar;
  const isNight = daylight < 0.55;
  const ms = 1 / Math.pow(cam.zoom, 0.85);
  ctx.save();
  ctx.globalCompositeOperation = isNight ? "lighter" : "source-over";

  for (let i = 0; i < stationEvents.length; i++) {
    const ev = stationEvents[i];
    const col = mixRGB(OPERATOR_COLORS_NIGHT[ev.colorIdx], OPERATOR_COLORS_DAY[ev.colorIdx], daylight);
    const t = ev.t;

    if (ev.kind === "depart") {
      // BORN (leaving first station): expanding ripple circle + bright 4-point launch sparkle
      const ease = 1 - Math.pow(1 - t, 3);
      const r = (3 + ease * 20) * ms;
      const a = (1 - t) * (isNight ? 0.88 : 0.80);
      ctx.strokeStyle = rgbStr(col, a);
      ctx.lineWidth = 2.0 * (1 - t * 0.45) * ms;
      ctx.beginPath();
      ctx.arc(ev.x, ev.y, r, 0, Math.PI * 2);
      ctx.stroke();

      if (t < 0.55) {
        const st = 1 - t / 0.55;
        const arm = (4 + (1 - st) * 7) * ms;
        ctx.strokeStyle = rgbStr(isNight ? [255, 252, 240] : col, st * 0.92);
        ctx.lineWidth = 1.5 * ms;
        ctx.beginPath();
        ctx.moveTo(ev.x - arm, ev.y); ctx.lineTo(ev.x + arm, ev.y);
        ctx.moveTo(ev.x, ev.y - arm); ctx.lineTo(ev.x, ev.y + arm);
        ctx.stroke();
      }
    } else {
      // DIES (reaching last station): collapsing diamond + crisp terminal square
      const ease = t * t * (3 - 2 * t);
      const outer = (17 - ease * 13) * ms;
      const a = Math.sin(t * Math.PI) * (isNight ? 0.90 : 0.85);

      ctx.strokeStyle = rgbStr(col, a);
      ctx.lineWidth = 1.8 * ms;
      ctx.beginPath();
      ctx.moveTo(ev.x, ev.y - outer);
      ctx.lineTo(ev.x + outer, ev.y);
      ctx.lineTo(ev.x, ev.y + outer);
      ctx.lineTo(ev.x - outer, ev.y);
      ctx.closePath();
      ctx.stroke();

      const core = 5.0 * (1 - t * 0.65) * ms;
      ctx.fillStyle = rgbStr(col, (1 - t) * 0.92);
      ctx.fillRect(ev.x - core, ev.y - core, core * 2, core * 2);
    }
  }
  ctx.restore();
}

function drawLandmarks(solar) {
  const { daylight } = solar;
  // Steep contrast switch so labels stay crisp even during twilight
  const lightUI = smoothstep(0.45, 0.72, daylight);
  const txtCol = mixRGB([195, 212, 238], [52, 46, 40], lightUI);
  const dotCol = mixRGB([251, 191, 36], [140, 74, 24], lightUI);
  const s = 1 / Math.pow(cam.zoom, 0.72);

  ctx.save();
  ctx.font = `500 ${(13 * s).toFixed(2)}px "JetBrains Mono", monospace`;
  ctx.textBaseline = "middle";
  for (const lm of DATA.landmarks) {
    const x = toScreenX(lm.x), y = toScreenY(lm.y);
    ctx.fillStyle = rgbStr(dotCol, 0.78);
    ctx.beginPath();
    ctx.arc(x, y, 2.5 * s, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = rgbStr(txtCol, 0.75);
    ctx.fillText(lm.name.toUpperCase(), x + 8 * s, y);
  }
  ctx.restore();
}

function drawVignette(solar) {
  ctx.drawImage(solar.daylight < 0.5 ? vignetteNight : vignetteDay, 0, 0, W, H);
}

function drawHUD(state, solar) {
  const { daylight } = solar;
  const { dayIdx, minuteOfDay, buses } = state;

  displayBuses = lerp(displayBuses, buses, 0.18);

  // Steep contrast transition: dark translucent glass in night/twilight, crisp ivory glass in full day!
  const lightUI = smoothstep(0.52, 0.76, daylight);
  const inkPrimary = mixRGB([248, 250, 255], [24, 22, 20], lightUI);
  const inkMuted   = mixRGB([176, 194, 220], [92, 84, 74], lightUI);
  const panelBg    = mixRGB([8, 13, 26], [248, 244, 236], lightUI);
  const panelEdge  = mixRGB([255, 255, 255], [40, 34, 26], lightUI);

  const dayName = DATA.meta.days[dayIdx].toUpperCase();
  const dateNum = 15 + dayIdx;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const mm = String(Math.floor(minuteOfDay % 60)).padStart(2, "0");
  const phase = getPhaseLabel(dayIdx, minuteOfDay);

  ctx.save();

  // --- TOP-LEFT: Editorial Title + Oversized Clock + Celestial Dial ---
  const x0 = 56, y0 = 54;

  // Subtle translucent glass backing behind top-left title/clock so twilight never muddies contrast
  ctx.fillStyle = rgbStr(panelBg, lerp(0.56, 0.70, lightUI));
  ctx.strokeStyle = rgbStr(panelEdge, 0.14);
  ctx.lineWidth = 1;
  roundRect(ctx, x0 - 22, y0 - 26, 405, 224, 16);
  ctx.fill(); ctx.stroke();

  ctx.font = '600 12px "JetBrains Mono", monospace';
  ctx.fillStyle = phase.accent;
  ctx.fillText(`OPEN BUS STRIDE · JERUSALEM · NOV ${dateNum}, 2026`, x0, y0);

  ctx.font = '400 44px "Instrument Serif", Georgia, serif';
  ctx.fillStyle = rgbStr(inkPrimary, 0.98);
  ctx.fillText("The Pulse of Jerusalem", x0, y0 + 44);

  ctx.font = '600 14px "JetBrains Mono", monospace';
  ctx.fillStyle = rgbStr(inkMuted, 0.95);
  ctx.fillText(`${dayName}  ·  ${phase.text}`, x0, y0 + 74);

  // Oversized digital clock + analog celestial ring
  const cx = x0 + 38, cy = y0 + 138, cr = 31;
  ctx.strokeStyle = rgbStr(inkMuted, 0.42);
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.stroke();

  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2 - Math.PI / 2;
    const r1 = k % 3 === 0 ? cr - 7 : cr - 4;
    ctx.strokeStyle = rgbStr(inkMuted, k % 3 === 0 ? 0.75 : 0.35);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineTo(cx + Math.cos(a) * cr, cy + Math.sin(a) * cr);
    ctx.stroke();
  }

  const hourAngle = ((minuteOfDay / 720) * Math.PI * 2) - Math.PI / 2;
  const minAngle  = (((minuteOfDay % 60) / 60) * Math.PI * 2) - Math.PI / 2;
  ctx.strokeStyle = rgbStr(inkPrimary, 0.95);
  ctx.lineWidth = 2.4; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(hourAngle) * 16, cy + Math.sin(hourAngle) * 16); ctx.stroke();

  ctx.strokeStyle = phase.accent;
  ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(minAngle) * 24, cy + Math.sin(minAngle) * 24); ctx.stroke();

  // Sun / Moon orb
  const orbAngle = ((minuteOfDay / 1440) * Math.PI * 2) + Math.PI / 2;
  const ox = cx + Math.cos(orbAngle) * (cr + 7);
  const oy = cy + Math.sin(orbAngle) * (cr + 7);
  ctx.fillStyle = daylight > 0.35 ? "#f59e0b" : "#93c5fd";
  ctx.beginPath(); ctx.arc(ox, oy, 4.2, 0, Math.PI * 2); ctx.fill();

  ctx.font = '300 72px "JetBrains Mono", monospace';
  ctx.fillStyle = rgbStr(inkPrimary, 0.98);
  ctx.fillText(`${hh}:${mm}`, x0 + 88, y0 + 161);

  // --- BOTTOM-LEFT: Active Bus Counter + Operator Legend + 7-Day / 24h Heartbeat Waveform ---
  const bx = 56, by = H - 252;
  const bw = 430, bh = 192;
  ctx.fillStyle = rgbStr(panelBg, lerp(0.64, 0.76, lightUI));
  ctx.strokeStyle = rgbStr(panelEdge, 0.16);
  ctx.lineWidth = 1;
  roundRect(ctx, bx - 18, by - 18, bw + 36, bh + 30, 14);
  ctx.fill(); ctx.stroke();

  ctx.font = '600 11px "JetBrains Mono", monospace';
  ctx.fillStyle = rgbStr(inkMuted, 0.92);
  ctx.fillText("ACTIVE BUSES ON JERUSALEM STREETS", bx, by + 4);

  ctx.font = '500 40px "JetBrains Mono", monospace';
  ctx.fillStyle = rgbStr(inkPrimary, 0.98);
  ctx.fillText(String(Math.round(displayBuses)), bx, by + 46);

  ctx.font = '400 11px "JetBrains Mono", monospace';
  ctx.fillStyle = rgbStr(inkMuted, 0.88);
  ctx.fillText("1 dot ≈ 1 active bus · colored by operator", bx + 118, by + 38);

  // Compact 6-operator color key row
  let lx = bx;
  const ly = by + 66;
  ctx.font = '500 10px "JetBrains Mono", monospace';
  for (let o = 0; o < OPERATOR_META.length; o++) {
    const op = OPERATOR_META[o];
    const col = mixRGB(op.night, op.day, daylight);
    ctx.fillStyle = rgbStr(col, 0.98);
    ctx.beginPath();
    ctx.arc(lx + 3.5, ly - 3, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgbStr(inkPrimary, 0.88);
    ctx.fillText(op.name, lx + 10.5, ly);
    lx += ctx.measureText(op.name).width + 18;
  }

  // Heartbeat waveform
  const wx = bx, wy = by + 90, ww = bw, wh = 66;
  const lineMode = selectedLineKeys.size > 0;
  const curve = lineMode ? state.lineCurve : null;
  const maxB = lineMode ? Math.max(1, state.lineMaxB || 1) : viewMaxBuses;

  if (viewCount === slices.length) {
    const colW = ww / 7;
    ctx.strokeStyle = rgbStr(inkMuted, 0.34);
    ctx.lineWidth = 1;
    const labels = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    ctx.font = '600 9.5px "JetBrains Mono", monospace';
    ctx.textAlign = "center";
    for (let d = 0; d < 7; d++) {
      const dx = wx + d * colW;
      if (d > 0) {
        ctx.beginPath(); ctx.moveTo(dx, wy); ctx.lineTo(dx, wy + wh + 4); ctx.stroke();
      }
      ctx.fillStyle = d === state.dayIdx ? rgbStr(inkPrimary, 0.98) : rgbStr(inkMuted, 0.78);
      ctx.fillText(labels[d], dx + colW * 0.5, wy + wh + 14);
    }
    ctx.textAlign = "left";
  } else {
    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.fillStyle = rgbStr(inkMuted, 0.78);
    ["00", "06", "12", "18", "24"].forEach((t, k) => {
      ctx.fillText(t + ":00", wx + (k / 4) * (ww - 30), wy + wh + 14);
    });
  }

  const nPts = lineMode ? curve.length : viewCount;
  ctx.beginPath();
  ctx.moveTo(wx, wy + wh);
  for (let i = 0; i < nPts; i++) {
    const val = lineMode ? curve[i] : slices[viewStart + i].b;
    const px = wx + (i / Math.max(1, nPts - 1)) * ww;
    const py = wy + wh - (val / maxB) * (wh - 4);
    ctx.lineTo(px, py);
  }
  ctx.lineTo(wx + ww, wy + wh);
  ctx.closePath();
  const wg = ctx.createLinearGradient(0, wy, 0, wy + wh);
  wg.addColorStop(0, lineMode ? "rgba(56, 189, 248, 0.50)" : "rgba(245, 158, 11, 0.50)");
  wg.addColorStop(1, lineMode ? "rgba(56, 189, 248, 0.05)" : "rgba(245, 158, 11, 0.05)");
  ctx.fillStyle = wg;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < nPts; i++) {
    const val = lineMode ? curve[i] : slices[viewStart + i].b;
    const px = wx + (i / Math.max(1, nPts - 1)) * ww;
    const py = wy + wh - (val / maxB) * (wh - 4);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = lineMode ? "rgba(56, 189, 248, 0.92)" : "rgba(245, 158, 11, 0.92)";
  ctx.lineWidth = 1.7;
  ctx.stroke();

  const headX = wx + progress * ww;
  const headY = wy + wh - (buses / maxB) * (wh - 4);
  ctx.strokeStyle = rgbStr(inkPrimary, 0.95);
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(headX, wy - 2); ctx.lineTo(headX, wy + wh); ctx.stroke();

  ctx.fillStyle = lineMode ? "#38bdf8" : "#f59e0b";
  ctx.beginPath(); ctx.arc(headX, headY, 4.4, 0, Math.PI * 2); ctx.fill();

  // Subtle bottom-right credit (baked into screenshots & recorded video)
  ctx.font = '400 11px "JetBrains Mono", monospace';
  ctx.fillStyle = rgbStr(inkMuted, 0.72);
  ctx.textAlign = "right";
  ctx.fillText("© Harel Cain (הראל קין) · CC BY-NC-SA 4.0 · slowbus-jlm · Data: Open Bus Stride (Hasadna) & OpenStreetMap", W - 40, H - 24);
  ctx.textAlign = "left";

  ctx.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ============================================================================
// Persistent Local IndexedDB Cache for Line GPS Snapshots (zero re-polling!)
// ============================================================================
const LINE_DB_NAME = "slowbus-jlm-lines-v1";
const LINE_STORE = "lines";
let lineDbPromise = null;

function openLineDB() {
  if (lineDbPromise) return lineDbPromise;
  lineDbPromise = new Promise((resolve) => {
    if (!window.indexedDB) { resolve(null); return; }
    const req = indexedDB.open(LINE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LINE_STORE)) db.createObjectStore(LINE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return lineDbPromise;
}

async function idbGetLine(key) {
  const db = await openLineDB();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(LINE_STORE, "readonly");
    const req = tx.objectStore(LINE_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function idbPutLine(key, ld) {
  const db = await openLineDB();
  if (!db) return;
  // Store compact serializable form
  const payload = {
    line: ld.line,
    opRef: ld.opRef,
    agency: ld.agency,
    loadedDayMask: ld.loadedDayMask,
    siriRouteIds: ld.siriRouteIds,
    trips: ld.trips.map((t) => ({ id: t.id, t0: t.t0, t1: t.t1, pts: t.pts })),
  };
  return new Promise((resolve) => {
    const tx = db.transaction(LINE_STORE, "readwrite");
    tx.objectStore(LINE_STORE).put(payload, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function hydrateCachedLine(rec) {
  const ld = {
    line: rec.line,
    opRef: rec.opRef,
    colorIdx: operatorGroupFromRef(rec.opRef),
    agency: rec.agency || "",
    trips: rec.trips.map((t) => ({
      id: t.id, t0: t.t0, t1: t.t1,
      pts: t.pts instanceof Float32Array ? t.pts : new Float32Array(t.pts),
    })),
    tripIds: new Set(rec.trips.map((t) => t.id)),
    loadedDayMask: rec.loadedDayMask || 0,
    siriRouteIds: rec.siriRouteIds || null,
    curve504: new Float32Array(504),
  };
  rebuildLineCurve504(ld);
  return ld;
}

// ============================================================================
// Real GPS Per-Line Loader & Playback Engine (Open Bus Stride — 7 Days!)
// ============================================================================
const STRIDE_API = "https://open-bus-stride-api.hasadna.org.il";
const WEEK_START_UTC_MS = Date.UTC(2026, 10, 14, 22, 0, 0); // Sun Nov 15, 2026 00:00 Asia/Jerusalem

function rebuildLineCurve504(ld) {
  const curve = new Float32Array(504);
  const trips = ld.trips;
  for (let b = 0; b < 504; b++) {
    const m = b * 20;
    let cnt = 0;
    for (let i = 0; i < trips.length; i++) {
      if (trips[i].t0 <= m && trips[i].t1 >= m) cnt++;
    }
    curve[b] = cnt;
  }
  ld.curve504 = curve;
}

function prepareLineData(raw, loadedDayMask = 0x7f) {
  const colorIdx = operatorGroupFromRef(raw.opRef);
  const trips = raw.trips.map((t) => {
    const p = t.pts;
    // Convert to screen coordinates and strip isolated single-ping GPS glitch spikes
    const rawScreen = [];
    for (let i = 0; i < p.length; i += 3) {
      rawScreen.push([p[i], toScreenX(p[i + 1]), toScreenY(p[i + 2])]);
    }
    const cleaned = [];
    for (let i = 0; i < rawScreen.length; i++) {
      if (i > 0 && i < rawScreen.length - 1) {
        const a = rawScreen[i - 1], b = rawScreen[i], c = rawScreen[i + 1];
        const dab = (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2;
        const dbc = (c[1] - b[1]) ** 2 + (c[2] - b[2]) ** 2;
        const dac = (c[1] - a[1]) ** 2 + (c[2] - a[2]) ** 2;
        if (dab > 1600 && dbc > 1600 && dac < 1600) continue; // single-ping GPS spike!
      }
      cleaned.push(rawScreen[i]);
    }
    const screenPts = new Float32Array(cleaned.length * 3);
    for (let i = 0; i < cleaned.length; i++) {
      screenPts[i * 3] = cleaned[i][0];
      screenPts[i * 3 + 1] = cleaned[i][1];
      screenPts[i * 3 + 2] = cleaned[i][2];
    }
    return { id: t.id, t0: t.t0, t1: t.t1, pts: screenPts };
  });
  const ld = {
    line: raw.line,
    opRef: raw.opRef,
    colorIdx,
    agency: raw.agency || "",
    trips,
    tripIds: new Set(trips.map((t) => t.id)),
    loadedDayMask,
    siriRouteIds: null,
    curve504: new Float32Array(504),
  };
  rebuildLineCurve504(ld);
  return ld;
}

function requiredDayMaskForRange() {
  const val = $("rangeSelect").value;
  return val === "week" ? 0x7f : (1 << (+val));
}

async function ensureLineLoaded(meta) {
  const key = `${meta.line}:${meta.opRef}`;
  const reqMask = requiredDayMaskForRange();
  let ld = lineTripsCache.get(key);
  if (ld && (ld.loadedDayMask & reqMask) === reqMask) return;
  if (loadingLineKeys.has(key)) return;

  loadingLineKeys.add(key);
  updateLinePickerSummary();
  try {
    if (!ld) {
      ld = prepareLineData({ line: meta.line, opRef: meta.opRef, agency: meta.agency, trips: [] }, 0);
      lineTripsCache.set(key, ld);
    }

    // Light Rail L1 / L3 (Kfir opRef === 21): build directly from official GTFS timetable (data/jlm-lightrail.json)
    if (meta.opRef === 21) {
      if (!lightRailData) await loadLightRail();
      if (lightRailData) {
        let tripSeq = 1;
        for (let d = 0; d < 7; d++) {
          if (!(reqMask & (1 << d)) || (ld.loadedDayMask & (1 << d))) continue;
          const dayBase = d * 1440;
          const dayRides = lightRailData.days[d] || [];
          for (let i = 0; i < dayRides.length; i++) {
            const [pidx, t0, t1] = dayRides[i];
            const pat = lightRailData.patterns[pidx];
            if (!pat || pat.line !== meta.line) continue;
            const span = t1 - t0;
            const stops = pat.screenStops;
            // Subdivide inter-station spans to <=16px so GPS-jump filters never break rail tracks!
            const sub = [];
            for (let k = 0; k < stops.length; k++) {
              const tCur = dayBase + t0 + stops[k][0] * span;
              const xCur = stops[k][1], yCur = stops[k][2];
              if (k > 0) {
                const tPrev = dayBase + t0 + stops[k - 1][0] * span;
                const xPrev = stops[k - 1][1], yPrev = stops[k - 1][2];
                const dist = Math.hypot(xCur - xPrev, yCur - yPrev);
                const steps = Math.max(1, Math.ceil(dist / 16));
                for (let s = 1; s < steps; s++) {
                  const u = s / steps;
                  sub.push(lerp(tPrev, tCur, u), lerp(xPrev, xCur, u), lerp(yPrev, yCur, u));
                }
              }
              sub.push(tCur, xCur, yCur);
            }
            const pts = new Float32Array(sub);
            const rid = d * 100000 + (tripSeq++);
            if (!ld.tripIds.has(rid)) {
              ld.trips.push({ id: rid, t0: dayBase + t0, t1: dayBase + t1, pts });
              ld.tripIds.add(rid);
            }
          }
          ld.loadedDayMask |= (1 << d);
        }
        ld.trips.sort((a, b) => a.t0 - b.t0);
        rebuildLineCurve504(ld);
        updateLinePickerStatus();
      }
      return;
    }

    // Regular bus lines: read 100% locally from outage-backfilled real-day0..6.bin (zero Thursday hole, zero API calls!)
    const curWeekMin = viewStart * 20 + progress * (viewCount * 20);
    const curDay = Math.min(6, Math.max(0, Math.floor(curWeekMin / 1440)));
    for (let offset = 0; offset < 7; offset++) {
      if (!selectedLineKeys.has(key)) break;
      const d = (curDay + offset) % 7;
      if (!(reqMask & (1 << d)) || (ld.loadedDayMask & (1 << d))) continue;
      await loadRealDay(d);
      const dayData = realDays[d];
      if (!dayData || dayData === "loading") continue;
      const dayBase = d * 1440;
      let added = 0;
      for (let i = 0; i < dayData.rides.length; i++) {
        const tr = dayData.rides[i];
        if (tr.line !== meta.line || tr.opRef !== meta.opRef) continue;
        const rid = d * 1000000 + i;
        if (ld.tripIds.has(rid)) continue;
        // Shift minute-of-day into weekMin
        const src = tr.pts;
        const pts = new Float32Array(src.length);
        for (let k = 0; k < src.length; k += 3) {
          pts[k] = dayBase + src[k];
          pts[k + 1] = src[k + 1];
          pts[k + 2] = src[k + 2];
        }
        ld.trips.push({ id: rid, t0: dayBase + tr.t0, t1: dayBase + tr.t1, pts });
        ld.tripIds.add(rid);
        added++;
      }
      ld.loadedDayMask |= (1 << d);
      if (added > 0) {
        ld.trips.sort((a, b) => a.t0 - b.t0);
        rebuildLineCurve504(ld);
        updateLinePickerStatus();
      }
    }
  } catch (err) {
    console.warn("Failed loading line", key, err);
  } finally {
    loadingLineKeys.delete(key);
    updateLinePickerSummary();
    renderLinePicker();
  }
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function catmullRomDeriv(p0, p1, p2, p3, t) {
  return 0.5 * (
    (-p0 + p2) +
    (4 * p0 - 10 * p1 + 8 * p2 - 2 * p3) * t +
    (-3 * p0 + 9 * p1 - 9 * p2 + 3 * p3) * t * t
  );
}

// Trace a crisp directional dart/arrowhead into the current canvas path (no save/rotate overhead!)
function traceArrowHead(hx, hy, ux, uy, tip, back, wing, notch) {
  if (ux === 0 && uy === 0) {
    ctx.moveTo(hx + wing * 0.72, hy);
    ctx.arc(hx, hy, wing * 0.72, 0, Math.PI * 2);
    return;
  }
  const px = -uy, py = ux; // perpendicular
  ctx.moveTo(hx + ux * tip, hy + uy * tip);
  ctx.lineTo(hx - ux * back + px * wing, hy - uy * back + py * wing);
  ctx.lineTo(hx - ux * notch, hy - uy * notch);
  ctx.lineTo(hx - ux * back - px * wing, hy - uy * back - py * wing);
  ctx.closePath();
}

function lastNonZeroHeading(pts, idx) {
  for (let k = idx; k >= 3; k -= 3) {
    const dx = pts[k + 1] - pts[k - 2], dy = pts[k + 2] - pts[k - 1];
    const len = Math.hypot(dx, dy);
    if (len > 0.6 && len < 340) return [dx / len, dy / len];
  }
  for (let k = idx + 3; k < pts.length; k += 3) {
    const dx = pts[k + 1] - pts[k - 2], dy = pts[k + 2] - pts[k - 1];
    const len = Math.hypot(dx, dy);
    if (len > 0.6 && len < 340) return [dx / len, dy / len];
  }
  return [0, 0];
}

function interpolateTrip(pts, m) {
  // pts = Float32Array [t, x, y, t, x, y, ...]
  // Returns [x, y, i0, ux, uy] where (ux, uy) is unit heading vector
  const n = pts.length;
  if (n < 3) return null;
  if (m <= pts[0]) {
    const [ux, uy] = lastNonZeroHeading(pts, 0);
    return [pts[1], pts[2], 0, ux, uy];
  }
  if (m >= pts[n - 3]) {
    const [ux, uy] = lastNonZeroHeading(pts, n - 3);
    return [pts[n - 2], pts[n - 1], n - 3, ux, uy];
  }
  let lo = 0, hi = (n / 3) - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid * 3] <= m) lo = mid; else hi = mid;
  }
  const i0 = lo * 3, i1 = hi * 3;
  const dt = pts[i1] - pts[i0];
  // Scale: 1 px ≈ 12 m (1 km ≈ 83 px). Allow real highway speeds up to ~120 km/h (165 px/min)!
  if (dt > 5.5) return null;
  const dx = pts[i1 + 1] - pts[i0 + 1], dy = pts[i1 + 2] - pts[i0 + 2];
  const distSq = dx * dx + dy * dy;
  const maxStep = Math.max(80, dt * 165 + 45);
  if (distSq > 120000 || distSq > maxStep * maxStep) return null; // true GPS teleport only!

  const f = dt > 0.0001 ? clamp((m - pts[i0]) / dt, 0, 1) : 0;
  // Catmull-Rom spline across 4 neighboring GPS pings (only if neighbor segments are also clean)
  const im = Math.max(0, i0 - 3);
  const ip = Math.min(n - 3, i1 + 3);
  const dPrevSq = (pts[i0 + 1] - pts[im + 1]) ** 2 + (pts[i0 + 2] - pts[im + 2]) ** 2;
  const dNextSq = (pts[ip + 1] - pts[i1 + 1]) ** 2 + (pts[ip + 2] - pts[i1 + 2]) ** 2;
  let x, y, vx, vy;
  if (dPrevSq > 45000 || dNextSq > 45000) {
    x = lerp(pts[i0 + 1], pts[i1 + 1], f);
    y = lerp(pts[i0 + 2], pts[i1 + 2], f);
    vx = dx; vy = dy;
  } else {
    x = catmullRom(pts[im + 1], pts[i0 + 1], pts[i1 + 1], pts[ip + 1], f);
    y = catmullRom(pts[im + 2], pts[i0 + 2], pts[i1 + 2], pts[ip + 2], f);
    vx = catmullRomDeriv(pts[im + 1], pts[i0 + 1], pts[i1 + 1], pts[ip + 1], f);
    vy = catmullRomDeriv(pts[im + 2], pts[i0 + 2], pts[i1 + 2], pts[ip + 2], f);
  }
  const vLen = Math.hypot(vx, vy);
  if (vLen > 0.5) return [x, y, i0, vx / vLen, vy / vLen];
  const [ux, uy] = lastNonZeroHeading(pts, i0);
  return [x, y, i0, ux, uy];
}

// Trim a flat polyline [x0,y0, ..., hx,hy] to at most `maxLen` pixels back from its head,
// interpolating the exact cut point so the tail glides smoothly with zero snapping!
function trimPolylineFromHead(coords, maxLen) {
  const n = coords.length;
  if (n < 4) return coords;
  let accum = 0;
  for (let i = n - 2; i >= 2; i -= 2) {
    const x1 = coords[i], y1 = coords[i + 1];
    const x0 = coords[i - 2], y0 = coords[i - 1];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (accum + seg >= maxLen && seg > 0.001) {
      const remain = maxLen - accum;
      const u = remain / seg;
      const tx = x1 + (x0 - x1) * u;
      const ty = y1 + (y0 - y1) * u;
      const out = [tx, ty];
      for (let j = i; j < n; j++) out.push(coords[j]);
      return out;
    }
    accum += seg;
  }
  return coords;
}

// Draw a silky smooth quadratic-midpoint curve through flat [x0, y0, x1, y1, ...] points
function traceSmoothPolyline(coords, maxJumpSq = 2500) {
  const n = coords.length;
  if (n < 4) return;
  ctx.moveTo(coords[0], coords[1]);
  if (n === 4) { ctx.lineTo(coords[2], coords[3]); return; }
  for (let i = 2; i < n - 2; i += 2) {
    const x1 = coords[i], y1 = coords[i + 1];
    const x2 = coords[i + 2], y2 = coords[i + 3];
    const dx1 = x1 - coords[i - 2], dy1 = y1 - coords[i - 1];
    const dx2 = x2 - x1, dy2 = y2 - y1;
    if (dx1 * dx1 + dy1 * dy1 > maxJumpSq) {
      ctx.moveTo(x1, y1);
      continue;
    }
    if (dx2 * dx2 + dy2 * dy2 > maxJumpSq) {
      ctx.lineTo(x1, y1);
      ctx.moveTo(x2, y2);
      continue;
    }
    ctx.quadraticCurveTo(x1, y1, (x1 + x2) * 0.5, (y1 + y2) * 0.5);
  }
  ctx.lineTo(coords[n - 2], coords[n - 1]);
}

function drawSelectedLinesMode(weekMin, solar) {
  const { daylight } = solar;
  const isNight = daylight < 0.55;
  const prevM = lastLineMinute;
  const steppedForward = prevM >= 0 && weekMin > prevM && (weekMin - prevM) < 60;
  lastLineMinute = weekMin;

  let activeCount = 0;
  const combinedCurve = new Float32Array(viewCount);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const key of selectedLineKeys) {
    const ld = lineTripsCache.get(key);
    if (!ld) continue;
    const col = mixRGB(OPERATOR_COLORS_NIGHT[ld.colorIdx], OPERATOR_COLORS_DAY[ld.colorIdx], daylight);

    for (let b = 0; b < viewCount; b++) combinedCurve[b] += ld.curve504[viewStart + b];

    // 1) Ultra-subtle route corridor guide that fades away when no buses are on the line (e.g. deep night / Shabbat)
    const activeNowOnLine = ld.trips.some((tr) => weekMin >= tr.t0 - 10 && weekMin <= tr.t1 + 10);
    if (activeNowOnLine) {
      ctx.globalCompositeOperation = isNight ? "lighter" : "source-over";
      ctx.beginPath();
      const step = Math.max(1, Math.floor(ld.trips.length / 8));
      for (let ti = 0; ti < ld.trips.length; ti += step) {
        const pts = ld.trips[ti].pts;
        if (pts.length < 6) continue;
        const coords = [pts[1], pts[2]];
        for (let k = 3; k < pts.length; k += 3) {
          const px = pts[k + 1], py = pts[k + 2];
          const lx = coords[coords.length - 2], ly = coords[coords.length - 1];
          if ((px - lx) * (px - lx) + (py - ly) * (py - ly) >= 9) {
            coords.push(px, py);
          }
        }
        traceSmoothPolyline(coords, 120000);
      }
      ctx.strokeStyle = rgbStr(col, isNight ? 0.07 : 0.08);
      ctx.lineWidth = 2.6;
      ctx.stroke();
    }

    // 2) Active real buses on this line at weekMin (silky continuous sliding-tail gradient wakes!)
    const activePositions = [];
    ctx.globalCompositeOperation = "source-over";
    const ms = camMarkerScale();
    ctx.lineWidth = 2.2 * ms;

    for (let ti = 0; ti < ld.trips.length; ti++) {
      const tr = ld.trips[ti];
      // Real first-station departure & last-station arrival graphics (skip highway bbox exits!)
      if (steppedForward && tr.pts.length >= 9) {
        if (tr.t0 > prevM && tr.t0 <= weekMin) {
          if (!isHighwayBorderCrossing(tr.pts[1], tr.pts[2], tr.pts[4], tr.pts[5], tr.pts[3] - tr.pts[0])) {
            emitStationEvent(tr.pts[1], tr.pts[2], ld.colorIdx, "depart");
          }
        }
        if (tr.t1 > prevM && tr.t1 <= weekMin) {
          const n = tr.pts.length;
          if (!isHighwayBorderCrossing(tr.pts[n - 2], tr.pts[n - 1], tr.pts[n - 5], tr.pts[n - 4], tr.pts[n - 3] - tr.pts[n - 6])) {
            emitStationEvent(tr.pts[n - 2], tr.pts[n - 1], ld.colorIdx, "arrive");
          }
        }
      }
      if (weekMin < tr.t0 || weekMin > tr.t1) continue;
      const pos = interpolateTrip(tr.pts, weekMin);
      if (!pos) continue;
      const [hx, hy, i0, ux, uy] = pos;
      activePositions.push([hx, hy, ux, uy]);
      activeCount++;

      // Adaptive trail length: hugs city streets tightly, shrinks to a sleek short slipstream
      // on fast highway spans where 1-min GPS pings are >1 km apart (no off-road straight chords!)
      const segDist = (i0 + 3 < tr.pts.length)
        ? Math.hypot(tr.pts[i0 + 4] - tr.pts[i0 + 1], tr.pts[i0 + 5] - tr.pts[i0 + 2])
        : 0;
      const maxTrailPx = (segDist > 35 ? clamp(68 - (segDist - 35) * 0.75, 18, 68) : 68) * ms;

      let tCoords = [];
      const steps = 10;
      const wakeMin = Math.min(4.0, weekMin - tr.t0);
      if (wakeMin > 0.05) {
        for (let s = steps; s >= 1; s--) {
          const sm = weekMin - (wakeMin * s) / steps;
          const sp = interpolateTrip(tr.pts, sm);
          if (!sp) { tCoords.length = 0; continue; }
          if (tCoords.length >= 2) {
            const lx = tCoords[tCoords.length - 2], ly = tCoords[tCoords.length - 1];
            const dSq = (sp[0] - lx) * (sp[0] - lx) + (sp[1] - ly) * (sp[1] - ly);
            if (dSq > 120000) { tCoords.length = 0; continue; }
            if (dSq < 2) continue;
          }
          tCoords.push(sp[0], sp[1]);
        }
      }
      tCoords.push(hx, hy);
      tCoords = trimPolylineFromHead(tCoords, maxTrailPx);

      if (tCoords.length >= 4) {
        const tx = tCoords[0], ty = tCoords[1];
        const spanSq = (hx - tx) * (hx - tx) + (hy - ty) * (hy - ty);
        ctx.beginPath();
        traceSmoothPolyline(tCoords, 120000);
        if (spanSq > 16) {
          const g = ctx.createLinearGradient(tx, ty, hx, hy);
          g.addColorStop(0, rgbStr(col, 0.0));
          g.addColorStop(0.55, rgbStr(col, isNight ? 0.24 : 0.20));
          g.addColorStop(1, rgbStr(col, isNight ? 0.62 : 0.54));
          ctx.strokeStyle = g;
        } else {
          ctx.strokeStyle = rgbStr(col, isNight ? 0.45 : 0.38);
        }
        ctx.lineWidth = 2.2 * ms;
        ctx.stroke();
      }
    }

    // Halo + crisp directional arrowhead for each active bus (scales gently with zoom!)
    const rHalo = (isNight ? 7.2 : 6.4) * ms;
    ctx.beginPath();
    for (const [hx, hy] of activePositions) {
      ctx.moveTo(hx + rHalo, hy);
      ctx.arc(hx, hy, rHalo, 0, Math.PI * 2);
    }
    ctx.fillStyle = rgbStr(col, isNight ? 0.40 : 0.32);
    ctx.fill();

    ctx.beginPath();
    for (const [hx, hy, ux, uy] of activePositions) {
      traceArrowHead(hx, hy, ux, uy, 7.2 * ms, 4.4 * ms, 4.0 * ms, 2.0 * ms);
    }
    ctx.fillStyle = rgbStr(col, 0.98);
    ctx.fill();

    // Crisp operator-colored bus number right next to each bus!
    ctx.globalCompositeOperation = "source-over";
    const spr = getLabelSprite(ld.line, ld.colorIdx, isNight);
    const sw = spr.width * ms, sh = spr.height * ms;
    for (const [hx, hy] of activePositions) {
      ctx.drawImage(spr, hx + 6 * ms, hy - 8 * ms, sw, sh);
    }
  }

  ctx.restore();

  let maxB = 1;
  for (let b = 0; b < combinedCurve.length; b++) if (combinedCurve[b] > maxB) maxB = combinedCurve[b];
  return { activeCount, curve: combinedCurve, maxB };
}

// ============================================================================
// 100% Real GPS Vehicle Trajectories (All Lines Mode — Zero Heuristics!)
// Loads binary data/real-day0.bin .. data/real-day6.bin (SBJ1 format)
// ============================================================================
const realDays = new Array(7).fill(null);        // null | { rides, buckets }
const realDayPromises = new Array(7).fill(null); // in-flight promise per day
let lastRealDayIdx = -1;
let lastRealMin = -1;

// Official GTFS 7-day Jerusalem Light Rail (L1 & L3, Kfir opRef=21)
let lightRailData = null;
let lightRailPromise = null;
let lastRailDayIdx = -1;
let lastRailMin = -1;

function loadLightRail() {
  if (lightRailData) return Promise.resolve(lightRailData);
  if (lightRailPromise) return lightRailPromise;
  lightRailPromise = fetch("data/jlm-lightrail.json?v=34")
    .then((r) => (r.ok ? r.json() : null))
    .then((raw) => {
      if (!raw) return null;
      for (const pat of raw.patterns) {
        pat.screenStops = pat.stops.map(([f, nx, ny]) => [f, toScreenX(nx), toScreenY(ny)]);
        pat.flatCoords = [];
        for (const [, sx, sy] of pat.screenStops) pat.flatCoords.push(sx, sy);
      }
      lightRailData = raw;
      return raw;
    })
    .catch((err) => {
      console.warn("Light rail load failed:", err);
      return null;
    });
  return lightRailPromise;
}

function drawLightRail(dayIdx, minuteOfDay, solar) {
  if (!lightRailData) return 0;
  const dayRides = lightRailData.days[dayIdx];
  if (!dayRides || !dayRides.length) return 0;

  const { daylight } = solar;
  const isNight = daylight < 0.55;
  const col = mixRGB(OPERATOR_COLORS_NIGHT[5], OPERATOR_COLORS_DAY[5], daylight);

  const steppedForward = (dayIdx === lastRailDayIdx) && (minuteOfDay > lastRailMin) && ((minuteOfDay - lastRailMin) < 40);
  const prevMin = lastRailMin;
  lastRailDayIdx = dayIdx;
  lastRailMin = minuteOfDay;

  const activeTrams = []; // [hx, hy, ang, line, trailCoords]
  for (let i = 0; i < dayRides.length; i++) {
    const [pidx, t0, t1] = dayRides[i];
    const pat = lightRailData.patterns[pidx];
    const stops = pat.screenStops;
    if (steppedForward) {
      if (t0 > prevMin && t0 <= minuteOfDay) emitStationEvent(stops[0][1], stops[0][2], 5, "depart");
      if (t1 > prevMin && t1 <= minuteOfDay) {
        const last = stops[stops.length - 1];
        emitStationEvent(last[1], last[2], 5, "arrive");
      }
    }
    if (minuteOfDay < t0 || minuteOfDay > t1) continue;
    const span = t1 - t0;
    const f = clamp((minuteOfDay - t0) / span, 0, 1);

    // Find segment along station sequence
    let s = 0;
    while (s < stops.length - 2 && stops[s + 1][0] < f) s++;
    const a = stops[s], b = stops[s + 1];
    const segF = b[0] > a[0] ? clamp((f - a[0]) / (b[0] - a[0]), 0, 1) : 0;
    const hx = lerp(a[1], b[1], segF);
    const hy = lerp(a[2], b[2], segF);
    const ang = Math.atan2(b[2] - a[2], b[1] - a[1]);

    // 4-minute trailing rail wake
    const fTail = clamp((minuteOfDay - 4.0 - t0) / span, 0, f);
    let ts = 0;
    while (ts < stops.length - 2 && stops[ts + 1][0] < fTail) ts++;
    const ta = stops[ts], tb = stops[ts + 1];
    const tSegF = tb[0] > ta[0] ? clamp((fTail - ta[0]) / (tb[0] - ta[0]), 0, 1) : 0;
    const tCoords = [lerp(ta[1], tb[1], tSegF), lerp(ta[2], tb[2], tSegF)];
    for (let k = ts + 1; k <= s; k++) tCoords.push(stops[k][1], stops[k][2]);
    tCoords.push(hx, hy);

    activeTrams.push([hx, hy, ang, pat.line, trimPolylineFromHead(tCoords, 70 * camMarkerScale())]);
  }

  if (!activeTrams.length) return 0;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const ms = camMarkerScale();
  // 1) Crisp subtle rail track guide while trams are operating
  ctx.globalCompositeOperation = isNight ? "lighter" : "source-over";
  ctx.beginPath();
  for (let p = 0; p < lightRailData.patterns.length; p++) {
    traceSmoothPolyline(lightRailData.patterns[p].flatCoords, 10000);
  }
  ctx.strokeStyle = rgbStr(col, isNight ? 0.14 : 0.16);
  ctx.lineWidth = 2.0 * ms;
  ctx.stroke();

  // 2) Smooth rail wakes
  ctx.beginPath();
  for (let i = 0; i < activeTrams.length; i++) {
    traceSmoothPolyline(activeTrams[i][4], 10000);
  }
  ctx.strokeStyle = rgbStr(col, isNight ? 0.65 : 0.58);
  ctx.lineWidth = 2.8 * ms;
  ctx.stroke();

  // 3) Glowing tram halos + sleek elongated rail-car pills
  const rTramHalo = 7.5 * ms;
  ctx.beginPath();
  for (let i = 0; i < activeTrams.length; i++) {
    const [hx, hy] = activeTrams[i];
    ctx.moveTo(hx + rTramHalo, hy);
    ctx.arc(hx, hy, rTramHalo, 0, Math.PI * 2);
  }
  ctx.fillStyle = rgbStr(col, isNight ? 0.36 : 0.28);
  ctx.fill();

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = rgbStr(col, 0.98);
  for (let i = 0; i < activeTrams.length; i++) {
    const [hx, hy, ang] = activeTrams[i];
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(ang);
    ctx.scale(ms, ms);
    ctx.beginPath();
    // Sleek pointed-nose rail car showing travel direction
    ctx.moveTo(8.0, 0);
    ctx.lineTo(3.2, -2.8);
    ctx.lineTo(-6.2, -2.6);
    ctx.lineTo(-5.0, 0);
    ctx.lineTo(-6.2, 2.6);
    ctx.lineTo(3.2, 2.8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 4) Crisp L1 / L3 badges
  const occupied = new Set();
  const cW = 34 * ms, cH = 16 * ms;
  for (let i = 0; i < activeTrams.length; i++) {
    const [hx, hy, , ln] = activeTrams[i];
    const key = (((hx / cW) | 0) << 12) ^ ((hy / cH) | 0);
    if (occupied.has(key)) continue;
    occupied.add(key);
    const spr = getLabelSprite(ln, 5, isNight);
    ctx.drawImage(spr, hx + 7 * ms, hy - 8 * ms, spr.width * ms, spr.height * ms);
  }

  ctx.restore();
  return activeTrams.length;
}

function loadRealDay(dayIdx) {
  if (realDays[dayIdx]) return Promise.resolve(realDays[dayIdx]);
  if (realDayPromises[dayIdx]) return realDayPromises[dayIdx];
  realDayPromises[dayIdx] = (async () => {
    try {
      const r = await fetch(`data/real-day${dayIdx}.bin?v=34`);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      const dv = new DataView(buf);
      const bytes = new Uint8Array(buf);
      if (bytes[0] !== 83 || bytes[1] !== 66 || bytes[2] !== 74 || bytes[3] !== 49) {
        throw new Error("Bad SBJ1 magic");
      }
      let off = 4;
      off += 1;
      const lineCount = dv.getUint16(off, true); off += 2;
      const dec = new TextDecoder();
      const lineTable = new Array(lineCount);
      for (let i = 0; i < lineCount; i++) {
        const len = dv.getUint8(off); off += 1;
        lineTable[i] = dec.decode(bytes.subarray(off, off + len));
        off += len;
      }
      const rideCount = dv.getUint32(off, true); off += 4;
      const rides = new Array(rideCount);
      const buckets = Array.from({ length: 144 }, () => []);

      for (let i = 0; i < rideCount; i++) {
        const lineIdx = dv.getUint16(off, true); off += 2;
        const opRef = dv.getUint8(off); off += 1;
        const ptCount = dv.getUint16(off, true); off += 2;
        const pts = new Float32Array(ptCount * 3);
        for (let k = 0; k < ptCount; k++) {
          const t2 = dv.getUint16(off, true); off += 2;
          const nx = dv.getUint16(off, true); off += 2;
          const ny = dv.getUint16(off, true); off += 2;
          pts[k * 3] = (t2 * 2) / 60;
          pts[k * 3 + 1] = toScreenX(nx);
          pts[k * 3 + 2] = toScreenY(ny);
        }
        const t0 = pts[0];
        const t1 = pts[(ptCount - 1) * 3];
        const line = lineIdx < lineCount ? lineTable[lineIdx] : "";
        const colorIdx = operatorGroupFromRef(opRef);
        rides[i] = { t0, t1, line, opRef, colorIdx, pts };

        const b0 = Math.max(0, Math.min(143, Math.floor(t0 / 10)));
        const b1 = Math.max(0, Math.min(143, Math.floor(t1 / 10)));
        for (let b = b0; b <= b1; b++) buckets[b].push(i);
      }

      realDays[dayIdx] = { rides, buckets };
      return realDays[dayIdx];
    } catch (err) {
      console.warn(`Real day ${dayIdx} load failed:`, err);
      realDayPromises[dayIdx] = null;
      return null;
    }
  })();
  return realDayPromises[dayIdx];
}

async function loadAllRealDays() {
  // Prioritize currently viewed day first, then Sun/Sat, then the rest
  const order = [0, 6, 1, 2, 3, 4, 5];
  for (const d of order) {
    await loadRealDay(d);
  }
}

function drawRealAllBuses(dayIdx, minuteOfDay, solar) {
  const dayData = realDays[dayIdx];
  if (!dayData || dayData === "loading") {
    if (!dayData) loadRealDay(dayIdx);
    return { activeCount: null, loading: true };
  }

  const { daylight } = solar;
  const isNight = daylight < 0.55;
  const cols = isNight ? OPERATOR_COLORS_NIGHT : OPERATOR_COLORS_DAY;

  const steppedForward = (dayIdx === lastRealDayIdx) && (minuteOfDay > lastRealMin) && ((minuteOfDay - lastRealMin) < 40);
  const prevMin = lastRealMin;
  lastRealDayIdx = dayIdx;
  lastRealMin = minuteOfDay;

  const bucketIdx = Math.max(0, Math.min(143, Math.floor(minuteOfDay / 10)));
  const candidates = dayData.buckets[bucketIdx];

  // Batch all active real buses into 6 operator color groups for 60 FPS!
  const trailPaths = [[], [], [], [], [], []]; // array of flat [x0,y0, x1,y1, ...] smooth polylines per operator
  const heads = [[], [], [], [], [], []];      // [hx, hy, line] per operator
  const ms = camMarkerScale();
  let activeCount = 0;

  for (let c = 0; c < candidates.length; c++) {
    const tr = dayData.rides[candidates[c]];
    if (steppedForward && tr.pts.length >= 15 && (tr.t1 - tr.t0) >= 5) {
      if (tr.t0 > prevMin && tr.t0 <= minuteOfDay) {
        if (!isHighwayBorderCrossing(tr.pts[1], tr.pts[2], tr.pts[4], tr.pts[5], tr.pts[3] - tr.pts[0])) {
          emitStationEvent(tr.pts[1], tr.pts[2], tr.colorIdx, "depart");
        }
      }
      if (tr.t1 > prevMin && tr.t1 <= minuteOfDay) {
        const n = tr.pts.length;
        if (!isHighwayBorderCrossing(tr.pts[n - 2], tr.pts[n - 1], tr.pts[n - 5], tr.pts[n - 4], tr.pts[n - 3] - tr.pts[n - 6])) {
          emitStationEvent(tr.pts[n - 2], tr.pts[n - 1], tr.colorIdx, "arrive");
        }
      }
    }
    if (minuteOfDay < tr.t0 || minuteOfDay > tr.t1) continue;
    const pos = interpolateTrip(tr.pts, minuteOfDay);
    if (!pos) continue;
    const [hx, hy, i0, ux, uy] = pos;
    activeCount++;
    heads[tr.colorIdx].push(hx, hy, ux, uy, tr.line);

    // Smooth 4.5-minute real GPS wake with interpolated sliding tail (zero jagged polygons!)
    const trailStartM = Math.max(tr.t0, minuteOfDay - 4.5);
    const tCoords = [];
    let prevT = -1e9;
    const tailPos = interpolateTrip(tr.pts, trailStartM);
    if (tailPos) {
      tCoords.push(tailPos[0], tailPos[1]);
      prevT = trailStartM;
    }
    for (let k = Math.max(0, i0 - 18); k <= i0; k += 3) {
      const ptT = tr.pts[k];
      if (ptT <= trailStartM) continue;
      const px = tr.pts[k + 1], py = tr.pts[k + 2];
      if (tCoords.length >= 2) {
        const lx = tCoords[tCoords.length - 2], ly = tCoords[tCoords.length - 1];
        const dSq = (px - lx) * (px - lx) + (py - ly) * (py - ly);
        if (ptT - prevT > 5.5 || dSq > 120000) {
          tCoords.length = 0;
          tCoords.push(px, py);
          prevT = ptT;
          continue;
        }
        if (dSq < 4) continue;
      }
      tCoords.push(px, py);
      prevT = ptT;
    }
    if (tCoords.length >= 2) {
      const lx = tCoords[tCoords.length - 2], ly = tCoords[tCoords.length - 1];
      if ((hx - lx) * (hx - lx) + (hy - ly) * (hy - ly) <= 120000) {
        tCoords.push(hx, hy);
      }
    }
    // Adaptive trail length: shrinks to a short 16px slipstream on fast highway spans (no off-road chords!)
    // Also scaled by camMarkerScale() so tails stay proportional to arrowheads when zoomed in.
    const segDist = (i0 + 3 < tr.pts.length)
      ? Math.hypot(tr.pts[i0 + 4] - tr.pts[i0 + 1], tr.pts[i0 + 5] - tr.pts[i0 + 2])
      : 0;
    const maxTrailPx = (segDist > 30 ? clamp(44 - (segDist - 30) * 0.55, 14, 44) : 44) * ms;
    if (tCoords.length >= 4) trailPaths[tr.colorIdx].push(trimPolylineFromHead(tCoords, maxTrailPx));
  }

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // 1) Batched silky-smooth quadratic GPS trails (6 strokes total!)
  ctx.globalCompositeOperation = isNight ? "lighter" : "source-over";
  ctx.lineWidth = (isNight ? 2.1 : 1.9) * ms;
  for (let g = 0; g < 6; g++) {
    const paths = trailPaths[g];
    if (!paths.length) continue;
    ctx.beginPath();
    for (let i = 0; i < paths.length; i++) {
      traceSmoothPolyline(paths[i], 120000);
    }
    ctx.strokeStyle = rgbStr(cols[g], isNight ? 0.42 : 0.36);
    ctx.stroke();
  }

  // 2) Batched halos (6 fills total!)
  const rHalo = (isNight ? 5.6 : 4.8) * ms;
  for (let g = 0; g < 6; g++) {
    const h = heads[g];
    if (!h.length) continue;
    ctx.beginPath();
    for (let i = 0; i < h.length; i += 5) {
      ctx.moveTo(h[i] + rHalo, h[i + 1]);
      ctx.arc(h[i], h[i + 1], rHalo, 0, Math.PI * 2);
    }
    ctx.fillStyle = rgbStr(cols[g], isNight ? 0.32 : 0.24);
    ctx.fill();
  }

  // 3) Batched directional arrowheads (6 fills total — zero save/rotate overhead!)
  ctx.globalCompositeOperation = "source-over";
  const tip = (isNight ? 5.8 : 5.5) * ms;
  const back = (isNight ? 3.6 : 3.4) * ms;
  const wing = (isNight ? 3.2 : 3.0) * ms;
  const notch = 1.6 * ms;
  for (let g = 0; g < 6; g++) {
    const h = heads[g];
    if (!h.length) continue;
    ctx.beginPath();
    for (let i = 0; i < h.length; i += 5) {
      traceArrowHead(h[i], h[i + 1], h[i + 2], h[i + 3], tip, back, wing, notch);
    }
    ctx.fillStyle = rgbStr(cols[g], 0.98);
    ctx.fill();
  }

  // 4) Real GTFS route number labels (tight per-label AABB collision + 4-way fallback placement)
  const invZ = 1 / cam.zoom;
  const vx0 = -cam.x * invZ - 48 * ms;
  const vy0 = -cam.y * invZ - 24 * ms;
  const vx1 = (W - cam.x) * invZ + 48 * ms;
  const vy1 = (H - cam.y) * invZ + 24 * ms;
  const binW = 28 * ms, binH = 14 * ms;
  const labelBins = new Map();
  const placed = []; // flat [x1, y1, x2, y2, ...]
  const lh = 10.5 * ms;
  const padX = 1.0 * ms, padY = 0.5 * ms;

  function canPlaceLabel(x1, y1, x2, y2) {
    const bx0 = Math.floor(x1 / binW), bx1 = Math.floor(x2 / binW);
    const by0 = Math.floor(y1 / binH), by1 = Math.floor(y2 / binH);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const list = labelBins.get((bx << 12) ^ by);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const p = list[k];
          if (x1 < placed[p + 2] && x2 > placed[p] && y1 < placed[p + 3] && y2 > placed[p + 1]) {
            return false;
          }
        }
      }
    }
    return true;
  }

  function recordLabel(x1, y1, x2, y2) {
    const idx = placed.length;
    placed.push(x1, y1, x2, y2);
    const bx0 = Math.floor(x1 / binW), bx1 = Math.floor(x2 / binW);
    const by0 = Math.floor(y1 / binH), by1 = Math.floor(y2 / binH);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const key = (bx << 12) ^ by;
        let list = labelBins.get(key);
        if (!list) { list = []; labelBins.set(key, list); }
        list.push(idx);
      }
    }
  }

  for (let g = 0; g < 6; g++) {
    const h = heads[g];
    for (let i = 0; i < h.length; i += 5) {
      const ln = h[i + 4];
      if (!ln || ln === "NaN" || ln === "nan" || ln === "None") continue;
      const hx = h[i], hy = h[i + 1];
      if (hx < vx0 || hx > vx1 || hy < vy0 || hy > vy1) continue;
      const spr = getLabelSprite(ln, g, isNight);
      const lw = (spr._tw || 20) * ms;
      // Try right, left, above, below around the bus arrowhead
      let lx = hx + 5 * ms, ly = hy - 8 * ms;
      let ok = canPlaceLabel(lx - padX, ly + 2.5 * ms - padY, lx + lw + padX, ly + 2.5 * ms + lh + padY);
      if (!ok) {
        lx = hx - 5 * ms - lw; ly = hy - 8 * ms;
        ok = canPlaceLabel(lx - padX, ly + 2.5 * ms - padY, lx + lw + padX, ly + 2.5 * ms + lh + padY);
      }
      if (!ok) {
        lx = hx - lw * 0.5; ly = hy - 15 * ms;
        ok = canPlaceLabel(lx - padX, ly + 2.5 * ms - padY, lx + lw + padX, ly + 2.5 * ms + lh + padY);
      }
      if (!ok) {
        lx = hx - lw * 0.5; ly = hy + 1.5 * ms;
        ok = canPlaceLabel(lx - padX, ly + 2.5 * ms - padY, lx + lw + padX, ly + 2.5 * ms + lh + padY);
      }
      if (!ok) continue;
      recordLabel(lx - padX, ly + 2.5 * ms - padY, lx + lw + padX, ly + 2.5 * ms + lh + padY);
      ctx.drawImage(spr, lx, ly, spr.width * ms, spr.height * ms);
    }
  }

  ctx.restore();
  return { activeCount, loading: false };
}

// ============================================================================
// Main Animation Loop + Soundtrack Clock Sync
// ============================================================================
function renderFrame(p, dt) {
  const lineMode = selectedLineKeys.size > 0;
  let state, solar, intensity;

  if (lineMode) {
    // Respect #rangeSelect (Full Week Sun-Sat OR any single day 0..6)!
    const startMin = viewStart * 20;
    const spanMin = viewCount * 20;
    const weekMin = startMin + clamp(p, 0, 0.99999) * spanMin;
    const dayIdx = Math.min(6, Math.floor(weekMin / 1440));
    const minuteOfDay = weekMin % 1440;
    solar = getSolarState(minuteOfDay);
    updateStationEvents(dt);

    drawAtmosphere(solar);
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.zoom, cam.zoom);
    drawRoadBase(solar);
    drawStationEvents(solar);
    const res = drawSelectedLinesMode(weekMin, solar);
    drawLandmarks(solar);
    ctx.restore();
    drawVignette(solar);

    state = {
      dayIdx,
      minuteOfDay,
      buses: res.activeCount,
      lineCurve: res.curve,
      lineMaxB: res.maxB,
    };
    intensity = clamp(res.activeCount / Math.max(8, res.maxB), 0, 1);
    drawHUD(state, solar);
  } else {
    state = sampleState(p);
    solar = getSolarState(state.minuteOfDay);
    intensity = clamp(state.buses / 850, 0, 1);

    updateRoadActivity(state.s0, state.s1, state.frac, dt);
    updateStationEvents(dt);

    drawAtmosphere(solar);
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.zoom, cam.zoom);
    drawRoadBase(solar);
    drawWarmStreetGlow(solar);
    drawStationEvents(solar);
    const realRes = drawRealAllBuses(state.dayIdx, state.minuteOfDay, solar);
    const railCount = drawLightRail(state.dayIdx, state.minuteOfDay, solar);
    if (realRes.activeCount !== null) {
      state.buses = realRes.activeCount + railCount;
      intensity = clamp(state.buses / 850, 0, 1);
    }
    drawLandmarks(solar);
    ctx.restore();
    drawVignette(solar);
    drawHUD(state, solar);
  }

  highlightActiveDayMarker(state.dayIdx);

  const isShabbat = (state.dayIdx === 5 && state.minuteOfDay >= 960) || (state.dayIdx === 6 && state.minuteOfDay < 1065);
  const totalDur = effectiveDurationSec();

  if (playing) {
    audio.updateAtmosphere(solar.daylight, intensity, true, state.minuteOfDay, isShabbat);

    // Musical clockwork pulse synced to real elapsed seconds (consistent tempo in 24h & 7-day modes!)
    const totalTicks = Math.floor(p * totalDur * 3.2);
    if (totalTicks !== lastTickIndex) {
      lastTickIndex = totalTicks;
      const isMain = (totalTicks % 2 === 0);
      if (isMain || intensity > 0.45) {
        audio.tick(intensity, !isMain);
      }
    }

    const absHour = state.dayIdx * 24 + Math.floor(state.minuteOfDay / 60);
    if (absHour !== lastHourMark) {
      lastHourMark = absHour;
      const h = Math.floor(state.minuteOfDay / 60);
      if (state.dayIdx === 5 && h === 16) audio.chime("shabbat");
      else if (h === 0 || h === 6 || h === 12 || h === 17) audio.chime("major");
      else if (viewCount <= 72 && h % 3 === 0) audio.chime("hour");
    }
  } else {
    audio.updateAtmosphere(solar.daylight, intensity, false, state.minuteOfDay, isShabbat);
  }
}

function loop(ts) {
  if (!lastFrameTs) lastFrameTs = ts;
  const dt = Math.min(0.08, (ts - lastFrameTs) / 1000);
  lastFrameTs = ts;

  if (playing) {
    progress += dt / effectiveDurationSec();
    if (progress >= 1) {
      if (isRecording) {
        progress = 1;
        renderFrame(progress, dt);
        stopRecording();
        playing = false;
        $("playBtn").textContent = "▶";
        requestAnimationFrame(loop);
        return;
      }
      progress = 0;
      lastTickIndex = -1;
      lastHourMark = -1;
    }
    $("scrubber").value = Math.round(progress * 1000);
  }

  if (isRecording) {
    const sec = Math.floor((Date.now() - recStartMs) / 1000);
    $("recText").textContent = `REC ${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  }

  renderFrame(progress, dt);
  requestAnimationFrame(loop);
}

// ============================================================================
// Video Recording (1080p Canvas + Synced Web Audio Soundtrack -> WebM)
// ============================================================================
function startRecording() {
  audio.init();
  const videoStream = canvas.captureStream(60);
  const tracks = [...videoStream.getVideoTracks()];
  if (audio.streamDest) {
    tracks.push(...audio.streamDest.stream.getAudioTracks());
  }
  const combined = new MediaStream(tracks);
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || "";

  recChunks = [];
  recorder = new MediaRecorder(combined, mime ? { mimeType: mime, videoBitsPerSecond: 12_000_000 } : undefined);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: mime || "video/webm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const rangeTag = $("rangeSelect").value === "week" ? "7days" : DATA.meta.days[+$("rangeSelect").value].toLowerCase();
    a.href = url;
    a.download = `slowbus-jlm-${rangeTag}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  progress = 0;
  lastTickIndex = -1;
  lastHourMark = -1;
  resetSimulation();
  isRecording = true;
  recStartMs = Date.now();
  playing = true;
  $("playBtn").textContent = "⏸";
  $("recordBtn").classList.add("recording");
  $("recordBtn").textContent = "■ Stop Rec";
  $("recBadge").hidden = false;
  $("controls").classList.add("idle");
  recorder.start(250);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  if (recorder && recorder.state !== "inactive") recorder.stop();
  $("recordBtn").classList.remove("recording");
  $("recordBtn").textContent = "● Record Video";
  $("recBadge").hidden = true;
  $("controls").classList.remove("idle");
}

// ============================================================================
// UI Controls & Initialization
// ============================================================================
let idleTimer = null;
let controlsHidden = false;

function setControlsHidden(hidden) {
  controlsHidden = !!hidden;
  $("controls").classList.toggle("force-hidden", controlsHidden);
  $("creditCorner").classList.toggle("hidden-ui", controlsHidden);
  $("zoomControls").classList.toggle("hidden-ui", controlsHidden);
  $("showControlsBtn").hidden = !controlsHidden;
  if (controlsHidden) {
    $("lpPanel").hidden = true;
    clearTimeout(idleTimer);
  } else {
    wakeControls();
  }
}

function wakeControls() {
  if (isRecording || controlsHidden) return;
  $("controls").classList.remove("idle");
  clearTimeout(idleTimer);
  if (playing) {
    idleTimer = setTimeout(() => {
      if ($("lpPanel").hidden && !controlsHidden) $("controls").classList.add("idle");
    }, 2800);
  }
}

document.addEventListener("mousemove", wakeControls);
document.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.key.toLowerCase() === "m") { toggleMute(); }
  else if (e.key.toLowerCase() === "f") { toggleFullscreen(); }
  else if (e.key.toLowerCase() === "h") { setControlsHidden(!controlsHidden); }
  else if (e.key === "+" || e.key === "=") { zoomAtCanvasPoint(1.35, W * 0.5, H * 0.5); }
  else if (e.key === "-") { zoomAtCanvasPoint(1 / 1.35, W * 0.5, H * 0.5); }
  else if (e.key === "0") { resetCamera(); }
});

function togglePlay() {
  if (!DATA) return;
  audio.init();
  playing = !playing;
  $("playBtn").textContent = playing ? "⏸" : "▶";
  wakeControls();
}

function toggleMute() {
  audio.init();
  audio.setMuted(!audio.muted);
  $("muteBtn").textContent = audio.muted ? "🔇" : "🔊";
}

function toggleFullscreen() {
  if (!document.fullscreenElement) $("stage").requestFullscreen?.();
  else document.exitFullscreen?.();
}

$("startBtn").addEventListener("click", () => {
  $("splash").classList.add("hidden");
  audio.init();
  playing = true;
  $("playBtn").textContent = "⏸";
  wakeControls();
});

$("playBtn").addEventListener("click", togglePlay);
$("muteBtn").addEventListener("click", toggleMute);
$("fsBtn").addEventListener("click", toggleFullscreen);
$("hideBtn").addEventListener("click", () => setControlsHidden(true));
$("showControlsBtn").addEventListener("click", () => setControlsHidden(false));
$("zoomInBtn").addEventListener("click", () => zoomAtCanvasPoint(1.4, W * 0.5, H * 0.5));
$("zoomOutBtn").addEventListener("click", () => zoomAtCanvasPoint(1 / 1.4, W * 0.5, H * 0.5));
$("zoomResetBtn").addEventListener("click", resetCamera);

// Mouse wheel / trackpad pinch zoom toward cursor
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [cx, cy] = clientToCanvasXY(e.clientX, e.clientY);
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
  zoomAtCanvasPoint(factor, cx, cy);
}, { passive: false });

// Double-click canvas to reset zoom (or zoom in 2.2x if at 1x)
canvas.addEventListener("dblclick", (e) => {
  const [cx, cy] = clientToCanvasXY(e.clientX, e.clientY);
  if (cam.zoom > 1.05) resetCamera();
  else zoomAtCanvasPoint(2.4, cx, cy);
});

// Pointer drag-to-pan + two-finger touch pinch-zoom
const activePointers = new Map();
let dragLast = null;
let pinchLastDist = 0;

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 && e.pointerType === "mouse") return;
  activePointers.set(e.pointerId, [e.clientX, e.clientY]);
  canvas.setPointerCapture?.(e.pointerId);
  if (activePointers.size === 1) {
    dragLast = clientToCanvasXY(e.clientX, e.clientY);
    if (cam.zoom > 1.02) canvas.classList.add("panning");
  } else if (activePointers.size === 2) {
    dragLast = null;
    const pts = Array.from(activePointers.values());
    pinchLastDist = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (activePointers.size === 2) {
    const pts = Array.from(activePointers.values());
    const dist = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    if (pinchLastDist > 10 && dist > 10) {
      const [mx, my] = clientToCanvasXY((pts[0][0] + pts[1][0]) * 0.5, (pts[0][1] + pts[1][1]) * 0.5);
      zoomAtCanvasPoint(dist / pinchLastDist, mx, my);
    }
    pinchLastDist = dist;
  } else if (dragLast && cam.zoom > 1.02) {
    const cur = clientToCanvasXY(e.clientX, e.clientY);
    cam.x += cur[0] - dragLast[0];
    cam.y += cur[1] - dragLast[1];
    dragLast = cur;
    clampCamera();
    if (!playing && DATA) renderFrame(progress, 0.016);
  }
});

function endPointer(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinchLastDist = 0;
  if (activePointers.size === 0) {
    dragLast = null;
    canvas.classList.remove("panning");
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
$("volSlider").addEventListener("input", (e) => audio.setVolume(+e.target.value));
$("rangeSelect").addEventListener("change", (e) => setRange(e.target.value));
$("speedToggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-sec]");
  if (!btn) return;
  dayDurationSec = +btn.dataset.sec;
  lastTickIndex = -1;
  $("speedToggle").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
});
$("scrubber").addEventListener("input", (e) => {
  progress = +e.target.value / 1000;
  lastTickIndex = -1;
  lastHourMark = -1;
  renderFrame(progress, 0.016);
});
$("recordBtn").addEventListener("click", () => {
  if (isRecording) stopRecording();
  else startRecording();
});
$("recBadge").addEventListener("click", () => stopRecording());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isRecording) stopRecording();
});

// ============================================================================
// Bus Line Multiselector Widget
// ============================================================================
function updateLinePickerStatus() {
  const el = $("lpStatus");
  if (!el) return;
  if (loadingLineKeys.size > 0) {
    const nums = [...loadingLineKeys].map((k) => k.split(":")[0]).join(", ");
    el.textContent = `Loading real GPS tracks for line ${nums}…`;
  } else if (selectedLineKeys.size > 0) {
    let trips = 0;
    for (const k of selectedLineKeys) trips += (lineTripsCache.get(k)?.trips.length || 0);
    const rv = $("rangeSelect").value;
    const tag = rv === "week" ? "7 days" : DATA?.meta.days[+rv] || "24h";
    el.textContent = `Showing ${selectedLineKeys.size} line${selectedLineKeys.size > 1 ? "s" : ""} · ${trips} real trips (${tag})`;
  } else {
    el.textContent = "All Lines mode (real 1-min GPS + Light Rail L1/L3)";
  }
}

function updateLinePickerSummary() {
  const sum = $("lpSummary");
  const allBtn = $("lpAllCityBtn");
  if (selectedLineKeys.size === 0) {
    sum.textContent = "All Lines";
    allBtn.classList.add("active");
  } else {
    const nums = [...selectedLineKeys].map((k) => k.split(":")[0]);
    const label = nums.length <= 3 ? `Line${nums.length > 1 ? "s" : ""} ${nums.join(", ")}` : `${nums.length} Lines`;
    sum.textContent = loadingLineKeys.size > 0 ? `${label} (loading…)` : label;
    allBtn.classList.remove("active");
  }
  $("rangeSelect").disabled = false;
  buildDayMarkers();
  updateLinePickerStatus();
}

function toggleLineKey(meta) {
  const key = `${meta.line}:${meta.opRef}`;
  if (selectedLineKeys.has(key)) {
    selectedLineKeys.delete(key);
  } else {
    selectedLineKeys.add(key);
    ensureLineLoaded(meta);
  }
  stationEvents.length = 0;
  lastLineMinute = -1;
  stationEvents.length = 0;
  updateLinePickerSummary();
  renderLinePicker();
  renderFrame(progress, 0.016);
}

function renderLinePicker() {
  const chipsEl = $("lpChips");
  const listEl = $("lpList");
  const q = ($("lpSearch").value || "").trim().toLowerCase();

  // Selected chips (DOM APIs, no innerHTML interpolation of external strings)
  chipsEl.textContent = "";
  for (const key of selectedLineKeys) {
    const [num, opStr] = key.split(":");
    const opIdx = operatorGroupFromRef(+opStr);
    const col = rgbStr(OPERATOR_COLORS_NIGHT[opIdx]);
    const chip = document.createElement("span");
    chip.className = "lp-chip";
    const sw = document.createElement("span");
    sw.className = "lp-swatch";
    sw.style.background = col;
    const txt = document.createTextNode(num);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", `Remove line ${num}`);
    btn.textContent = "×";
    btn.addEventListener("click", () => {
      selectedLineKeys.delete(key);
      lastLineMinute = -1;
      stationEvents.length = 0;
      updateLinePickerSummary();
      renderLinePicker();
      renderFrame(progress, 0.016);
    });
    chip.append(sw, txt, btn);
    chipsEl.appendChild(chip);
  }

  // Filter catalog (show selected first, then matches, capped at 90 rows for crisp DOM speed)
  const filtered = [];
  for (let i = 0; i < LINE_CATALOG.length; i++) {
    const m = LINE_CATALOG[i];
    if (q && !m.line.toLowerCase().includes(q) && !m.agency.toLowerCase().includes(q) && !m.desc.toLowerCase().includes(q)) continue;
    filtered.push(m);
  }
  filtered.sort((a, b) => {
    const sa = selectedLineKeys.has(`${a.line}:${a.opRef}`) ? 0 : 1;
    const sb = selectedLineKeys.has(`${b.line}:${b.opRef}`) ? 0 : 1;
    return sa - sb;
  });

  listEl.textContent = "";
  for (let i = 0; i < filtered.length; i++) {
    const m = filtered[i];
    const key = `${m.line}:${m.opRef}`;
    const isSel = selectedLineKeys.has(key);
    const col = rgbStr(OPERATOR_COLORS_NIGHT[operatorGroupFromRef(m.opRef)]);
    const row = document.createElement("label");
    row.className = "lp-item" + (isSel ? " selected" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isSel;
    cb.addEventListener("change", () => toggleLineKey(m));
    const sw = document.createElement("span");
    sw.className = "lp-swatch";
    sw.style.background = col;
    const numEl = document.createElement("span");
    numEl.className = "lp-num";
    numEl.textContent = m.line;
    const agEl = document.createElement("span");
    agEl.className = "lp-agency";
    agEl.textContent = m.agency;
    row.append(cb, sw, numEl, agEl);
    listEl.appendChild(row);
  }
}

function setLinePickerOpen(open) {
  $("lpPanel").hidden = !open;
  const caret = $("linePickerToggle").querySelector(".lp-caret");
  if (caret) caret.textContent = open ? "▴" : "▾";
  if (open) $("lpSearch").focus();
}

function initLinePicker() {
  $("linePickerToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    setLinePickerOpen($("lpPanel").hidden);
  });
  $("lpCloseBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    setLinePickerOpen(false);
  });
  // Click anywhere outside the widget closes it cleanly
  document.addEventListener("click", (e) => {
    if (!$("lpPanel").hidden && !$("linePicker").contains(e.target)) {
      setLinePickerOpen(false);
    }
  });
  // Escape key closes the widget cleanly
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("lpPanel").hidden) {
      setLinePickerOpen(false);
    }
  });
  $("lpSearch").addEventListener("input", renderLinePicker);
  $("lpAllCityBtn").addEventListener("click", () => {
    selectedLineKeys.clear();
    lastLineMinute = -1;
    stationEvents.length = 0;
    updateLinePickerSummary();
    renderLinePicker();
    renderFrame(progress, 0.016);
  });
  updateLinePickerSummary();
  renderLinePicker();
}

async function boot() {
  try {
    const [r, catRes] = await Promise.all([
      fetch("data/jlm-timelapse.json?v=29"),
      fetch("data/jlm-lines.json?v=34"),
    ]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    DATA = await r.json();
    slices = DATA.slices;
    if (catRes.ok) LINE_CATALOG = await catRes.json();

    computeMapProjection();
    const raw = DATA.roads;
    roads = new Array(raw.length / 5);
    for (let i = 0, j = 0; i < raw.length; i += 5, j++) {
      const x1 = toScreenX(raw[i + 1]), y1 = toScreenY(raw[i + 2]);
      const x2 = toScreenX(raw[i + 3]), y2 = toScreenY(raw[i + 4]);
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      roads[j] = { tier: raw[i], x1, y1, x2, y2, len, dx: (x2 - x1) / len, dy: (y2 - y1) / len };
    }

    buildRoadGraph();
    prerenderRoadBases();

    setRange("week");
    initLinePicker();
    loadLightRail();   // Official GTFS 7-day Light Rail L1 & L3
    loadAllRealDays(); // Stream 100% real GPS trajectories (real-day0..6.bin)
    // Warm preview frame behind splash (Sunday evening rush)
    for (let k = 0; k < 20; k++) renderFrame(0.098, 0.04);

    $("startBtn").disabled = false;
    $("startLabel").textContent = "Begin 7-Day Timelapse (with Sound)";
    requestAnimationFrame(loop);
  } catch (err) {
    $("startLabel").textContent = `Dataset error: ${err.message}`;
  }
}

boot();
