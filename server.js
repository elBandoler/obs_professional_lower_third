'use strict';

/*
 * OBS Lower Thirds — local server
 * ------------------------------------------------------------
 * Serves:
 *   /overlay   -> browser source page (role=program renders LIVE state,
 *                 role=preview renders PENDING state)
 *   /control   -> control panel (add as an OBS Custom Browser Dock)
 *   /ws        -> websocket hub keeping everything in sync
 *   /api/...   -> simple HTTP API for Stream Deck / hotkey tools
 *
 * State model:
 *   pending  = what you are editing (shows in preview)
 *   live     = what is on air (shows in program)
 *   TAKE (dock button) or an OBS studio-mode Transition (via obs-websocket)
 *   commits pending -> live, animated unless animations are disabled.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let WebSocketServer, WSClient;
try {
  const wsLib = require('ws');
  WebSocketServer = wsLib.WebSocketServer || wsLib.Server;
  WSClient = wsLib.WebSocket || wsLib;
} catch (e) {
  console.error('\n[lower-thirds] Missing dependency "ws".');
  console.error('[lower-thirds] Open a terminal in this folder and run:  npm install\n');
  process.exit(1);
}

/* ---------------------------------------------------------------- config */

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const PORT = parseInt(process.env.PORT || argVal('port', '3620'), 10);
const HOST = process.env.HOST || argVal('host', '127.0.0.1');
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(ROOT, argVal('data', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* When launched by the OBS script we get OBS's process id; if that process
   disappears (OBS closed or crashed), shut ourselves down. */
const WATCH_PID = parseInt(argVal('watch-pid', '0'), 10);
if (WATCH_PID > 0) {
  setInterval(() => {
    try {
      process.kill(WATCH_PID, 0); // existence check only
    } catch (e) {
      if (e.code === 'EPERM') return; // exists, just not ours
      console.log('[lower-thirds] Watched process ' + WATCH_PID + ' exited — shutting down.');
      persist(true);
      process.exit(0);
    }
  }, 5000).unref();
}

/* ---------------------------------------------------------------- state */

function clone(v) { return JSON.parse(JSON.stringify(v)); }

/* ------------------------------------------------- defaults & migration */

const SCHEMA = 2;   /* 1 = fixed topline/headline/badge/logo, 2 = dynamic elements */
const DEFAULTS_FILE = path.join(PUBLIC_DIR, 'defaults.json');

/* Last-resort defaults, used only if defaults.json is missing or corrupt so
   the product still starts. The real defaults live in public/defaults.json,
   which the native OBS plugin reads too. */
function minimalDefaults() {
  const elStyle = {
    bg: '#ffffff', bgOpacity: 1, color: '#12161c',
    size: 40, weight: 700, letterSpacing: 0, padX: 26, padY: 12, lineHeight: 1.2,
    align: 'auto', nowrap: false, minWidth: 0,
    gradient: {
      enabled: false, type: 'linear', angle: 180, shape: 'ellipse', posX: 50, posY: 50,
      stops: [{ color: '#ffffff', pos: 0, opacity: 1 }, { color: '#e9edf5', pos: 100, opacity: 1 }],
    },
    bgImage: { enabled: false, url: '', fit: 'cover' },
    edges: { mode: 'inherit', radius: 14, chamfer: 26 },
    accent: { mode: 'none', color: '#1c56d6', thickness: 6 },
  };
  const styleDefaults = {
    direction: 'auto', textAlign: 'start',
    layout: { anchor: 'left', fullWidth: true, maxWidth: 70, sideMargin: 0, bottomMargin: 64 },
    gap: 4,
    font: { family: "'Segoe UI', Arial, sans-serif", customCssUrl: '', uploads: [] },
    edges: { style: 'square', radius: 14, chamfer: 26 },
    shadow: 40,
  };
  return {
    schema: SCHEMA,
    elementDefaults: {
      text: {
        kind: 'text', name: 'Text', enabled: true,
        place: { row: 0, order: 0, stretch: false, rowSpan: 1 },
        text: 'New text', snippets: [], style: clone(elStyle),
      },
      image: {
        kind: 'image', name: 'Image', enabled: true,
        place: { row: 0, order: 0, stretch: false, rowSpan: 1 },
        image: { url: '', fit: 'contain', scale: 1 },
        style: deepMerge(clone(elStyle), { padX: 12, padY: 12, minWidth: 160, align: 'center' }),
      },
    },
    styleDefaults: styleDefaults,
    anim: {
      enabled: true, inStyle: 'slide-up', outStyle: 'auto', changeStyle: 'slide-swap',
      inMs: 700, outMs: 500, changeMs: 450, staggerMs: 90, easing: 'snappy', autoHideSec: 0,
    },
    look: {
      schema: SCHEMA,
      elements: [{
        id: 'el-headline', kind: 'text', name: 'Headline', enabled: true,
        place: { row: 0, order: 0, stretch: true, rowSpan: 1 },
        text: 'Lower third', snippets: [], style: clone(elStyle),
      }],
      style: clone(styleDefaults),
    },
    presets: [],
  };
}

let DEFAULTS = null;
function loadDefaults() {
  try {
    const d = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
    if (!d || !d.look || !d.elementDefaults || !d.styleDefaults || !d.anim) {
      throw new Error('incomplete defaults.json');
    }
    return d;
  } catch (e) {
    console.error('[lower-thirds] Could not read defaults.json (' + e.message +
      ') — falling back to a minimal built-in look.');
    return minimalDefaults();
  }
}

function defaultElement(kind) {
  return clone(DEFAULTS.elementDefaults[kind === 'image' ? 'image' : 'text']);
}
function defaultStyle() { return clone(DEFAULTS.styleDefaults); }
function defaultLook() { return migrateLook(clone(DEFAULTS.look)); }
function defaultAnim() { return clone(DEFAULTS.anim); }
function defaultPresets() {
  return (Array.isArray(DEFAULTS.presets) ? DEFAULTS.presets : []).map(migratePreset).filter(Boolean);
}

function defaultSettings() {
  return {
    obs: {
      enabled: false,
      host: '127.0.0.1',
      port: 4455,
      password: '',
      commitOnTransition: true,   // OBS "Transition" acts as TAKE
      onlyStudioMode: true,       // only react to transitions while Studio Mode is on
      transitionAction: 'take',   // take | take-show
    },
    server: { port: PORT },
  };
}

function newId(prefix) { return prefix + '-' + crypto.randomBytes(4).toString('hex'); }

/* fill in every missing field of one element and clamp its placement */
function normalizeElement(el) {
  if (!el || typeof el !== 'object') return null;
  const kind = el.kind === 'image' ? 'image' : 'text';
  const base = defaultElement(kind);
  const out = deepMerge(base, el);
  out.kind = kind;
  out.id = String(out.id || newId('el'));
  out.name = String(out.name || (kind === 'image' ? 'Image' : 'Text'));
  out.enabled = out.enabled !== false;

  const p = out.place && typeof out.place === 'object' ? out.place : {};
  /* Before columns became explicit, `order` WAS the column index. Records
     without a `col` therefore carry their column in `order`. */
  const hasCol = p.col !== undefined && p.col !== null;
  out.place = {
    row: Math.max(0, Math.min(19, parseInt(p.row, 10) || 0)),
    col: Math.max(0, Math.min(19, parseInt(hasCol ? p.col : p.order, 10) || 0)),
    order: hasCol ? Math.max(-999, Math.min(999, Number(p.order) || 0)) : 0,
    stretch: !!p.stretch,
    /* spanAll = fill the full height of the block (e.g. a logo standing next
       to every row). The actual row span is computed at render time so it
       keeps working when rows are added or removed. */
    spanAll: !!p.spanAll,
    rowSpan: Math.max(1, Math.min(20, parseInt(p.rowSpan, 10) || 1)),
    colSpan: Math.max(1, Math.min(20, parseInt(p.colSpan, 10) || 1)),
  };
  if (out.place.spanAll) { out.place.row = 0; out.place.rowSpan = 1; }

  if (kind === 'text') {
    out.text = typeof out.text === 'string' ? out.text : '';
    /* Saved texts are NOT part of the look: keeping them here would mark the
       state dirty on every save and let preset-load wipe the operator's bank.
       They live in state.snippets, keyed by element id. */
    delete out.snippets;
    delete out.image;
  } else {
    out.image = deepMerge(base.image, out.image || {});
    delete out.text;
    delete out.snippets;
  }

  const g = out.style && out.style.gradient;
  if (!g || !Array.isArray(g.stops) || g.stops.length < 2) {
    out.style.gradient = clone(base.style.gradient);
  } else {
    out.style.gradient.stops = g.stops.slice(0, 24).map(function (s) {
      return {
        color: typeof s.color === 'string' ? s.color : '#ffffff',
        pos: Math.max(0, Math.min(100, Number(s.pos) || 0)),
        opacity: Math.max(0, Math.min(1, s.opacity === undefined ? 1 : Number(s.opacity))),
      };
    });
  }
  return out;
}

/* Compact empty rows/columns away and renumber, then make the order inside
   each grid cell sequential. Elements sharing a (row,col) render as one
   horizontal line, so a new element never shifts another row's columns. */
function normalizePlacement(els) {
  function compact(key) {
    const used = Array.from(new Set(els.map(function (e) { return e.place[key]; })))
      .sort(function (a, b) { return a - b; });
    const map = {};
    used.forEach(function (v, i) { map[v] = i; });
    els.forEach(function (e) { e.place[key] = map[e.place[key]]; });
  }
  compact('row');
  compact('col');

  const byCell = {};
  els.forEach(function (e) {
    const k = e.place.row + ':' + e.place.col;
    (byCell[k] = byCell[k] || []).push(e);
  });
  Object.keys(byCell).forEach(function (k) {
    byCell[k].sort(function (a, b) { return a.place.order - b.place.order; });
    byCell[k].forEach(function (e, i) { e.place.order = i; });
  });
  return els;
}

/* schema 1 (fixed topline/headline/badge/logo) -> schema 2 (elements).
   Idempotent: a look that is already schema 2 is only normalized. */
function migrateLook(look) {
  if (!look || typeof look !== 'object') look = {};

  if (Array.isArray(look.elements)) {
    const els = normalizePlacement(look.elements.map(normalizeElement).filter(Boolean));
    return {
      schema: SCHEMA,
      elements: els.length ? els : clone(DEFAULTS.look.elements).map(normalizeElement),
      style: deepMerge(defaultStyle(), look.style || {}),
    };
  }

  const c = look.content || {};
  const st = look.style || {};
  const bars = st.bars || {};
  const lay = st.layout || {};
  const oldAccent = st.accent || { mode: 'none', color: '#1c56d6', thickness: 6 };
  const logoLeft = lay.logoSide === 'left';

  function styleFrom(kind, bar, extra) {
    const d = defaultElement(kind).style;
    bar = bar || {};
    const gradient = {
      enabled: !!(bar.gradient && bar.gradient.enabled),
      type: 'linear',
      angle: bar.gradient && typeof bar.gradient.angle === 'number' ? bar.gradient.angle : 180,
      shape: 'ellipse', posX: 50, posY: 50,
      stops: [
        { color: bar.bg || d.bg, pos: 0, opacity: 1 },
        { color: (bar.gradient && bar.gradient.color2) || '#e9edf5', pos: 100, opacity: 1 },
      ],
    };
    const bgImage = bar.image
      ? { enabled: !!bar.image.enabled, url: bar.image.url || '', fit: bar.image.fit || 'cover' }
      : clone(d.bgImage);
    const mapped = {};
    ['bg', 'bgOpacity', 'color', 'size', 'weight', 'letterSpacing', 'padX', 'padY'].forEach(function (k) {
      if (bar[k] !== undefined) mapped[k] = bar[k];
    });
    mapped.gradient = gradient;
    mapped.bgImage = bgImage;
    return deepMerge(deepMerge(d, mapped), extra || {});
  }

  const els = [];
  els.push(deepMerge(defaultElement('text'), {
    id: 'el-topline', name: 'Top line',
    enabled: !!(c.topline && c.topline.enabled !== false),
    place: { row: 0, col: logoLeft ? 1 : 0, order: 0, stretch: false, rowSpan: 1, colSpan: 1 },
    text: (c.topline && c.topline.text) || '',
    style: styleFrom('text', bars.topline, {}),
  }));
  els.push(deepMerge(defaultElement('text'), {
    id: 'el-badge', name: 'Badge',
    enabled: !!(c.badge && c.badge.enabled !== false),
    place: { row: 0, col: logoLeft ? 0 : 1, order: 0, stretch: false, rowSpan: 1, colSpan: 1 },
    text: (c.badge && c.badge.text) || '',
    style: styleFrom('text', bars.badge, { align: 'center', nowrap: true, padX: 21, padY: 6 }),
  }));
  els.push(deepMerge(defaultElement('text'), {
    id: 'el-headline', name: 'Headline',
    enabled: true,
    place: { row: 1, col: logoLeft ? 1 : 0, order: 0, stretch: lay.fullWidth !== false, rowSpan: 1, colSpan: 1 },
    text: (c.headline && c.headline.text) || '',
    style: styleFrom('text', bars.headline, { accent: clone(oldAccent) }),
  }));
  const lb = bars.logoBox || {};
  els.push(deepMerge(defaultElement('image'), {
    id: 'el-logo', name: 'Logo',
    enabled: !!(c.logo && c.logo.enabled !== false),
    place: { row: 1, col: logoLeft ? 0 : 1, order: 0, stretch: false, rowSpan: 1, colSpan: 1 },
    image: { url: (c.logo && c.logo.url) || '', fit: 'contain', scale: (c.logo && c.logo.scale) || 1 },
    style: styleFrom('image', { bg: lb.bg, bgOpacity: lb.bgOpacity, padX: lb.pad, padY: lb.pad },
      { minWidth: lb.minWidth !== undefined ? lb.minWidth : 180, align: 'center' }),
  }));

  const style = deepMerge(defaultStyle(), {
    direction: st.direction || 'auto',
    textAlign: st.textAlign || 'start',
    layout: {
      anchor: lay.anchor || 'left',
      fullWidth: lay.fullWidth !== false,
      maxWidth: lay.maxWidth !== undefined ? lay.maxWidth : 70,
      sideMargin: lay.sideMargin || 0,
      bottomMargin: lay.bottomMargin !== undefined ? lay.bottomMargin : 64,
    },
    gap: st.gap !== undefined ? st.gap : 4,
    font: st.font || {},
    edges: st.edges || {},
    shadow: st.shadow !== undefined ? st.shadow : 40,
  });

  return {
    schema: SCHEMA,
    elements: normalizePlacement(els.map(normalizeElement)),
    style: style,
  };
}

function migratePreset(p) {
  if (!p || typeof p !== 'object') return null;
  const look = migrateLook(Array.isArray(p.elements)
    ? { elements: p.elements, style: p.style }
    : { content: p.content, style: p.style });
  return {
    id: String(p.id || newId('p')),
    name: String(p.name || 'Preset').slice(0, 60),
    schema: SCHEMA,
    elements: look.elements,
    style: look.style,
    anim: deepMerge(defaultAnim(), p.anim || {}),
  };
}

/* deep-merge `over` onto `base` (objects merge, everything else replaces) */
function deepMerge(base, over) {
  if (over === undefined) return base;
  if (base === null || base === undefined) return clone(over);
  if (Array.isArray(base) || Array.isArray(over)) return clone(over);
  if (typeof base !== 'object' || typeof over !== 'object') return clone(over);
  const out = Object.assign({}, base);
  for (const k of Object.keys(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = deepMerge(base[k], over[k]);
  }
  return out;
}

/* recursively sanitize an incoming patch */
function sanitize(v, depth) {
  depth = depth || 0;
  if (depth > 12) return undefined;
  if (typeof v === 'string') return v.length > 4000 ? v.slice(0, 4000) : v;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, v)) : 0;
  if (typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => sanitize(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const s = sanitize(v[k], depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

DEFAULTS = loadDefaults();

let state = {
  live: defaultLook(),
  pending: defaultLook(),
  anim: defaultAnim(),
  settings: defaultSettings(),
  visible: false,
  shownAt: 0,
  presets: defaultPresets(),
  /* elementId -> [{id,label,text}] — a text library, deliberately outside
     live/pending so saving one never dirties the state or reaches air, and
     loading a preset never destroys it */
  snippets: {},
};

function sanitizeSnippetStore(raw, knownIds) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  /* Buckets whose element is currently absent are KEPT: an element removed or
     replaced by a preset load must not take the operator's text bank with it.
     Known ids are kept first so the 64-bucket cap can only ever drop the
     oldest unreferenced ones. */
  const keys = Object.keys(raw);
  const ordered = knownIds
    ? keys.filter((k) => knownIds.has(k)).concat(keys.filter((k) => !knownIds.has(k)))
    : keys;
  let buckets = 0;
  for (const key of ordered) {
    if (buckets >= 64) break;
    const list = Array.isArray(raw[key]) ? raw[key] : [];
    const clean = list.slice(0, 60).map(function (sn) {
      if (!sn || typeof sn !== 'object') return null;
      return {
        id: String(sn.id || newId('sn')),
        label: String(sn.label === undefined ? '' : sn.label).slice(0, 60),
        text: String(sn.text === undefined ? '' : sn.text).slice(0, 4000),
      };
    }).filter(Boolean);
    if (clean.length) { out[key] = clean; buckets++; }
  }
  return out;
}

function snippetsFor(id) {
  if (!state.snippets[id]) state.snippets[id] = [];
  return state.snippets[id];
}

function pushSnippets() {
  persist();
  broadcast({ type: 'snippets', snippets: state.snippets });
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    /* migrateLook() upgrades an old fixed-slot look and normalizes a new one,
       so this is safe on both old and already-migrated state files */
    const wasOld = !!(saved.live && !Array.isArray(saved.live.elements));
    state.live = migrateLook(saved.live);
    state.pending = migrateLook(saved.pending || saved.live);
    state.anim = deepMerge(defaultAnim(), saved.anim || {});
    state.settings = deepMerge(defaultSettings(), saved.settings || {});
    state.visible = !!saved.visible;
    state.shownAt = saved.shownAt || 0;
    if (Array.isArray(saved.presets)) {
      state.presets = saved.presets.map(migratePreset).filter(Boolean);
    }

    /* saved texts used to hang off each element — lift them into the store */
    const harvested = {};
    const harvestFrom = (look) => {
      if (!look || !Array.isArray(look.elements)) return;
      for (const e of look.elements) {
        if (e && e.id && Array.isArray(e.snippets) && e.snippets.length) {
          harvested[e.id] = (harvested[e.id] || []).concat(e.snippets);
        }
      }
    };
    harvestFrom(saved.pending);
    harvestFrom(saved.live);
    /* presets carry copies of the elements, so texts saved while a preset was
       loaded were stored in there too — collect them before they are stripped */
    if (Array.isArray(saved.presets)) saved.presets.forEach(harvestFrom);
    const known = new Set(
      state.pending.elements.map(function (e) { return e.id; })
        .concat(state.live.elements.map(function (e) { return e.id; })));
    state.snippets = sanitizeSnippetStore(
      Object.assign(harvested, (saved.snippets && typeof saved.snippets === 'object') ? saved.snippets : {}),
      known);

    console.log('[lower-thirds] Restored state from ' + STATE_FILE +
      (wasOld ? ' (upgraded to the dynamic element model)' : ''));
  } catch (e) {
    /* Keep the unreadable file: the next save would otherwise overwrite the
       only copy of the operator's presets and saved texts. */
    let kept = '';
    try {
      const bak = STATE_FILE + '.corrupt-' + Date.now() + '.bak';
      fs.copyFileSync(STATE_FILE, bak);
      kept = ' A copy was kept at ' + bak;
    } catch (e2) { /* nothing more we can do */ }
    console.error('[lower-thirds] Could not read saved state (starting fresh): ' + e.message + kept);
  }
}

let saveTimer = null;
function persist(now) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const write = () => {
    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.error('[lower-thirds] Failed to save state:', e.message);
    }
  };
  if (now) write();
  else saveTimer = setTimeout(write, 400);
}

function isDirty() {
  return JSON.stringify(state.live) !== JSON.stringify(state.pending);
}

function publicState() {
  return {
    live: state.live,
    pending: state.pending,
    anim: state.anim,
    settings: state.settings,
    visible: state.visible,
    shownAt: state.shownAt,
    presets: state.presets,
    snippets: state.snippets,
    dirty: isDirty(),
  };
}

/* ---------------------------------------------------------------- ws hub */

const sockets = new Set(); // { ws, role }

function broadcast(msg, roleFilter) {
  const raw = JSON.stringify(msg);
  for (const c of sockets) {
    if (roleFilter && c.role !== roleFilter) continue;
    if (c.ws.readyState === 1) { try { c.ws.send(raw); } catch (e) { /* ignore */ } }
  }
}

function counts() {
  const c = { program: 0, preview: 0, control: 0 };
  for (const s of sockets) if (c[s.role] !== undefined) c[s.role]++;
  return c;
}

function broadcastCounts() { broadcast({ type: 'counts', counts: counts() }); }

/* ------------------------------------------------------------- actions */

let autoHideTimer = null;

function scheduleAutoHide() {
  if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
  const sec = state.anim.autoHideSec;
  if (state.visible && sec > 0) {
    autoHideTimer = setTimeout(() => doHide('auto'), sec * 1000);
  }
}

function doTake(source) {
  if (!isDirty()) return false;
  state.live = clone(state.pending);
  persist(true);
  broadcast({ type: 'commit', live: state.live, animate: state.anim.enabled, dirty: false });
  console.log('[lower-thirds] TAKE (' + source + ')' + (state.anim.enabled ? ' animated' : ' instant'));
  if (source === 'obs' && state.settings.obs.transitionAction === 'take-show' && !state.visible) {
    doShow('obs');
  }
  return true;
}

function doShow(source) {
  state.live = clone(state.pending);
  state.visible = true;
  state.shownAt = Date.now();
  persist(true);
  broadcast({
    type: 'show', live: state.live, animate: state.anim.enabled,
    visible: true, shownAt: state.shownAt, dirty: false,
  });
  scheduleAutoHide();
  console.log('[lower-thirds] SHOW (' + source + ')');
}

function doHide(source) {
  if (!state.visible) return;
  state.visible = false;
  persist(true);
  if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
  broadcast({ type: 'hide', animate: state.anim.enabled, visible: false });
  console.log('[lower-thirds] HIDE (' + source + ')');
}

function doRevert() {
  state.pending = clone(state.live);
  persist();
  broadcast({ type: 'pending', pending: state.pending, dirty: false });
}

function pushPending() {
  persist();
  broadcast({ type: 'pending', pending: state.pending, dirty: isDirty() });
}

function applyEdit(patch) {
  const p = sanitize(patch) || {};
  /* legacy shape: { content: { headline: { text } } } from older scripts and
     the /api/pending query helpers — route it to the matching element */
  if (p.content && typeof p.content === 'object') {
    Object.keys(p.content).forEach(function (role) {
      const v = p.content[role];
      if (v && typeof v === 'object' && typeof v.text === 'string') setElementText(role, v.text);
      if (v && typeof v === 'object' && v.enabled !== undefined) {
        const el = findElementByRole(role);
        if (el) el.enabled = !!v.enabled;
      }
    });
    delete p.content;
  }
  if (Array.isArray(p.elements)) {
    state.pending.elements = normalizePlacement(p.elements.map(normalizeElement).filter(Boolean));
    delete p.elements;
  }
  state.pending = deepMerge(state.pending, p);
  pushPending();
}

/* map a legacy role name (headline/topline/badge/logo) onto a live element */
function findElementByRole(role) {
  const els = state.pending.elements || [];
  const byId = els.find(function (e) { return e.id === 'el-' + role; });
  if (byId) return byId;
  const byName = els.find(function (e) {
    return String(e.name || '').toLowerCase().replace(/\s+/g, '') === String(role).toLowerCase();
  });
  if (byName) return byName;
  if (role === 'headline') {
    /* fall back to the biggest text element — that is the headline in spirit */
    const texts = els.filter(function (e) { return e.kind === 'text'; });
    if (texts.length) {
      return texts.reduce(function (a, b) { return (b.style.size || 0) > (a.style.size || 0) ? b : a; });
    }
  }
  return null;
}

function setElementText(role, text) {
  const el = findElementByRole(role);
  if (el && el.kind === 'text') { el.text = String(text); return true; }
  return false;
}

function applyAnim(patch) {
  state.anim = deepMerge(state.anim, sanitize(patch));
  persist();
  broadcast({ type: 'anim', anim: state.anim });
  scheduleAutoHide();
}

function applySettings(patch) {
  state.settings = deepMerge(state.settings, sanitize(patch));
  persist();
  broadcast({ type: 'settings', settings: state.settings });
  obs.configure(state.settings.obs);
}

function handleMessage(client, msg) {
  const t = msg.type;
  if (t === 'edit') applyEdit(msg.patch || {});
  else if (t === 'anim') applyAnim(msg.patch || {});
  else if (t === 'settings') applySettings(msg.patch || {});
  else if (t === 'take') doTake('manual');
  else if (t === 'show') doShow('manual');
  else if (t === 'hide') doHide('manual');
  else if (t === 'toggle') { state.visible ? doHide('manual') : doShow('manual'); }
  else if (t === 'revert') doRevert();
  else if (t === 'preview-anim') broadcast({ type: 'preview-anim' }, 'preview');
  else if (t === 'reset-style') {
    state.pending.style = defaultStyle();
    persist();
    broadcast({ type: 'pending', pending: state.pending, dirty: isDirty() });
  }

  /* ---- dynamic elements ---- */
  else if (t === 'element-add') {
    const kind = msg.kind === 'image' ? 'image' : 'text';
    const el = normalizeElement(deepMerge(defaultElement(kind), {
      id: newId('el'),
      name: msg.name || (kind === 'image' ? 'Image' : 'Text'),
      place: { row: Math.max(0, parseInt(msg.row, 10) || 0), col: Math.max(0, parseInt(msg.col, 10) || 0), order: 999, stretch: false, rowSpan: 1, colSpan: 1 },
    }));
    state.pending.elements.push(el);
    normalizePlacement(state.pending.elements);
    pushPending();
  }
  else if (t === 'element-remove') {
    state.pending.elements = state.pending.elements.filter((e) => e.id !== msg.id);
    if (!state.pending.elements.length) {
      state.pending.elements = [normalizeElement(deepMerge(defaultElement('text'), { id: newId('el'), name: 'Headline' }))];
    }
    normalizePlacement(state.pending.elements);
    pushPending();
  }
  else if (t === 'element-duplicate') {
    const src = state.pending.elements.find((e) => e.id === msg.id);
    if (src) {
      const copy = normalizeElement(deepMerge(clone(src), {
        id: newId('el'),
        name: (src.name || 'Element') + ' copy',
        place: { row: src.place.row, col: src.place.col, order: src.place.order + 0.5, stretch: src.place.stretch, rowSpan: src.place.rowSpan, colSpan: src.place.colSpan },
      }));
      state.pending.elements.push(copy);
      normalizePlacement(state.pending.elements);
      pushPending();
    }
  }
  else if (t === 'element-update') {
    const el = state.pending.elements.find((e) => e.id === msg.id);
    if (el) {
      const merged = deepMerge(el, sanitize(msg.patch || {}));
      merged.id = el.id;              // never let a patch change identity
      merged.kind = el.kind;
      const idx = state.pending.elements.indexOf(el);
      state.pending.elements[idx] = normalizeElement(merged);
      normalizePlacement(state.pending.elements);
      pushPending();
    }
  }
  else if (t === 'element-move') {
    const el = state.pending.elements.find((e) => e.id === msg.id);
    if (el) {
      const dir = msg.dir;
      if (dir === 'up') el.place.row -= 1;
      else if (dir === 'down') el.place.row += 1;
      else if (dir === 'left') el.place.col -= 1;
      else if (dir === 'right') el.place.col += 1;
      else if (dir === 'first') el.place.order -= 1.5;   // earlier inside its cell
      else if (dir === 'last') el.place.order += 1.5;
      if (el.place.row < 0) {
        /* moved above the first row: shift everything down to make room */
        state.pending.elements.forEach((e) => { if (e !== el) e.place.row += 1; });
        el.place.row = 0;
      }
      if (el.place.col < 0) {
        state.pending.elements.forEach((e) => { if (e !== el) e.place.col += 1; });
        el.place.col = 0;
      }
      normalizePlacement(state.pending.elements);
      pushPending();
    }
  }
  else if (t === 'element-newrow') {
    /* pull one element out into a brand new row below its current one */
    const el = state.pending.elements.find((e) => e.id === msg.id);
    if (el) {
      const target = el.place.row + 1;
      state.pending.elements.forEach((e) => { if (e !== el && e.place.row >= target) e.place.row += 1; });
      el.place.row = target;
      el.place.col = 0;
      el.place.order = 0;
      normalizePlacement(state.pending.elements);
      pushPending();
    }
  }

  /* ---- saved texts (a library, kept out of live/pending on purpose) ---- */
  else if (t === 'snippet-save') {
    const el = state.pending.elements.find((e) => e.id === msg.id);
    if (el && el.kind === 'text') {
      const text = typeof msg.text === 'string' ? msg.text : el.text;
      if (String(text).trim()) {
        const list = snippetsFor(el.id);
        list.push({
          id: newId('sn'),
          label: String(msg.label || text).slice(0, 60),
          text: String(text).slice(0, 4000),
        });
        if (list.length > 60) state.snippets[el.id] = list.slice(-60);
        pushSnippets();
      }
    }
  }
  else if (t === 'snippet-load') {
    /* fills PENDING only — never shows or takes on its own */
    const el = state.pending.elements.find((e) => e.id === msg.id);
    const list = state.snippets[msg.id];
    if (el && el.kind === 'text' && Array.isArray(list)) {
      const sn = list.find((s) => s.id === msg.snippetId);
      if (sn) { el.text = sn.text; pushPending(); }
    }
  }
  else if (t === 'snippet-delete') {
    const list = state.snippets[msg.id];
    if (Array.isArray(list)) {
      state.snippets[msg.id] = list.filter((s) => s.id !== msg.snippetId);
      pushSnippets();
    }
  }
  else if (t === 'snippet-rename') {
    const list = state.snippets[msg.id];
    if (Array.isArray(list)) {
      const sn = list.find((s) => s.id === msg.snippetId);
      if (sn) { sn.label = String(msg.label || sn.label).slice(0, 60); pushSnippets(); }
    }
  }

  else if (t === 'preset-save') {
    const name = String(msg.name || 'Preset').slice(0, 60);
    state.presets.push(migratePreset({
      id: newId('p'),
      name: name,
      elements: clone(state.pending.elements),
      style: clone(state.pending.style),
      anim: clone(state.anim),
    }));
    persist();
    broadcast({ type: 'presets', presets: state.presets });
  }
  else if (t === 'preset-update') {
    const p = state.presets.find((x) => x.id === msg.id);
    if (p) {
      p.elements = clone(state.pending.elements);
      p.style = clone(state.pending.style);
      p.anim = clone(state.anim);
      p.schema = SCHEMA;
      delete p.content;
      persist();
      broadcast({ type: 'presets', presets: state.presets });
    }
  }
  else if (t === 'preset-load') {
    const p = state.presets.find((x) => x.id === msg.id);
    if (p) {
      const look = migrateLook(Array.isArray(p.elements)
        ? { elements: clone(p.elements), style: clone(p.style) }
        : { content: p.content, style: p.style });
      state.pending.elements = look.elements;
      state.pending.style = look.style;
      state.pending.schema = SCHEMA;
      if (p.anim) state.anim = deepMerge(defaultAnim(), p.anim);
      persist();
      broadcast({ type: 'pending', pending: state.pending, dirty: isDirty() });
      broadcast({ type: 'anim', anim: state.anim });
    }
  }
  else if (t === 'preset-delete') {
    state.presets = state.presets.filter((x) => x.id !== msg.id);
    persist();
    broadcast({ type: 'presets', presets: state.presets });
  }
  else if (t === 'preset-restore') {
    const have = new Set(state.presets.map((p) => p.name));
    for (const p of defaultPresets()) if (!have.has(p.name)) state.presets.push(p);
    persist();
    broadcast({ type: 'presets', presets: state.presets });
  }
}

/* ------------------------------------------------------- obs-websocket */

const SUBS = 1 | 4 | 16 | 1024; // General | Scenes | Transitions | Ui

class ObsBridge {
  constructor() {
    this.cfg = null;
    this.ws = null;
    this.status = 'off';       // off | connecting | connected | disconnected | auth-failed
    this.studioMode = false;
    this.backoff = 2000;
    this.timer = null;
    this.rid = 1;
  }

  statusPayload() {
    return { type: 'obs', status: this.status, studioMode: this.studioMode };
  }

  setStatus(s) {
    if (this.status !== s) console.log('[lower-thirds] OBS websocket: ' + s);
    this.status = s;
    broadcast(this.statusPayload());
  }

  configure(cfg) {
    this.cfg = cfg;
    this.stop(false);
    if (cfg && cfg.enabled) this.connect();
    else this.setStatus('off');
  }

  stop(announce) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
    }
    if (announce) this.setStatus('off');
  }

  connect() {
    const cfg = this.cfg;
    if (!cfg || !cfg.enabled) return;
    this.setStatus('connecting');
    let ws;
    try {
      ws = new WSClient('ws://' + cfg.host + ':' + cfg.port, { handshakeTimeout: 4000 });
    } catch (e) {
      return this.retry();
    }
    this.ws = ws;
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch (e) { return; }
      this.onMessage(m);
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (code === 4008 || code === 4009 || code === 4005) {
        this.setStatus('auth-failed'); // wrong/missing password: wait for new settings
      } else {
        this.retry();
      }
    });
    ws.on('error', () => { /* close follows */ });
  }

  retry() {
    if (!this.cfg || !this.cfg.enabled) return;
    this.setStatus('disconnected');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(Math.round(this.backoff * 1.5), 15000);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }
  }

  request(type, data) {
    this.send({ op: 6, d: { requestType: type, requestId: 'r' + (this.rid++), requestData: data || {} } });
  }

  onMessage(m) {
    if (m.op === 0) { // Hello
      let auth;
      const a = m.d && m.d.authentication;
      if (a) {
        const secret = crypto.createHash('sha256')
          .update((this.cfg.password || '') + a.salt).digest('base64');
        auth = crypto.createHash('sha256')
          .update(secret + a.challenge).digest('base64');
      }
      this.send({ op: 1, d: { rpcVersion: 1, authentication: auth, eventSubscriptions: SUBS } });
    }
    else if (m.op === 2) { // Identified
      this.backoff = 2000;
      this.setStatus('connected');
      this.request('GetStudioModeEnabled');
    }
    else if (m.op === 7) { // RequestResponse
      const d = m.d || {};
      if (d.requestType === 'GetStudioModeEnabled' && d.responseData) {
        this.studioMode = !!d.responseData.studioModeEnabled;
        broadcast(this.statusPayload());
      }
    }
    else if (m.op === 5) { // Event
      const ev = m.d || {};
      if (ev.eventType === 'StudioModeStateChanged') {
        this.studioMode = !!(ev.eventData && ev.eventData.studioModeEnabled);
        broadcast(this.statusPayload());
      }
      else if (ev.eventType === 'SceneTransitionStarted') {
        this.onTransition();
      }
    }
  }

  onTransition() {
    const cfg = state.settings.obs;
    if (!cfg.commitOnTransition) return;
    if (cfg.onlyStudioMode && !this.studioMode) return;
    doTake('obs');
  }
}

