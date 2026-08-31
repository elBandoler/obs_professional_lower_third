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

function defaultLook() {
  return {
    content: {
      topline: { enabled: true, text: 'שם הדובר – תפקיד או תיאור' },
      headline: { text: 'כותרת לדוגמה: כך ניתן להציג טקסט ארוך יותר בתחתית המסך' },
      badge: { enabled: true, text: 'example.com/live' },
      logo: { enabled: true, url: '/assets/logo-placeholder.svg', scale: 1 },
    },
    style: {
      direction: 'auto',            // auto | rtl | ltr
      textAlign: 'start',           // start | center | end
      layout: {
        anchor: 'left',             // left | center | right (when not fullWidth)
        fullWidth: true,
        maxWidth: 70,               // % of canvas width when not fullWidth
        sideMargin: 0,              // px
        bottomMargin: 64,           // px
        logoSide: 'right',          // left | right
      },
      bars: {
        headline: {
          bg: '#ffffff', bgOpacity: 1, color: '#0d2b6b',
          size: 56, weight: 800, letterSpacing: 0, padX: 30, padY: 16,
          gradient: { enabled: false, color2: '#e9edf5', angle: 180 },
          image: { enabled: false, url: '', fit: 'cover' },
        },
        topline: {
          bg: '#ffffff', bgOpacity: 0.95, color: '#12161c',
          size: 28, weight: 600, letterSpacing: 0, padX: 24, padY: 9,
          image: { enabled: false, url: '', fit: 'cover' },
        },
        badge: { bg: '#1c56d6', color: '#ffffff', size: 23, weight: 700 },
        logoBox: { bg: '#ffffff', bgOpacity: 1, pad: 12, minWidth: 180 },
      },
      font: {
        family: "'Segoe UI', 'Heebo', 'Noto Sans Hebrew', Arial, sans-serif",
        customCssUrl: '',
        uploads: [],
      },
      edges: { style: 'square', radius: 14, chamfer: 26 },  // square | rounded | chamfer
      accent: { mode: 'none', color: '#1c56d6', thickness: 6 }, // none | top | side | underline
      shadow: 40,   // 0..100
      gap: 4,       // px between blocks
    },
  };
}

function defaultAnim() {
  return {
    enabled: true,
    inStyle: 'slide-up',       // slide-up | slide-side | wipe | fade | pop
    outStyle: 'auto',          // auto (reverse of in) | slide-up | slide-side | wipe | fade | pop
    changeStyle: 'slide-swap', // slide-swap | crossfade | instant
    inMs: 700, outMs: 500, changeMs: 450, staggerMs: 90,
    easing: 'snappy',          // smooth | snappy | bouncy | linear
    autoHideSec: 0,            // 0 = never
  };
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
  };
}

function defaultPresets() {
  const base = defaultLook();

  const breaking = defaultLook();
  breaking.content = {
    topline: { enabled: true, text: 'BREAKING NEWS' },
    headline: { text: 'Major story developing right now' },
    badge: { enabled: true, text: 'LIVE' },
    logo: { enabled: true, url: '/assets/logo-placeholder.svg', scale: 1 },
  };
  breaking.style.direction = 'ltr';
  breaking.style.bars.headline = {
    bg: '#b31217', bgOpacity: 1, color: '#ffffff',
    size: 54, weight: 800, letterSpacing: 1, padX: 30, padY: 16,
    gradient: { enabled: true, color2: '#7a0c10', angle: 180 },
  };
  breaking.style.bars.topline = {
    bg: '#111111', bgOpacity: 1, color: '#ffd400',
    size: 26, weight: 800, letterSpacing: 4, padX: 24, padY: 8,
  };
  breaking.style.bars.badge = { bg: '#ffffff', color: '#b31217', size: 22, weight: 800 };
  breaking.style.bars.logoBox = { bg: '#111111', bgOpacity: 1, pad: 12, minWidth: 170 };
  breaking.style.edges = { style: 'chamfer', radius: 0, chamfer: 24 };
  breaking.style.accent = { mode: 'none', color: '#ffd400', thickness: 6 };
  const breakingAnim = defaultAnim();
  breakingAnim.inStyle = 'wipe';
  breakingAnim.easing = 'snappy';

  const strap = defaultLook();
  strap.content = {
    topline: { enabled: true, text: 'Senior Political Analyst' },
    headline: { text: 'Dana Cohen' },
    badge: { enabled: false, text: '' },
    logo: { enabled: false, url: '', scale: 1 },
  };
  strap.style.direction = 'ltr';
  strap.style.layout = { anchor: 'left', fullWidth: false, maxWidth: 46, sideMargin: 80, bottomMargin: 90, logoSide: 'left' };
  strap.style.bars.headline = {
    bg: '#101418', bgOpacity: 0.88, color: '#ffffff',
    size: 46, weight: 700, letterSpacing: 0, padX: 28, padY: 12,
    gradient: { enabled: false, color2: '#101418', angle: 180 },
  };
  strap.style.bars.topline = {
    bg: '#1c56d6', bgOpacity: 1, color: '#ffffff',
    size: 22, weight: 600, letterSpacing: 2, padX: 20, padY: 6,
  };
  strap.style.edges = { style: 'rounded', radius: 8, chamfer: 0 };
  strap.style.accent = { mode: 'side', color: '#1c56d6', thickness: 6 };
  const strapAnim = defaultAnim();
  strapAnim.inStyle = 'slide-side';
  strapAnim.autoHideSec = 8;

  const gradient = defaultLook();
  gradient.content = {
    topline: { enabled: false, text: '' },
    headline: { text: 'Evening Headlines' },
    badge: { enabled: false, text: '' },
    logo: { enabled: true, url: '/assets/logo-placeholder.svg', scale: 0.9 },
  };
  gradient.style.direction = 'ltr';
  gradient.style.layout = { anchor: 'center', fullWidth: false, maxWidth: 50, sideMargin: 0, bottomMargin: 72, logoSide: 'left' };
  gradient.style.bars.headline = {
    bg: '#182848', bgOpacity: 0.96, color: '#ffffff',
    size: 48, weight: 700, letterSpacing: 0, padX: 34, padY: 16,
    gradient: { enabled: true, color2: '#4b6cb7', angle: 115 },
  };
  gradient.style.bars.logoBox = { bg: '#0e1a33', bgOpacity: 0.96, pad: 12, minWidth: 120 };
  gradient.style.edges = { style: 'rounded', radius: 16, chamfer: 0 };
  gradient.style.textAlign = 'center';
  const gradientAnim = defaultAnim();
  gradientAnim.inStyle = 'pop';
  gradientAnim.easing = 'bouncy';

  return [
    { id: 'p-knesset', name: 'News two-line (RTL demo)', content: base.content, style: base.style, anim: defaultAnim() },
    { id: 'p-breaking', name: 'Breaking news (red)', content: breaking.content, style: breaking.style, anim: breakingAnim },
    { id: 'p-strap', name: 'Name strap (minimal)', content: strap.content, style: strap.style, anim: strapAnim },
    { id: 'p-gradient', name: 'Centered gradient', content: gradient.content, style: gradient.style, anim: gradientAnim },
  ];
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

let state = {
  live: defaultLook(),
  pending: defaultLook(),
  anim: defaultAnim(),
  settings: defaultSettings(),
  visible: false,
  shownAt: 0,
  presets: defaultPresets(),
};

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.live = deepMerge(defaultLook(), saved.live || {});
    state.pending = deepMerge(defaultLook(), saved.pending || {});
    state.anim = deepMerge(defaultAnim(), saved.anim || {});
    state.settings = deepMerge(defaultSettings(), saved.settings || {});
    state.visible = !!saved.visible;
    state.shownAt = saved.shownAt || 0;
    if (Array.isArray(saved.presets)) state.presets = saved.presets;
    console.log('[lower-thirds] Restored state from', STATE_FILE);
  } catch (e) {
    console.error('[lower-thirds] Could not read saved state (starting fresh):', e.message);
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

function applyEdit(patch) {
  state.pending = deepMerge(state.pending, sanitize(patch));
  persist();
  broadcast({ type: 'pending', pending: state.pending, dirty: isDirty() });
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
    state.pending.style = defaultLook().style;
    persist();
    broadcast({ type: 'pending', pending: state.pending, dirty: isDirty() });
  }
  else if (t === 'preset-save') {
    const name = String(msg.name || 'Preset').slice(0, 60);
    state.presets.push({
      id: 'p-' + crypto.randomBytes(5).toString('hex'),
      name,
      content: clone(state.pending.content),
      style: clone(state.pending.style),
      anim: clone(state.anim),
    });
    persist();
    broadcast({ type: 'presets', presets: state.presets });
  }
  else if (t === 'preset-update') {
    const p = state.presets.find((x) => x.id === msg.id);
    if (p) {
      p.content = clone(state.pending.content);
      p.style = clone(state.pending.style);
      p.anim = clone(state.anim);
      persist();
      broadcast({ type: 'presets', presets: state.presets });
    }
  }
  else if (t === 'preset-load') {
    const p = state.presets.find((x) => x.id === msg.id);
    if (p) {
      state.pending.content = deepMerge(defaultLook().content, p.content);
      state.pending.style = deepMerge(defaultLook().style, p.style);
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