const obs = new ObsBridge();

/* ---------------------------------------------------------------- http */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

function sendJson(res, code, obj) {
  const raw = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(raw);
}

function serveFile(res, absPath) {
  fs.readFile(absPath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(absPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

function safeJoin(base, reqPath) {
  const p = path.normalize(path.join(base, reqPath));
  if (!p.startsWith(base)) return null;
  return p;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* installed system fonts (best effort, Windows registry) */
let fontCache = null;
function listSystemFonts() {
  return new Promise((resolve) => {
    if (fontCache) return resolve(fontCache);
    if (process.platform !== 'win32') return resolve([]);
    const { execFile } = require('child_process');
    const keys = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    ];
    const names = new Set();
    let pending = keys.length;
    const done = () => {
      if (--pending > 0) return;
      fontCache = Array.from(names).sort((a, b) => a.localeCompare(b));
      resolve(fontCache);
    };
    for (const key of keys) {
      execFile('reg', ['query', key], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (!err && stdout) {
          for (const line of stdout.split(/\r?\n/)) {
            const m = line.match(/^\s{4}(.+?)\s{4}REG_/);
            if (m) {
              const name = m[1].replace(/\s*\((TrueType|OpenType|VFB|All res)\)\s*$/i, '').trim();
              if (name) names.add(name);
            }
          }
        }
        done();
      });
    }
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const act = p.slice('/api/'.length);

  if (act === 'state') return sendJson(res, 200, Object.assign(publicState(), { obs: obs.statusPayload() }));

  if (act === 'fonts') {
    const fonts = await listSystemFonts().catch(() => []);
    return sendJson(res, 200, { ok: true, fonts });
  }

  if (act === 'quit') {
    sendJson(res, 200, { ok: true, quitting: true });
    console.log('[lower-thirds] Quit requested via API — shutting down.');
    setTimeout(() => { persist(true); process.exit(0); }, 150);
    return;
  }

  if (['take', 'show', 'hide', 'toggle', 'revert'].includes(act)) {
    if (act === 'take') doTake('api');
    else if (act === 'show') doShow('api');
    else if (act === 'hide') doHide('api');
    else if (act === 'toggle') { state.visible ? doHide('api') : doShow('api'); }
    else if (act === 'revert') doRevert();
    return sendJson(res, 200, { ok: true, visible: state.visible, dirty: isDirty() });
  }

  if (act === 'pending') {
    let patch = {};
    if (req.method === 'POST') {
      try {
        const body = await readBody(req, 1024 * 1024);
        patch = JSON.parse(body.toString('utf8') || '{}');
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
      }
    }
    // quick query-string helpers: /api/pending?headline=...&topline=...&badge=...&take=1
    const content = {};
    if (url.searchParams.has('headline')) content.headline = { text: url.searchParams.get('headline') };
    if (url.searchParams.has('topline')) content.topline = { text: url.searchParams.get('topline'), enabled: true };
    if (url.searchParams.has('badge')) content.badge = { text: url.searchParams.get('badge'), enabled: true };
    if (Object.keys(content).length) patch = deepMerge(patch, { content });
    applyEdit(patch);
    if (url.searchParams.get('take') === '1') doTake('api');
    if (url.searchParams.get('show') === '1') doShow('api');
    return sendJson(res, 200, { ok: true, dirty: isDirty() });
  }

  if (act === 'upload' && req.method === 'POST') {
    try {
      const body = await readBody(req, 20 * 1024 * 1024);
      const rawName = url.searchParams.get('name') || 'upload.png';
      const ext = (path.extname(rawName).toLowerCase() || '.png').replace(/[^.\w]/g, '');
      const imgExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
      const fontExt = ['.ttf', '.otf', '.woff', '.woff2'];
      const useExt = imgExt.includes(ext) || fontExt.includes(ext) ? ext : '.png';
      const prefix = fontExt.includes(useExt) ? 'font-' : 'logo-';
      const name = prefix + crypto.randomBytes(4).toString('hex') + useExt;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), body);
      return sendJson(res, 200, { ok: true, url: '/uploads/' + name });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'Unknown API endpoint' });
}

function handleHttp(req, res) {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { res.writeHead(400); return res.end(); }
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
    return;
  }

  if (p === '/' ) {
    res.writeHead(302, { Location: '/control' });
    return res.end();
  }
  if (p === '/overlay') return serveFile(res, path.join(PUBLIC_DIR, 'overlay.html'));
  if (p === '/control') return serveFile(res, path.join(PUBLIC_DIR, 'control.html'));

  if (p.startsWith('/uploads/')) {
    const abs = safeJoin(UPLOAD_DIR, p.slice('/uploads/'.length));
    if (!abs) { res.writeHead(403); return res.end(); }
    return serveFile(res, abs);
  }

  const abs = safeJoin(PUBLIC_DIR, p);
  if (!abs) { res.writeHead(403); return res.end(); }
  return serveFile(res, abs);
}

/* ---------------------------------------------------------------- boot */

loadState();
obs.configure(state.settings.obs);
scheduleAutoHide();

const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  let role = 'control';
  try {
    const u = new URL(req.url, 'http://x');
    const r = u.searchParams.get('role');
    if (r === 'program' || r === 'preview' || r === 'control') role = r;
  } catch (e) { /* default */ }

  const client = { ws, role };
  sockets.add(client);

  ws.send(JSON.stringify({
    type: 'hello',
    state: publicState(),
    obs: obs.statusPayload(),
    counts: counts(),
  }));
  broadcastCounts();

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    try { handleMessage(client, msg); } catch (e) {
      console.error('[lower-thirds] Error handling message:', e.message);
    }
  });
  ws.on('close', () => { sockets.delete(client); broadcastCounts(); });
  ws.on('error', () => { /* close follows */ });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n[lower-thirds] Port ' + PORT + ' is already in use.');
    console.error('[lower-thirds] Is the server already running? Or start with:  node server.js --port 3621\n');
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  OBS Lower Thirds is running                             │');
  console.log('  └──────────────────────────────────────────────────────────┘');
  console.log('');
  console.log('  Control panel (OBS custom browser dock):');
  console.log('      http://' + HOST + ':' + PORT + '/control');
  console.log('');
  console.log('  Overlay (OBS browser source, 1920x1080):');
  console.log('      http://' + HOST + ':' + PORT + '/overlay');
  console.log('');
  console.log('  Preview mirror (optional second source / projector):');
  console.log('      http://' + HOST + ':' + PORT + '/overlay?role=preview');
  console.log('');
  console.log('  Data folder: ' + DATA_DIR);
  console.log('');
});

process.on('SIGINT', () => { persist(true); process.exit(0); });
process.on('SIGTERM', () => { persist(true); process.exit(0); });
