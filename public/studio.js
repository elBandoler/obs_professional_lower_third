/* OBS Lower Thirds — Studio dock.
   The redesigned control panel. It shares the server, the state and every
   WebSocket message with /control, and nothing else: the section marked
   "ported from control.js" holds copies of that dock's helpers (the optimistic
   edit layer, the field factory, the gradient/logo/shape editors) taken at
   v1.6.0 and maintained here separately, so a change to one dock never
   touches the other. Plain ES5, no build step. */
(function () {
  'use strict';

  /* ------------------------------------------------------------ state */

  var S = null;            // full public state from the server
  var NATIVE = false;      // served by the native OBS plugin
  var obsStatus = { status: 'off', studioMode: false };
  var counts = { program: 0, preview: 0, control: 0 };
  var built = false;
  var sock = null;
  var dirty = false;       // NEXT differs from AIR
  var diffRes = { items: [], globalStyle: false, count: 0, byId: {} };
  var selectedId = null;   // the one selection shared by preview, cue sheet, inspector, map
  var editSerial = 0;      // bumped on every local edit; the undo stash watches it
  var composing = false;   // an IME composition is open
  var FONTLIST = [];
  var pendingImageSetter = null;
  var syncs = [];          // every component's sync, run in registration order
  var listeners = {};

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function isField(n) {
    return !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT');
  }
  function isVideoUrl(u) { return /\.(mp4|webm|mov|m4v|ogv)$/i.test(String(u || '').split('?')[0]); }
  function hasHebrew(t) { return /[֐-׿؀-ۿ]/.test(String(t || '')); }

  /* a tiny bus: components subscribe to message types they care about */
  function on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
  function emit(type) { (listeners[type] || []).forEach(function (fn) { fn(); }); }
  function reg(fn) { syncs.push(fn); }

  /* one pass that brings every component up to date. Runs after every local
     edit and every broadcast; each sync is cheap and idempotent. */
  function refresh() {
    if (!S || !built) return;
    dirty = JSON.stringify(S.live) !== JSON.stringify(S.pending);
    diffRes = liveVsPending();
    if (selectedId && !findEl(selectedId)) { selectedId = null; inspector.point(null); }
    for (var i = 0; i < syncs.length; i++) syncs[i]();
  }

  function send(msg) {
    if (msg && REPLACING[msg.type]) clearAllInFlight();
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(msg));
  }
  function bumpEdit() { editSerial++; }

  /* global field helpers used by the GLOBAL_FIELDS specs */
  function g(path) { return function () { return getVal(path); }; }
  function s(path) { return function (v) { sendField(path, v); }; }
  function notFullWidth() { return !getVal('style.layout.fullWidth'); }

  /* the old dock's footer note becomes a toast in whichever lane is showing */
  function note(text, opts) { toast(activeLane(), text, opts || {}); }

  /* the look's effective reading direction */
  function readingDir() {
    var d = S && S.pending && S.pending.style && S.pending.style.direction;
    if (d === 'rtl' || d === 'ltr') return d;
    var first = elements().filter(function (e) { return e.kind === 'text' && e.enabled !== false; })[0];
    return first && hasHebrew(first.text) ? 'rtl' : 'ltr';
  }

  /* elements in cue-sheet order: rows top to bottom, then col, then order;
     full-height elements last */
  function ordered() {
    return elements().slice().sort(function (a, b) {
      var sa = a.place.spanAll ? 1 : 0, sb = b.place.spanAll ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return (a.place.row - b.place.row) || (a.place.col - b.place.col) || (a.place.order - b.place.order);
    });
  }
  function posTag(e) { return e.place.spanAll ? 'full' : ('r' + (e.place.row + 1) + '·c' + (e.place.col + 1)); }
  function liveEl(id) {
    var arr = (S && S.live && S.live.elements) || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  /* ------------------------------------------------------------- diff
     One truthful sentence about what SHOW/UPDATE will do, the per-element
     dots, and the unsent-edit count the preset arm quotes. Deliberately
     coarse; nothing gates SHOW on it. */
  function liveVsPending() {
    var res = { items: [], globalStyle: false, count: 0, byId: {} };
    if (!S || !S.live || !S.pending) return res;
    var L = {}, P = {};
    (S.live.elements || []).forEach(function (e) { L[e.id] = e; });
    (S.pending.elements || []).forEach(function (e) { P[e.id] = e; });
    Object.keys(P).forEach(function (id) {
      var p = P[id], l = L[id], tags = [];
      if (!l) tags.push('added');
      else {
        if (p.kind === 'text' && p.text !== l.text) tags.push('text');
        if ((p.enabled !== false) !== (l.enabled !== false)) tags.push(p.enabled === false ? 'hidden' : 'shown');
        var pp = p.place, lp = l.place;
        if (pp.row !== lp.row || pp.col !== lp.col || pp.order !== lp.order ||
            !!pp.spanAll !== !!lp.spanAll || !!pp.stretch !== !!lp.stretch || pp.pin !== lp.pin) tags.push('moved');
        if (p.kind === 'image' && (p.image.url !== l.image.url ||
            JSON.stringify(p.image.sources || []) !== JSON.stringify(l.image.sources || []))) tags.push('logo');
        if (!tags.length && (JSON.stringify(p.style) !== JSON.stringify(l.style) ||
            JSON.stringify(p.anim) !== JSON.stringify(l.anim) || p.name !== l.name)) tags.push('style');
      }
      if (tags.length) { res.items.push({ id: id, name: p.name || p.kind, tags: tags }); res.byId[id] = tags; }
    });
    Object.keys(L).forEach(function (id) {
      if (!P[id]) { res.items.push({ id: id, name: L[id].name || L[id].kind, tags: ['removed'] }); res.byId[id] = ['removed']; }
    });
    res.globalStyle = JSON.stringify(S.pending.style) !== JSON.stringify(S.live.style);
    res.count = res.items.length + (res.globalStyle ? 1 : 0);
    return res;
  }
  function diffSentence() {
    if (!S) return '';
    if (!S.visible) {
      var n = elements().filter(function (e) { return e.enabled !== false; }).length;
      return 'SHOW will bring ' + n + ' element' + (n === 1 ? '' : 's') + ' on air';
    }
    if (!diffRes.count) return 'NEXT matches AIR';
    var parts = diffRes.items.slice(0, 4).map(function (it) { return it.name + ' ' + it.tags.join('/'); });
    if (diffRes.globalStyle) parts.push('look style');
    var more = diffRes.items.length - 4;
    return 'UPDATE will change: ' + parts.join(', ') + (more > 0 ? ' +' + more + ' more' : '');
  }
  function diffTitle() {
    return diffRes.items.map(function (it) { return it.name + ': ' + it.tags.join(', '); })
      .concat(diffRes.globalStyle ? ['look style changed'] : []).join('\n');
  }

  /* ----------------------------------------------------------- toasts
     Notices that never shift layout, one at a time per lane, queued. */
  var lanes = { air: { q: [], cur: null, timer: null }, design: { q: [], cur: null, timer: null } };
  function activeLane() {
    if (document.body.classList.contains('st-wide')) return 'air';
    return document.body.classList.contains('place-design') ? 'design' : 'air';
  }
  function toast(lane, text, opts) {
    var L = lanes[lane] || lanes.air;
    L.q.push({ text: text, opts: opts || {} });
    if (!L.cur) nextToast(lane);
  }
  function nextToast(lane) {
    var L = lanes[lane];
    var host = $('#st-toast-' + lane);
    if (L.timer) { clearTimeout(L.timer); L.timer = null; }
    if (L.cur && L.cur.node.parentNode) L.cur.node.parentNode.removeChild(L.cur.node);
    L.cur = null;
    var item = L.q.shift();
    if (!item || !host) return;
    var node = el('div', 'st-toast');
    node.appendChild(el('span', 'st-toast-msg', item.text));
    if (item.opts.action) {
      var b = el('button', null, item.opts.action);
      if (item.opts.disabled) { b.disabled = true; b.title = item.opts.disabledTitle || ''; }
      b.addEventListener('click', function () {
        if (item.opts.onAction) item.opts.onAction();
        dismissToast(lane);
      });
      node.appendChild(b);
    }
    node.addEventListener('click', function (ev) { if (ev.target === node || ev.target.className === 'st-toast-msg') dismissToast(lane); });
    host.appendChild(node);
    L.cur = { node: node, item: item };
    L.timer = setTimeout(function () { dismissToast(lane); }, item.opts.ms || 6000);
  }
  function dismissToast(lane) {
    var L = lanes[lane];
    if (L.cur && L.cur.item.opts.onDismiss) L.cur.item.opts.onDismiss();
    nextToast(lane);
  }

  /* two-tap primitive for anything destructive or replacing */
  var armedButtons = [];
  function armed(btn, opts) {
    var label = opts.label, armedLabel = opts.armedLabel || (label + '?'), ms = opts.ms || 2500;
    btn.textContent = label;
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (btn.dataset.armed) { disarm(btn); opts.fire(); return; }
      btn.dataset.armed = '1';
      btn.textContent = armedLabel;
      if (opts.danger) btn.classList.add('st-danger');
      btn._disarmTimer = setTimeout(function () { disarm(btn); }, ms);
      armedButtons.push(btn);
    });
    function disarm(b) {
      if (b._disarmTimer) { clearTimeout(b._disarmTimer); b._disarmTimer = null; }
      delete b.dataset.armed;
      b.classList.remove('st-danger');
      b.textContent = label;
      var i = armedButtons.indexOf(b);
      if (i >= 0) armedButtons.splice(i, 1);
    }
    btn._disarm = function () { disarm(btn); };
    return btn;
  }
  function disarmAll() {
    armedButtons.slice().forEach(function (b) { if (b._disarm) b._disarm(); });
    return true;
  }
  document.addEventListener('pointerdown', function (ev) {
    armedButtons.slice().forEach(function (b) { if (!b.contains(ev.target) && b._disarm) b._disarm(); });
  }, true);

  /* ------------------------------------------------------------ status */

  function syncStatus() {
    var pill = $('#st-pill-onair');
    var wide = document.body.classList.contains('st-wide');
    pill.classList.toggle('onair', !!S.visible);
    var n = elements().filter(function (e) { return e.enabled !== false; }).length;
    pill.textContent = S.visible ? ('ON AIR' + (wide ? ' · ' + n + ' element' + (n === 1 ? '' : 's') : '')) : 'OFF AIR';
    document.body.classList.toggle('onair', !!S.visible);
    $('#st-dot-pgm').hidden = counts.program > 0;
    var od = $('#st-dot-obs');
    if (NATIVE) od.hidden = true;
    else {
      od.hidden = false;
      od.className = 'st-dot ' + (obsStatus.status === 'connected' ? 'st-dot-green'
        : (obsStatus.status === 'auth-failed' ? 'st-dot-red' : 'st-dot-amber'));
      od.title = obsHintText();
    }
  }
  function setPlace(which) {
    document.body.classList.toggle('place-air', which === 'air');
    document.body.classList.toggle('place-design', which === 'design');
    $('#st-place-air').classList.toggle('on', which === 'air');
    $('#st-place-design').classList.toggle('on', which === 'design');
    $('#st-place-air').setAttribute('aria-pressed', which === 'air' ? 'true' : 'false');
    $('#st-place-design').setAttribute('aria-pressed', which === 'design' ? 'true' : 'false');
    store('lt-studio-place', which);
    fitPreview();
  }

  /* ----------------------------------------------------------- preview
     The only preview there is. STRAP crops to the band around the drawn
     strap so a 320px dock shows it large; FULL shows the whole frame. The
     hit buttons are positioned through the same crop, so a tap lands on the
     bar that drew that pixel. */
  var PV = { x: 0, y: 0, scale: 1 };
  var pvMode = load('lt-studio-preview') || null;
  var lastCrop = null, lastCropAt = 0;
  var hitsPaused = false;

  function pvFrameDoc() {
    try { return $('#st-pv-frame').contentDocument; } catch (e) { return null; }
  }
  function currentMode() {
    if (pvMode) return pvMode;
    return document.body.classList.contains('st-wide') ? 'full' : 'strap';
  }
  function strapCrop() {
    var now = Date.now();
    var focused = isField(document.activeElement) &&
      ($('#st-cue').contains(document.activeElement) || $('#st-dpane').contains(document.activeElement));
    if (lastCrop && (focused || dragging || now - lastCropAt < 250)) return lastCrop;
    /* the band around the drawn bars, not the container: in a full-width
       look #lt spans all 1920px and a crop to it can never get tall */
    var rect = null;
    try {
      var doc = pvFrameDoc();
      var boxes = doc ? doc.querySelectorAll('#lt .box[data-id]') : [];
      var u = null;
      for (var bi = 0; bi < boxes.length; bi++) {
        var br = boxes[bi].getBoundingClientRect();
        if (!br.width || !br.height) continue;
        if (!u) u = { left: br.left, top: br.top, right: br.right, bottom: br.bottom };
        else { u.left = Math.min(u.left, br.left); u.top = Math.min(u.top, br.top); u.right = Math.max(u.right, br.right); u.bottom = Math.max(u.bottom, br.bottom); }
      }
      if (u) rect = { left: u.left, top: u.top, right: u.right, bottom: u.bottom, width: u.right - u.left, height: u.bottom - u.top };
      else { var lt = doc && doc.getElementById('lt'); if (lt) rect = lt.getBoundingClientRect(); }
    } catch (e) { rect = null; }
    var c;
    if (!rect || !rect.width || !rect.height) c = { x: 0, y: 680, w: 1920, h: 400 };
    else {
      var pad = 48;
      var x0 = Math.max(0, rect.left - pad), x1 = Math.min(1920, rect.right + pad);
      if (x1 - x0 < 960) {
        var mid = (x0 + x1) / 2;
        x0 = Math.max(0, mid - 480); x1 = Math.min(1920, x0 + 960); x0 = x1 - 960;
      }
      var top = Math.max(0, rect.top - pad);
      var h = 1080 - top;
      if (h < 300) { h = 300; top = 780; }
      c = { x: x0, y: top, w: x1 - x0, h: h };
    }
    /* hysteresis: keep the old crop when the new one fits inside it and is
       not much smaller, so the picture does not twitch on every keystroke */
    if (lastCrop) {
      var inside = c.x >= lastCrop.x && c.y >= lastCrop.y &&
        c.x + c.w <= lastCrop.x + lastCrop.w && c.y + c.h <= lastCrop.y + lastCrop.h;
      if (inside && c.w >= lastCrop.w * 0.85 && c.h >= lastCrop.h * 0.85) { lastCropAt = now; return lastCrop; }
    }
    lastCrop = c; lastCropAt = now;
    return c;
  }
  function fitPreview() {
    var box = $('#st-pv-box'), frame = $('#st-pv-frame');
    if (!box || !frame) return;
    var W = box.clientWidth;
    if (!W) return;
    var crop = currentMode() === 'strap' ? strapCrop() : { x: 0, y: 0, w: 1920, h: 1080 };
    var scale = W / crop.w;
    box.style.height = Math.round(crop.h * scale) + 'px';
    frame.style.transform = 'translate(' + (-crop.x * scale) + 'px,' + (-crop.y * scale) + 'px) scale(' + scale + ')';
    PV = { x: crop.x, y: crop.y, scale: scale };
    paintHits();
  }
  function paintHits() {
    if (hitsPaused) return;
    var host = $('#st-pv-hit');
    var doc = pvFrameDoc();
    if (!host) return;
    if (!doc) { host.innerHTML = ''; return; }
    var boxes = doc.querySelectorAll('#lt .box[data-id]');
    host.innerHTML = '';
    for (var i = 0; i < boxes.length; i++) {
      (function (b) {
        var r = b.getBoundingClientRect();
        if (!r.width || !r.height) return;
        var id = b.dataset.id;
        var hit = el('button', 'hit' + (id === selectedId ? ' sel' : ''));
        hit.dataset.id = id;
        hit.style.left = ((r.left - PV.x) * PV.scale) + 'px';
        hit.style.top = ((r.top - PV.y) * PV.scale) + 'px';
        hit.style.width = (r.width * PV.scale) + 'px';
        hit.style.height = (r.height * PV.scale) + 'px';
        var e = findEl(id);
        hit.title = (e && e.name) || 'element';
        hit.addEventListener('click', function (ev) { ev.stopPropagation(); select(id, 'preview'); });
        hit.addEventListener('pointerdown', function (ev) { beginPreviewDrag(ev, hit, id); });
        host.appendChild(hit);
      })(boxes[i]);
    }
  }
  function syncPreview() {
    var box = $('#st-pv-box');
    box.classList.toggle('st-dirty', dirty);
    box.classList.toggle('st-live', !!S.visible && !dirty);
    $('#st-pv-replay').disabled = !(S.visible && !dirty);
    var am = $('#st-anim-master');
    if (am !== document.activeElement) am.checked = !!(S.anim && S.anim.enabled !== false);
    $('#st-pv-framing').textContent = 'Framing: ' + (currentMode() === 'strap' ? 'STRAP' : 'FULL');
  }
  function buildPreview() {
    var menu = $('#st-pv-menu'), btn = $('#st-pv-menu-btn');
    btn.addEventListener('click', function (ev) { ev.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener('pointerdown', function (ev) {
      if (!menu.hidden && !menu.contains(ev.target) && ev.target !== btn) menu.hidden = true;
    }, true);
    var bg = load('lt-studio-bg') || 'checker';
    $('#st-pv-frame').src = '/overlay?role=preview&label=off&bg=' + bg;
    var bgs = menu.querySelectorAll('.st-bg');
    for (var i = 0; i < bgs.length; i++) {
      (function (b) {
        b.classList.toggle('on', b.dataset.bg === bg);
        b.addEventListener('click', function () {
          for (var k = 0; k < bgs.length; k++) bgs[k].classList.toggle('on', bgs[k] === b);
          store('lt-studio-bg', b.dataset.bg);
          $('#st-pv-frame').src = '/overlay?role=preview&label=off&bg=' + b.dataset.bg;
          menu.hidden = true;
        });
      })(bgs[i]);
    }
    $('#st-pv-testanim').addEventListener('click', function () { send({ type: 'preview-anim' }); menu.hidden = true; });
    $('#st-pv-replay').addEventListener('click', function () { if (S.visible && !dirty) send({ type: 'show' }); menu.hidden = true; });
    $('#st-pv-framing').addEventListener('click', function () {
      pvMode = currentMode() === 'strap' ? 'full' : 'strap';
      store('lt-studio-preview', pvMode);
      lastCrop = null;
      fitPreview(); syncPreview();
    });
    $('#st-anim-master').addEventListener('change', function () { sendField('anim.enabled', $('#st-anim-master').checked); });
    $('#st-pv-hit').addEventListener('click', function (ev) { if (ev.target === ev.currentTarget) clearSelection(); });
    $('#st-pv-frame').addEventListener('load', function () { lastCrop = null; setTimeout(fitPreview, 60); setTimeout(function () { lastCrop = null; fitPreview(); }, 600); setTimeout(function () { lastCrop = null; fitPreview(); }, 1800); });
    setInterval(function () { if (S && built) paintHits(); }, 700);
    if (window.ResizeObserver) new ResizeObserver(function () { fitPreview(); }).observe(document.body);
    window.addEventListener('resize', fitPreview);
    on('pending', function () { fitPreview(); });
  }

  /* ----------------------------------------------------------- readout */
  var expandTimers = {};
  var discardArmedUntil = 0;
  function expandLine(node) {
    node.classList.add('st-expand');
    $('#st-readout').classList.add('st-grown');
    if (expandTimers[node.id]) clearTimeout(expandTimers[node.id]);
    expandTimers[node.id] = setTimeout(function () {
      node.classList.remove('st-expand');
      if (!document.querySelector('.st-ro-line.st-expand')) $('#st-readout').classList.remove('st-grown');
    }, 4000);
  }
  function syncReadout() {
    var air = $('#st-readout-air'), nx = $('#st-readout-next');
    air.innerHTML = '';
    if (S.visible) {
      air.classList.remove('st-off');
      air.appendChild(document.createTextNode('ON AIR · '));
      var live = (S.live.elements || []).filter(function (e) { return e.kind === 'text' && e.enabled !== false; })
        .sort(function (a, b) {
          var sa = a.place.spanAll ? 1 : 0, sb = b.place.spanAll ? 1 : 0;
          if (sa !== sb) return sa - sb;
          return (a.place.row - b.place.row) || (a.place.col - b.place.col) || (a.place.order - b.place.order);
        });
      live.forEach(function (e, i) {
        if (i) air.appendChild(document.createTextNode(' · '));
        var sp = el('span', null, e.text || '');
        sp.setAttribute('dir', 'auto');
        air.appendChild(sp);
      });
    } else { air.classList.add('st-off'); air.textContent = 'OFF AIR'; }

    var armedNow = Date.now() < discardArmedUntil;
    nx.innerHTML = '';
    nx.classList.toggle('st-dirty', dirty && !!S.visible);
    var sentence = el('span', null, diffSentence());
    sentence.title = diffTitle();
    nx.appendChild(sentence);
    if (dirty) {
      var d = el('span', 'st-discard', armedNow ? 'discard edits?' : '↺ discard');
      if (armedNow) d.dataset.armed = '1';
      d.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (Date.now() < discardArmedUntil) {
          var snap = { elements: clone(S.pending.elements), style: clone(S.pending.style), anim: clone(S.anim) };
          var n = diffRes.count;
          discardArmedUntil = 0;
          undo.stash(snap, 'Discarded ' + n + ' edit' + (n === 1 ? '' : 's'));
          send({ type: 'revert' });
          return;
        }
        discardArmedUntil = Date.now() + 3000;
        d.dataset.armed = '1'; d.textContent = 'discard edits?';
        setTimeout(function () { if (Date.now() >= discardArmedUntil) syncReadout(); }, 3100);
      });
      nx.appendChild(d);
    }
  }
  function buildReadout() {
    $('#st-readout-air').addEventListener('click', function () { expandLine($('#st-readout-air')); });
    $('#st-readout-next').addEventListener('click', function (ev) { if (!ev.target.classList.contains('st-discard')) expandLine($('#st-readout-next')); });
  }

  /* --------------------------------------------------------- transport
     The only route to air. Inert when a tap would only replay. */
  var transport = {
    armedFrom: null,
    fire: function () {
      if (!S) return;
      if (S.visible && !dirty) return;             /* inert */
      send({ type: 'show' });
      transport.disarm();
    },
    arm: function () {
      if (load('lt-studio-enter-arm') !== '1') return;
      var p = $('#st-primary');
      if (p.classList.contains('st-inert')) return;
      transport.armedFrom = document.activeElement;
      p.classList.add('st-armed');
      p.focus();
      syncTransport();
    },
    disarm: function () {
      var p = $('#st-primary');
      if (!p.classList.contains('st-armed')) return;
      p.classList.remove('st-armed');
      var back = transport.armedFrom; transport.armedFrom = null;
      if (back && back.focus && document.body.contains(back)) back.focus();
      syncTransport();
    },
  };
  function syncTransport() {
    var hide = $('#st-hide'), p = $('#st-primary');
    hide.disabled = !S.visible;
    var left = '';
    if (S.visible && S.anim && S.anim.autoHideSec > 0 && S.shownAt) {
      var secs = Math.ceil(S.anim.autoHideSec - (Date.now() - S.shownAt) / 1000);
      if (secs > 0) left = ' ' + secs + 's';
    }
    hide.textContent = 'HIDE' + left;
    var state = !S.visible ? 'show' : (dirty ? 'update' : 'inert');
    p.classList.toggle('st-update', state === 'update');
    p.classList.toggle('st-glow', dirty);
    p.classList.toggle('st-inert', state === 'inert');
    var armedMark = p.classList.contains('st-armed') ? ' ⏎' : '';
    p.textContent = (state === 'show' ? 'SHOW' : (state === 'update' ? 'UPDATE' : 'ON AIR ✓')) + armedMark;
    p.title = state === 'update' ? 'Put these changes on air' : (state === 'show' ? 'Put what you see in NEXT on air' : 'NEXT is already on air');
  }
  function buildTransport() {
    $('#st-hide').addEventListener('click', function () { send({ type: 'hide' }); });
    $('#st-primary').addEventListener('click', function () { transport.fire(); });
    $('#st-primary').addEventListener('blur', function () { transport.disarm(); });
    setInterval(function () { if (S && built) syncTransport(); }, 300);
  }

  /* --------------------------------------------------------- selection */
  function select(id, source) {
    if (!findEl(id)) return;
    var changed = selectedId !== id;
    selectedId = id;
    var hits = document.querySelectorAll('#st-pv-hit .hit');
    for (var i = 0; i < hits.length; i++) hits[i].classList.toggle('sel', hits[i].dataset.id === id);
    var cards = document.querySelectorAll('#st-cue .st-card');
    for (var k = 0; k < cards.length; k++) cards[k].classList.toggle('sel', cards[k].dataset.id === id);
    var chips = document.querySelectorAll('.st-chip');
    for (var m = 0; m < chips.length; m++) chips[m].classList.toggle('sel', chips[m].dataset.id === id);
    var card = document.querySelector('#st-cue .st-card[data-id="' + id + '"]');
    if (card && source !== 'cue' && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
    var wide = document.body.classList.contains('st-wide');
    if (card && source === 'preview' && (wide || document.body.classList.contains('place-air'))) {
      var ta = card.querySelector('textarea');
      if (ta) ta.focus();
    }
    if (document.body.classList.contains('place-design') || wide) {
      var sub = currentSubtab();
      if (source === 'preview' && (sub === 'look' || sub === 'presets')) setSubtab('element');
    }
    inspector.point(id);
    if (changed) refresh();
  }
  function clearSelection() {
    if (!selectedId) return;
    selectedId = null;
    inspector.point(null);
    refresh();
    paintHits();
  }
  function walkSelection(dir) {
    var list = ordered();
    if (!list.length) return;
    var i = -1;
    for (var k = 0; k < list.length; k++) if (list[k].id === selectedId) i = k;
    var n = (i + dir + list.length) % list.length;
    select(list[n].id, 'key');
    var card = document.querySelector('#st-cue .st-card[data-id="' + list[n].id + '"] textarea');
    if (card) card.focus();
  }

  /* --------------------------------------------------------- cue sheet
     The operator's rundown: one card per element, text and eye only. */
  var cueSig = null, cueSyncs = [];
  var expandedLines = {};
  function cueSignature() {
    return elements().map(function (e) {
      return [e.id, e.kind, e.place.row, e.place.col, e.place.order, e.place.spanAll ? 1 : 0].join(':');
    }).join('|');
  }
  function renderCue(force) {
    var host = $('#st-cue');
    if (!host || !S) return;
    var sig = cueSignature();
    if (!force && sig === cueSig) { cueSyncs.forEach(function (f) { f(); }); return; }
    /* rebuilding under the cursor: remember where the caret was and put it back */
    var keep = null, ae = document.activeElement;
    if (isField(ae) && host.contains(ae)) {
      if (composing) return;                       /* never mid-IME; the next broadcast retries */
      var card0 = ae.closest ? ae.closest('.st-card') : null;
      keep = { id: card0 && card0.dataset.id, tag: ae.tagName, s: ae.selectionStart, e: ae.selectionEnd, scroll: host.scrollTop };
    }
    cueSig = sig;
    host.innerHTML = '';
    cueSyncs = [];
    var list = ordered();
    if (!list.length) { host.appendChild(el('div', 'st-empty', 'No elements — add one in DESIGN › LAYOUT')); return; }
    var lastGroup = null;
    list.forEach(function (e) {
      var grp = e.place.spanAll ? 'full' : String(e.place.row);
      if (grp !== lastGroup) {
        if (grp === 'full') host.appendChild(el('div', 'st-rowlbl', 'FULL HEIGHT'));
        else if (lastGroup !== null || list.length > 1) host.appendChild(el('div', 'st-rowlbl', 'ROW ' + (e.place.row + 1)));
        lastGroup = grp;
      }
      var c = cueCard(e);
      host.appendChild(c.card);
      cueSyncs.push(c.sync);
    });
    cueSyncs.forEach(function (f) { f(); });
    if (keep && keep.id) {
      var back = host.querySelector('.st-card[data-id="' + keep.id + '"] ' + (keep.tag === 'TEXTAREA' ? 'textarea' : 'input'));
      if (back) {
        back.focus();
        try { if (keep.tag === 'TEXTAREA') back.setSelectionRange(keep.s, keep.e); } catch (e2) { /* ignore */ }
      }
      host.scrollTop = keep.scroll;
    }
  }
  function cueCard(e) {
    var id = e.id;
    var card = el('div', 'st-card');
    card.dataset.id = id;
    card.classList.toggle('sel', id === selectedId);
    var head = el('div', 'st-card-head');
    var eye = el('input', 'st-eye'); eye.type = 'checkbox'; eye.title = 'Show this element';
    eye.addEventListener('change', function () { sendEl(id, 'enabled', eye.checked); });
    head.appendChild(eye);
    var thumb = null, thumbV = null;
    if (e.kind === 'image') {
      thumb = el('img', 'st-thumb'); thumb.alt = '';
      thumbV = el('div', 'st-thumb-v', '▶');
      head.appendChild(thumb); head.appendChild(thumbV);
    }
    var name = el('span', 'st-card-name');
    var pos = el('span', 'st-pos');
    var dotDiff = el('span', 'st-dotm st-diff'), dotAir = el('span', 'st-dotm st-onair');
    head.appendChild(name); head.appendChild(pos); head.appendChild(dotDiff); head.appendChild(dotAir);
    var nextBtn = null, lines = null, ta = null;
    if (e.kind === 'text') {
      nextBtn = el('button', 'st-next', '▸');
      nextBtn.title = 'NEXT: cue the saved line after the current one';
      head.appendChild(nextBtn);
    }
    card.appendChild(head);
    if (e.kind === 'text') {
      ta = el('textarea', 'st-cue-text');
      ta.rows = 1; ta.setAttribute('dir', 'auto');
      ta.addEventListener('input', function () { sendEl(id, 'text', ta.value); grow(); });
      ta.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); transport.arm(); return; }
        if (ev.key === 'ArrowDown' && ta.selectionStart === ta.value.length) {
          var first = lines && lines.node.querySelector('.st-line[tabindex]:not(.st-hidden)');
          if (first) { ev.preventDefault(); first.focus(); }
        }
      });
      card.appendChild(ta);
      lines = buildLines(id, ta, { limit: document.body.classList.contains('st-wide') ? 12 : 6 });
      card.appendChild(lines.node);
      nextBtn.addEventListener('click', function () { lines.next(); });
    }
    function grow() {
      ta.style.height = 'auto';
      var lh = parseFloat(getComputedStyle(ta).lineHeight) || 19;
      ta.style.height = Math.min(ta.scrollHeight, lh * 3 + 14) + 'px';
    }
    card.addEventListener('focusin', function () { if (selectedId !== id) select(id, 'cue'); });
    card.addEventListener('pointerdown', function () { if (selectedId !== id) select(id, 'cue'); });
    function sync() {
      var cur = findEl(id);
      if (!cur) return;
      if (eye !== document.activeElement) eye.checked = cur.enabled !== false;
      var label = cur.name || (cur.kind === 'image' ? 'Image' : 'Text');
      if (name.textContent !== label) name.textContent = label;
      var where = posTag(cur);
      if (pos.textContent !== where) pos.textContent = where;
      card.classList.toggle('st-off', cur.enabled === false);
      var tags = diffRes.byId[id];
      dotDiff.style.display = tags ? '' : 'none';
      dotDiff.title = tags ? tags.join(', ') : '';
      dotAir.style.display = (S.visible && !tags && liveEl(id)) ? '' : 'none';
      dotAir.title = 'on air';
      if (thumb) {
        var u = (cur.image && cur.image.url) || '';
        var v = isVideoUrl(u);
        thumb.style.display = v ? 'none' : '';
        thumbV.style.display = v ? '' : 'none';
        if (!v && thumb.getAttribute('src') !== u) thumb.src = u;
      }
      if (ta && ta !== document.activeElement && ta.value !== (cur.text || '')) { ta.value = cur.text || ''; grow(); }
      if (nextBtn) nextBtn.style.display = snippetsOf(id).length ? '' : 'none';
      if (lines) lines.sync();
    }
    return { card: card, sync: sync };
  }

  /* ------------------------------------------------------ saved lines
     Numbered full-width rows: readable Hebrew at 320px, a cued outline on
     the row that is in NEXT, an on-air dot on the one that is live. */
  function buildLines(elId, ta, opts) {
    var id = elId;
    var wrap = el('div', 'st-lines');
    var lastSig = null, rows = [];
    var limit = (opts && opts.limit) || 6;

    function current() { var e = findEl(id); return e ? (e.text || '') : ''; }
    function render() {
      var list = snippetsOf(id);
      var sig = list.map(function (x) { return x.id + ':' + x.label; }).join('|') + '|' + (expandedLines[id] ? 1 : 0);
      if (sig === lastSig) return;
      lastSig = sig;
      wrap.innerHTML = ''; rows = [];
      list.forEach(function (sn, i) {
        var r = el('div', 'st-line');
        r.tabIndex = 0;
        r.dataset.sid = sn.id;
        r.appendChild(el('span', 'st-line-num', String(i + 1)));
        var lbl = el('span', 'st-line-lbl', sn.label || sn.text || '—');
        lbl.setAttribute('dir', 'auto'); lbl.title = sn.text || '';
        r.appendChild(lbl);
        var dot = el('span', 'st-dotm st-onair'); dot.title = 'on air'; dot.style.display = 'none';
        r.appendChild(dot);
        var more = el('button', 'st-line-more', '⋯'); more.title = 'Rename or delete';
        more.addEventListener('click', function (ev) { ev.stopPropagation(); openMenu(r, sn, lbl); });
        r.appendChild(more);
        var pressT = null, px = 0, py = 0;
        r.addEventListener('pointerdown', function (ev) {
          px = ev.clientX; py = ev.clientY;
          pressT = setTimeout(function () { pressT = null; openMenu(r, sn, lbl); }, 500);
        });
        r.addEventListener('pointermove', function (ev) { if (pressT && (Math.abs(ev.clientX - px) > 6 || Math.abs(ev.clientY - py) > 6)) { clearTimeout(pressT); pressT = null; } });
        r.addEventListener('pointerup', function () { if (pressT) { clearTimeout(pressT); pressT = null; } });
        r.addEventListener('click', function (ev) {
          if (r.classList.contains('st-menu-open')) return;
          send({ type: 'snippet-load', id: id, snippetId: sn.id });
        });
        r.addEventListener('keydown', function (ev) {
          var vis = rows.filter(function (x) { return !x.classList.contains('st-hidden') && x.tabIndex === 0; });
          var i2 = vis.indexOf(r);
          if (ev.key === 'ArrowDown' && vis[i2 + 1]) { ev.preventDefault(); vis[i2 + 1].focus(); }
          else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (vis[i2 - 1]) vis[i2 - 1].focus(); else if (ta) ta.focus(); }
          else if (ev.key === 'Enter') { ev.preventDefault(); send({ type: 'snippet-load', id: id, snippetId: sn.id }); }
          else if (ev.key === 'Escape') { ev.preventDefault(); if (ta) ta.focus(); }
        });
        r._sn = sn; r._dot = dot;
        rows.push(r);
        wrap.appendChild(r);
      });
      if (list.length > limit) {
        var moreRow = el('div', 'st-line st-more', expandedLines[id] ? 'show fewer' : 'show all ' + list.length);
        moreRow.addEventListener('click', function () { expandedLines[id] = !expandedLines[id]; lastSig = null; render(); sync(); });
        wrap.appendChild(moreRow);
      }
      var hint = el('div', 'st-line-hint st-nomatch', 'no saved text matches'); hint.style.display = 'none';
      wrap.appendChild(hint);
      var save = el('div', 'st-line st-save', '＋ save this wording');
      save.title = 'Save this element’s current text so you can recall it later';
      save.addEventListener('click', function () {
        var text = current();
        if (!text.trim()) return;
        send({ type: 'snippet-save', id: id, label: text.slice(0, 40), text: text });
      });
      wrap.appendChild(save);
    }
    function openMenu(r, sn, lbl) {
      if (r.classList.contains('st-menu-open')) return;
      r.classList.add('st-menu-open');
      var saved = [];
      while (r.firstChild) { saved.push(r.firstChild); r.removeChild(r.firstChild); }
      var menu = el('div', 'st-line-menu');
      var ren = el('button', null, 'Rename');
      var delB = armed(el('button', null, 'Delete'), { label: 'Delete', armedLabel: 'Delete?', ms: 2500, danger: true,
        fire: function () { send({ type: 'snippet-delete', id: id, snippetId: sn.id }); } });
      var cancel = el('button', null, 'cancel');
      function close() { r.innerHTML = ''; saved.forEach(function (n) { r.appendChild(n); }); r.classList.remove('st-menu-open'); }
      cancel.addEventListener('click', function (ev) { ev.stopPropagation(); close(); });
      ren.addEventListener('click', function (ev) {
        ev.stopPropagation();
        r.innerHTML = '';
        var inp = el('input', 'st-line-rename'); inp.value = sn.label || ''; inp.setAttribute('dir', 'auto');
        inp.addEventListener('keydown', function (ke) {
          if (ke.key === 'Enter') { ke.preventDefault(); send({ type: 'snippet-rename', id: id, snippetId: sn.id, label: inp.value.trim().slice(0, 60) }); close(); }
          else if (ke.key === 'Escape') { ke.preventDefault(); close(); }
        });
        inp.addEventListener('click', function (ce) { ce.stopPropagation(); });
        r.appendChild(inp); inp.focus(); inp.select();
      });
      menu.appendChild(ren); menu.appendChild(delB); menu.appendChild(cancel);
      r.appendChild(menu);
    }
    function sync() {
      render();
      var cur = current();
      var live = liveEl(id);
      var filtering = ta && ta === document.activeElement && !snippetsOf(id).some(function (x) { return x.text === cur; });
      var q = filtering ? cur.toLowerCase() : '';
      var shown = 0, anyMatch = false;
      rows.forEach(function (r) {
        var sn = r._sn;
        r.classList.toggle('st-cued', sn.text === cur);
        r._dot.style.display = (S.visible && live && sn.text === live.text) ? '' : 'none';
        var match = !q || (String(sn.label || '') + ' ' + String(sn.text || '')).toLowerCase().indexOf(q) >= 0;
        if (match) anyMatch = true;
        var collapsed = !expandedLines[id] && shown >= limit;
        var hide = !match || (match && collapsed);
        if (match) shown++;
        r.classList.toggle('st-hidden', hide);
      });
      var nm = wrap.querySelector('.st-nomatch');
      if (nm) nm.style.display = (q && !anyMatch) ? '' : 'none';
    }
    function next() {
      var list = snippetsOf(id);
      if (!list.length) return;
      var cur = current();
      var i = -1;
      for (var k = 0; k < list.length; k++) if (list[k].text === cur) i = k;
      var target = list[(i + 1) % list.length];
      if (i === -1) note('No saved line matched — started from line 1');
      send({ type: 'snippet-load', id: id, snippetId: target.id });
    }
    render(); sync();
    return { node: wrap, sync: sync, next: next };
  }


  /* =============================== ported from control.js =============================== */

  var REPLACING = { revert: 1, 'preset-load': 1, 'snippet-load': 1, 'reset-style': 1, 'preset-restore': 1 };

  var throttleTimers = {};

  var inFlight = {};

  var lastSent = {};

  var A_STYLES = [
    { v: 'slide-up', l: 'Slide up' },
    { v: 'slide-side', l: 'Slide from side' },
    { v: 'wipe', l: 'Wipe' },
    { v: 'fade', l: 'Fade' },
    { v: 'pop', l: 'Pop' },
  ];

  var ALIGNS = [{ v: 'auto', l: 'Auto' }, { v: 'start', l: 'Start' }, { v: 'center', l: 'Center' }, { v: 'end', l: 'End' }];

  var FITS = [{ v: 'cover', l: 'Cover (fill)' }, { v: 'contain', l: 'Contain' }, { v: 'stretch', l: 'Stretch' }, { v: 'tile', l: 'Tile' }];

  var GLOBAL_FIELDS = [
    { sec: 'layout', type: 'select', label: 'Direction', options: [{ v: 'auto', l: 'Auto detect' }, { v: 'rtl', l: 'RTL ←' }, { v: 'ltr', l: 'LTR →' }], get: g('style.direction'), set: s('style.direction') },
    { sec: 'layout', type: 'select', label: 'Default text align', options: [{ v: 'start', l: 'Start' }, { v: 'center', l: 'Center' }, { v: 'end', l: 'End' }], get: g('style.textAlign'), set: s('style.textAlign') },
    { sec: 'layout', type: 'toggle', label: 'Full width', get: g('style.layout.fullWidth'), set: s('style.layout.fullWidth') },
    { sec: 'layout', type: 'select', label: 'Anchor', options: [{ v: 'left', l: 'Left' }, { v: 'center', l: 'Center' }, { v: 'right', l: 'Right' }], showIf: notFullWidth, get: g('style.layout.anchor'), set: s('style.layout.anchor') },
    { sec: 'layout', type: 'slider', label: 'Max width', min: 20, max: 100, step: 1, unit: '%', showIf: notFullWidth, get: g('style.layout.maxWidth'), set: s('style.layout.maxWidth') },
    { sec: 'layout', type: 'slider', label: 'Side margin', min: 0, max: 300, step: 2, unit: 'px', get: g('style.layout.sideMargin'), set: s('style.layout.sideMargin') },
    { sec: 'layout', type: 'slider', label: 'Bottom margin', min: 0, max: 400, step: 2, unit: 'px', get: g('style.layout.bottomMargin'), set: s('style.layout.bottomMargin') },
    { sec: 'layout', type: 'slider', label: 'Gap', min: 0, max: 40, step: 1, unit: 'px', get: g('style.gap'), set: s('style.gap') },

    { sec: 'type', type: 'text', label: 'Default font stack', title: 'Used by every element that has no font of its own', get: g('style.font.family'), set: s('style.font.family') },
    { sec: 'type', type: 'text', label: 'Font CSS URL', placeholder: 'https://fonts.googleapis.com/css2?family=Heebo…', get: g('style.font.customCssUrl'), set: s('style.font.customCssUrl') },

    { sec: 'edges', type: 'select', label: 'Edge style', options: [{ v: 'square', l: 'Square' }, { v: 'rounded', l: 'Rounded' }, { v: 'chamfer', l: 'Slanted' }, { v: 'chevron', l: 'Chevron' }], get: g('style.edges.style'), set: s('style.edges.style') },
    { sec: 'edges', type: 'slider', label: 'Corner radius', min: 0, max: 60, step: 1, unit: 'px', get: g('style.edges.radius'), set: s('style.edges.radius') },
    { sec: 'edges', type: 'slider', label: 'Slant / chevron depth', min: 0, max: 80, step: 1, unit: 'px', get: g('style.edges.chamfer'), set: s('style.edges.chamfer') },
    { sec: 'edges', type: 'slider', label: 'Shadow', min: 0, max: 100, step: 1, get: g('style.shadow'), set: s('style.shadow') },

    { sec: 'anim', type: 'toggle', label: 'Enable animations', title: 'Off = changes appear instantly, with no motion', get: g('anim.enabled'), set: s('anim.enabled') },
    { sec: 'anim', type: 'select', label: 'In animation', options: A_STYLES, get: g('anim.inStyle'), set: s('anim.inStyle') },
    { sec: 'anim', type: 'select', label: 'Out animation', options: [{ v: 'auto', l: 'Auto (reverse in)' }].concat(A_STYLES), get: g('anim.outStyle'), set: s('anim.outStyle') },
    { sec: 'anim', type: 'select', label: 'Text change', options: [{ v: 'slide-swap', l: 'Slide swap' }, { v: 'crossfade', l: 'Crossfade' }, { v: 'instant', l: 'Instant' }], get: g('anim.changeStyle'), set: s('anim.changeStyle') },
    { sec: 'anim', type: 'select', label: 'Easing', options: [{ v: 'snappy', l: 'Snappy' }, { v: 'smooth', l: 'Smooth' }, { v: 'bouncy', l: 'Bouncy' }, { v: 'linear', l: 'Linear' }], get: g('anim.easing'), set: s('anim.easing') },
    { sec: 'anim', type: 'slider', label: 'In duration', min: 100, max: 2000, step: 50, unit: 'ms', get: g('anim.inMs'), set: s('anim.inMs') },
    { sec: 'anim', type: 'slider', label: 'Out duration', min: 100, max: 2000, step: 50, unit: 'ms', get: g('anim.outMs'), set: s('anim.outMs') },
    { sec: 'anim', type: 'slider', label: 'Change duration', min: 100, max: 1500, step: 50, unit: 'ms', get: g('anim.changeMs'), set: s('anim.changeMs') },
    { sec: 'anim', type: 'slider', label: 'Stagger', min: 0, max: 400, step: 10, unit: 'ms', get: g('anim.staggerMs'), set: s('anim.staggerMs') },
    { sec: 'anim', type: 'slider', label: 'Auto-hide (s)', min: 0, max: 120, step: 1, title: '0 = stay until you press HIDE', get: g('anim.autoHideSec'), set: s('anim.autoHideSec') },

    { sec: 'obs', type: 'toggle', label: 'Connect to OBS', showIf: function () { return !NATIVE; }, get: g('settings.obs.enabled'), set: s('settings.obs.enabled') },
    { sec: 'obs', type: 'text', label: 'Host', lazy: true, showIf: function () { return !NATIVE; }, get: g('settings.obs.host'), set: s('settings.obs.host') },
    { sec: 'obs', type: 'number', label: 'Port', lazy: true, showIf: function () { return !NATIVE; }, get: g('settings.obs.port'), set: s('settings.obs.port') },
    { sec: 'obs', type: 'password', label: 'Password', lazy: true, showIf: function () { return !NATIVE; }, get: g('settings.obs.password'), set: s('settings.obs.password') },
    { sec: 'obs', type: 'number', label: 'Server port', lazy: true, title: 'Applied the next time OBS starts', showIf: function () { return NATIVE; }, get: g('settings.server.port'), set: s('settings.server.port') },
    { sec: 'obs', type: 'toggle', label: 'Update on Transition', get: g('settings.obs.commitOnTransition'), set: s('settings.obs.commitOnTransition') },
    { sec: 'obs', type: 'toggle', label: 'Only in Studio Mode', get: g('settings.obs.onlyStudioMode'), set: s('settings.obs.onlyStudioMode') },
    { sec: 'obs', type: 'select', label: 'Transition does', options: [{ v: 'take', l: 'Update what is on air' }, { v: 'take-show', l: 'Update, and show if hidden' }], get: g('settings.obs.transitionAction'), set: s('settings.obs.transitionAction') },
  ];

  function nestedPatch(key, value) {
    var parts = key.split('.');
    var patch = {};
    var cur = patch;
    for (var i = 0; i < parts.length - 1; i++) { cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = value;
    return patch;
  }

  function dig(obj, path) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === undefined || cur === null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function poke(obj, path, value) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] === undefined || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function rootFor(path) {
    if (path.indexOf('anim.') === 0) return { obj: S.anim, key: path.slice(5), kind: 'anim' };
    if (path.indexOf('settings.') === 0) return { obj: S.settings, key: path.slice(9), kind: 'settings' };
    return { obj: S.pending, key: path, kind: 'edit' };
  }

  function getVal(path) {
    if (!S) return undefined;
    var r = rootFor(path);
    return dig(r.obj, r.key);
  }

  function markInFlight(kind, id, path, value) {
    inFlight[(id || '') + '|' + path] = { kind: kind, id: id, path: path, value: value };
  }

  function clearInFlight(key) { delete inFlight[key]; }

  function clearAllInFlight() { inFlight = {}; }

  function reapplyInFlight() {
    Object.keys(inFlight).forEach(function (k) {
      var f = inFlight[k];
      if (f.kind === 'element') {
        var e = findEl(f.id);
        if (e) poke(e, f.path, f.value);
      } else {
        var r = rootFor(f.path);
        poke(r.obj, r.key, f.value);
      }
    });
  }

  function throttled(key, fn) {
    var now = Date.now();
    var since = now - (lastSent[key] || 0);
    if (since >= 60 && !throttleTimers[key]) {
      lastSent[key] = now;
      fn();
      return;
    }
    if (throttleTimers[key]) clearTimeout(throttleTimers[key]);
    throttleTimers[key] = setTimeout(function () {
      delete throttleTimers[key];
      lastSent[key] = Date.now();
      fn();
    }, Math.max(0, 60 - since));
  }

  function sendField(path, value) {
    var r = rootFor(path);
    poke(r.obj, r.key, value);            // optimistic, so the UI feels instant
    markInFlight('global', null, path, value);
    throttled(path, function () {
      clearInFlight('|' + path);
      send({ type: r.kind, patch: nestedPatch(r.key, value) });
    });
    refresh();
  }

  function elements() { return (S && S.pending && S.pending.elements) || []; }

  function findEl(id) {
    return elements().filter(function (e) { return e.id === id; })[0];
  }

  function snippetsOf(id) {
    var all = (S && S.snippets) || {};
    return Array.isArray(all[id]) ? all[id] : [];
  }

  function sendEl(id, path, value) {
    var e = findEl(id);
    if (!e) return;
    poke(e, path, value);                 // optimistic
    markInFlight('element', id, path, value);
    var key = id + '|' + path;
    throttled(key, function () {
      clearInFlight(key);
      send({ type: 'element-update', id: id, patch: nestedPatch(path, value) });
    });
    refresh();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { copyFallback(text); });
    } else copyFallback(text);
  }

  function copyFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  function fmtVal(f, v) {
    if (f.unit === '%pct') return Math.round(v * 100) + '%';
    if (f.unit === '×') return (+v).toFixed(2) + '×';
    return v + (f.unit || '');
  }

  function makeRow(spec) {
    var row = el('div', 'row');
    if (spec.type === 'subhead') {
      row.className = 'subhead';
      row.textContent = spec.label;
      return { row: row, sync: function () {} };
    }
    var lbl = el('label', 'lbl', spec.label);
    if (spec.title) { lbl.title = spec.title; row.title = spec.title; }
    row.appendChild(lbl);
    var ctl = el('div', 'ctl');
    row.appendChild(ctl);

    var input, valEl, thumb;

    if (spec.type === 'toggle') {
      input = el('input');
      input.type = 'checkbox';
      input.addEventListener('change', function () { spec.set(input.checked); if (spec.rebuild) refresh(); });
    } else if (spec.type === 'select') {
      input = el('select');
      spec.options.forEach(function (o) {
        var opt = el('option');
        opt.value = o.v; opt.textContent = o.l;
        input.appendChild(opt);
      });
      input.addEventListener('change', function () { spec.set(input.value); if (spec.rebuild) refresh(); });
    } else if (spec.type === 'slider') {
      input = el('input');
      input.type = 'range';
      input.min = spec.min; input.max = spec.max; input.step = spec.step;
      valEl = el('span', 'val');
      input.addEventListener('input', function () {
        var v = parseFloat(input.value);
        spec.set(v);
        valEl.textContent = fmtVal(spec, v);
      });
      ctl.appendChild(input);
      ctl.appendChild(valEl);
    } else if (spec.type === 'color') {
      input = el('input');
      input.type = 'color';
      input.addEventListener('input', function () { spec.set(input.value); });
    } else if (spec.type === 'fontpick') {
      input = el('input');
      input.type = 'text';
      input.setAttribute('list', 'st-fontlist');
      input.placeholder = spec.placeholder || '(default font)';
      input.addEventListener('change', function () { spec.set(input.value.trim()); });
      var clr = el('button', null, '⟲');
      clr.title = 'Use the default font';
      clr.addEventListener('click', function () { input.value = ''; spec.set(''); });
      ctl.appendChild(input);
      ctl.appendChild(clr);
    } else if (spec.type === 'imagepick') {
      thumb = el('img', 'pick-thumb');
      thumb.alt = '';
      input = el('input');
      input.type = 'text';
      input.placeholder = 'image URL or upload →';
      input.addEventListener('change', function () { spec.set(input.value); });
      var up = el('button', null, '📁');
      up.title = 'Upload an image file';
      up.addEventListener('click', function () { pickImage(spec.set); });
      ctl.appendChild(thumb);
      ctl.appendChild(input);
      ctl.appendChild(up);
    } else {
      input = el('input');
      input.type = spec.type === 'number' ? 'number' : (spec.type === 'password' ? 'password' : 'text');
      if (spec.placeholder) input.placeholder = spec.placeholder;
      input.addEventListener(spec.lazy ? 'change' : 'input', function () {
        spec.set(spec.type === 'number' ? (parseFloat(input.value) || 0) : input.value);
      });
    }

    if (spec.type !== 'slider' && spec.type !== 'imagepick' && spec.type !== 'fontpick') ctl.appendChild(input);

    function sync() {
      var vis = !spec.showIf || !!spec.showIf();
      row.classList.toggle('hidden-row', !vis);
      if (!vis) return;
      var v = spec.get();
      if (v === undefined) return;
      if (input !== document.activeElement) {
        if (spec.type === 'toggle') input.checked = !!v;
        else input.value = v;
      }
      if (valEl) valEl.textContent = fmtVal(spec, parseFloat(v) || 0);
      if (thumb) thumb.src = v || '';
    }
    return { row: row, sync: sync };
  }

  function pickImage(setter) {
    pendingImageSetter = setter;
    $('#st-logo-file').click();
  }

  function gradientCss(g) {
    var stops = (g.stops || []).slice().sort(function (a, b) { return a.pos - b.pos; })
      .map(function (s) { return hexA(s.color, s.opacity) + ' ' + s.pos + '%'; }).join(', ');
    if (!stops) return 'transparent';
    if (g.type === 'radial') return 'radial-gradient(' + (g.shape === 'circle' ? 'circle' : 'ellipse') + ' at ' + g.posX + '% ' + g.posY + '%, ' + stops + ')';
    if (g.type === 'conic') return 'conic-gradient(from ' + g.angle + 'deg at ' + g.posX + '% ' + g.posY + '%, ' + stops + ')';
    return 'linear-gradient(' + g.angle + 'deg, ' + stops + ')';
  }

  function hexA(hex, op) {
    var h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return hex;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' +
      (op === undefined ? 1 : op) + ')';
  }

  function buildGradientEditor(elem) {
    var id = elem.id;
    var wrap = el('div', 'grad-editor');

    var strip = el('div', 'grad-strip');
    strip.title = 'Click to add a colour stop — drag stops to move them';
    var handles = el('div', 'grad-handles');
    strip.appendChild(handles);
    wrap.appendChild(strip);

    var list = el('div', 'grad-stop-list');
    wrap.appendChild(list);

    var addBtn = el('button', 'link-btn', '＋ add colour stop');
    addBtn.addEventListener('click', function () {
      var g = gradOf();
      var stops = g.stops.slice();
      stops.push({ color: stops.length ? stops[stops.length - 1].color : '#ffffff', pos: 50, opacity: 1 });
      setStops(stops);
    });
    wrap.appendChild(addBtn);

    function gradOf() {
      var e = findEl(id);
      return (e && e.style && e.style.gradient) || { stops: [], type: 'linear', angle: 180, posX: 50, posY: 50 };
    }
    function setStops(stops) {
      sendEl(id, 'style.gradient.stops', stops);
      render();
    }

    strip.addEventListener('click', function (ev) {
      if (ev.target !== strip && ev.target !== handles) return;
      var r = strip.getBoundingClientRect();
      var pos = Math.round(Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100)));
      var g = gradOf();
      var stops = g.stops.slice();
      stops.push({ color: sampleAt(g, pos), pos: pos, opacity: 1 });
      setStops(stops);
    });

    /* colour of the nearest stop, so a new stop starts sensibly */
    function sampleAt(g, pos) {
      var best = null, bestD = 1e9;
      (g.stops || []).forEach(function (s) {
        var d = Math.abs(s.pos - pos);
        if (d < bestD) { bestD = d; best = s; }
      });
      return best ? best.color : '#ffffff';
    }

    var dragging = false;
    var rows = [];        // per stop: {handle, color, pos, op}

    function paintStrip(stops) {
      strip.style.background = gradientCss({ type: 'linear', angle: 90, stops: stops });
    }

    function editStop(i, patch) {
      var stops = gradOf().stops.slice();
      if (!stops[i]) return null;
      stops[i] = {
        color: patch.color !== undefined ? patch.color : stops[i].color,
        pos: patch.pos !== undefined ? patch.pos : stops[i].pos,
        opacity: patch.opacity !== undefined ? patch.opacity : stops[i].opacity,
      };
      sendEl(id, 'style.gradient.stops', stops);
      return stops;
    }

    /* build the handles and rows once per stop COUNT */
    function build() {
      var g = gradOf();
      handles.innerHTML = '';
      list.innerHTML = '';
      rows = [];

      g.stops.forEach(function (s, i) {
        var h = el('div', 'grad-handle');
        h.addEventListener('pointerdown', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          dragging = true;
          h.setPointerCapture(ev.pointerId);
          var r = strip.getBoundingClientRect();
          function move(e2) {
            var pos = Math.round(Math.max(0, Math.min(100, ((e2.clientX - r.left) / r.width) * 100)));
            var stops = editStop(i, { pos: pos });
            if (!stops) return;
            h.style.left = pos + '%';
            h.title = pos + '%';
            if (rows[i] && rows[i].pos !== document.activeElement) rows[i].pos.value = pos;
            paintStrip(stops);
          }
          function up() {
            dragging = false;
            try { h.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
            h.removeEventListener('pointermove', move);
            h.removeEventListener('pointerup', up);
            h.removeEventListener('pointercancel', up);
            sync();
          }
          h.addEventListener('pointermove', move);
          h.addEventListener('pointerup', up);
          /* touch/pen drags can be cancelled (palm rejection, scroll takeover);
             without this the editor would stay frozen forever */
          h.addEventListener('pointercancel', up);
        });
        handles.appendChild(h);

        var row = el('div', 'grad-stop-row');
        var c = el('input'); c.type = 'color';
        c.addEventListener('input', function () { paintStrip(editStop(i, { color: c.value }) || []); });

        var pos = el('input');
        pos.type = 'range'; pos.min = 0; pos.max = 100; pos.step = 1; pos.title = 'position';
        pos.addEventListener('input', function () {
          var stops = editStop(i, { pos: parseInt(pos.value, 10) });
          if (stops) { paintStrip(stops); h.style.left = pos.value + '%'; }
        });

        var op = el('input');
        op.type = 'range'; op.min = 0; op.max = 1; op.step = 0.01; op.title = 'opacity';
        op.addEventListener('input', function () {
          var stops = editStop(i, { opacity: parseFloat(op.value) });
          if (stops) paintStrip(stops);
        });

        var del = el('button', 'preset-mini', '✕');
        del.title = 'Remove this stop';
        del.addEventListener('click', function () {
          var stops = gradOf().stops.slice();
          if (stops.length <= 2) return;   // a gradient needs at least two
          stops.splice(i, 1);
          setStops(stops);
        });

        row.appendChild(c); row.appendChild(pos); row.appendChild(op); row.appendChild(del);
        list.appendChild(row);
        rows.push({ handle: h, color: c, pos: pos, op: op });
      });
      sync();
    }

    /* push current values into the existing controls, never while dragging
       and never into the control the user is holding */
    function sync() {
      if (dragging) return;
      var g = gradOf();
      if (g.stops.length !== rows.length) { build(); return; }
      paintStrip(g.stops);
      g.stops.forEach(function (s, i) {
        var r = rows[i];
        if (!r) return;
        r.handle.style.left = s.pos + '%';
        r.handle.style.background = hexA(s.color, s.opacity);
        r.handle.title = s.pos + '%';
        if (r.color !== document.activeElement) r.color.value = s.color;
        if (r.pos !== document.activeElement) r.pos.value = s.pos;
        if (r.op !== document.activeElement) r.op.value = s.opacity === undefined ? 1 : s.opacity;
      });
    }

    function setStops(stops) {
      sendEl(id, 'style.gradient.stops', stops);
      build();
    }

    build();
    return { node: wrap, sync: sync };
  }

  function probeArtwork(url, done) {
    if (!url) return done(null);
    if (shapeCache[url]) return done(shapeCache[url]);
    function finish(res) { shapeCache[url] = res; done(res); }
    if (/\.(mp4|webm|mov|m4v|ogv)$/i.test(String(url).split('?')[0])) {
      return finish({ kind: 'video' });
    }
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return finish({ kind: 'error' });
      /* Rasterise at a size that keeps enough ROWS to read a profile from — a
         wide, short banner scaled by its long side keeps a dozen rows and the
         measurement falls apart. Cap the area so a huge file stays cheap. */
      var sc = Math.min(1, Math.sqrt(160000 / (w * h)));
      var cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
      var cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      var ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, cw, ch);
      var data;
      try {
        data = ctx.getImageData(0, 0, cw, ch).data;
      } catch (err) {
        return finish({ kind: 'opaque', unreadable: true });
      }
      var A = function (x, y) { return data[((y * cw) + x) * 4 + 3]; };

      /* tight bounds of everything that is not fully transparent */
      var x0 = cw, y0 = ch, x1 = -1, y1 = -1, clear = 0, total = cw * ch;
      for (var y = 0; y < ch; y++) {
        for (var x = 0; x < cw; x++) {
          if (A(x, y) > 16) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          } else { clear++; }
        }
      }
      if (x1 < 0) return finish({ kind: 'empty' });
      var transparent = clear / total;
      if (transparent < 0.02) return finish({ kind: 'opaque', w: w, h: h });

      var toX = w / cw, toY = h / ch;                 /* back to source pixels, per axis */
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      var res = {
        kind: 'shape',
        w: w, h: h,
        transparent: transparent,
        box: { x: Math.round(x0 * toX), y: Math.round(y0 * toY), w: Math.round(bw * toX), h: Math.round(bh * toY) },
        margin: Math.round(Math.min(x0 * toX, (cw - 1 - x1) * toX, y0 * toY, (ch - 1 - y1) * toY)),
      };
      if (bh < 6) return finish(res);                 /* too few rows to read a profile */

      /* ink extent on one row, within the bounds; -1 when the row is empty */
      function span(y) {
        var lo = -1, hi = -1;
        for (var x = x0; x <= x1; x++) {
          if (A(x, y) > 16) { if (lo < 0) lo = x; hi = x; }
        }
        return { lo: lo, hi: hi };
      }
      var rows = [];
      for (var yy = y0; yy <= y1; yy++) rows.push(span(yy));
      /* a gap through the artwork (a split row) is not a shape we can read */
      for (var ri = 0; ri < rows.length; ri++) if (rows[ri].lo < 0) return finish(res);

      var endHi = (rows[0].hi + rows[rows.length - 1].hi) / 2;
      var endLo = (rows[0].lo + rows[rows.length - 1].lo) / 2;
      /* the furthest the ink reaches on each side, and on which row */
      var peakHi = -1, peakHiRow = 0, peakLo = 1e9, peakLoRow = 0;
      rows.forEach(function (r, i) {
        if (r.hi > peakHi) { peakHi = r.hi; peakHiRow = i; }
        if (r.lo < peakLo) { peakLo = r.lo; peakLoRow = i; }
      });
      var pointsRightBy = peakHi - endHi;             /* >0: reaches further right mid-way */
      var pointsLeftBy = endLo - peakLo;              /* >0: reaches further left mid-way */

      /* A chevron's edge is a straight diagonal, so the reach grows LINEARLY
         from the ends to the peak: halfway up the ramp it should be about
         half. A rounded rectangle reaches full width almost at once and only
         pulls back in the last few rows — without this gate an ordinary logo
         read as a shallow chevron. Measured against the row the peak actually
         sits on, so a blunt or off-centre point still passes. */
      function ramp(side, peakRow) {
        var last = rows.length - 1;
        var nearEnd = peakRow <= last / 2 ? 0 : last;
        var half = Math.round((nearEnd + peakRow) / 2);
        var full = side === 'right' ? (peakHi - rows[nearEnd].hi) : (rows[nearEnd].lo - peakLo);
        var got = side === 'right' ? (rows[half].hi - rows[nearEnd].hi) : (rows[nearEnd].lo - rows[half].lo);
        if (full <= 0) return false;
        var r = got / full;
        return r > 0.25 && r < 0.75;
      }

      var minReach = Math.max(2, bw * 0.06);
      /* a shape must be cut BACK on the far side to be a chevron: pointed on
         both ends is an arrow or a hexagon, and notching the bars to it would
         be wrong on one side or the other */
      if (pointsRightBy > minReach && pointsLeftBy < minReach * 0.5 && ramp('right', peakHiRow)) {
        res.point = 'right';
        res.depthFrac = pointsRightBy / bw;
        res.depthFile = Math.round(pointsRightBy * toX);
      } else if (pointsLeftBy > minReach && pointsRightBy < minReach * 0.5 && ramp('left', peakLoRow)) {
        res.point = 'left';
        res.depthFrac = pointsLeftBy / bw;
        res.depthFile = Math.round(pointsLeftBy * toX);
      } else if (pointsRightBy > minReach && pointsLeftBy > minReach &&
                 ramp('right', peakHiRow) && ramp('left', peakLoRow)) {
        /* a real arrowhead or hexagon — a rounded rectangle also reaches
           further mid-way on both sides, but not along a straight ramp */
        res.doublePointed = true;
      }
      finish(res);
    };
    img.onerror = function () { finish({ kind: 'error' }); };
    img.src = url;
  }

  function renderedArtworkWidth(id) {
    try {
      var fr = $('#st-pv-frame');
      var doc = fr && fr.contentDocument;
      var m = doc && doc.querySelector('.box[data-id="' + id + '"] img, .box[data-id="' + id + '"] video');
      if (!m) return 0;
      return m.getBoundingClientRect().width || 0;
    } catch (e) { return 0; }
  }

  function buildShapeFit(elem) {
    var id = elem.id;
    var wrap = el('div', 'shape-fit');
    var lastUrl = null;

    /* the bars this artwork sits between: text elements sharing its row, with
       a full-height element counting as on every row */
    function bars() {
      var me = findEl(id);
      if (!me) return [];
      return elements().filter(function (o) {
        if (o.id === id || o.kind !== 'text' || o.enabled === false) return false;
        return o.place.spanAll || me.place.spanAll || o.place.row === me.place.row;
      });
    }

    function render(info) {
      wrap.innerHTML = '';
      var me = findEl(id);
      if (!me || me.kind !== 'image' || !me.image || !me.image.url) return;
      if (!info || info.kind === 'error') { wrap.appendChild(el('div', 'hint', 'Could not read that picture.')); return; }
      if (info.kind === 'video') return;
      if (info.unreadable) {
        wrap.appendChild(el('div', 'hint',
          'Shape not readable \u2014 the picture is on another server. Upload it instead and it can be measured.'));
        return;
      }
      if (info.kind === 'empty') { wrap.appendChild(el('div', 'hint', 'That picture is fully transparent.')); return; }
      if (info.kind === 'opaque') {
        wrap.appendChild(el('div', 'hint', 'No transparency \u2014 this picture is a solid rectangle.'));
        return;
      }

      var pct = Math.min(99, Math.round(info.transparent * 100));
      var line = 'Cut-out artwork \u00b7 ' + pct + '% transparent';
      if (info.point) {
        line += ' \u00b7 points ' + info.point + ', ' + Math.round(info.depthFrac * 100) + '% of its width deep';
      } else if (info.doublePointed) {
        line += ' \u00b7 pointed at both ends';
      }
      wrap.appendChild(el('div', 'hint', line));

      var row = el('div', 'logo-add');
      if (info.point) {
        var b = el('button', null, 'Notch the bars to fit');
        b.title = 'Give the text bars on this row a chevron edge exactly as deep as this artwork\u2019s point is drawn, so it slots into them instead of sitting beside them';
        b.addEventListener('click', function () {
          var targets = bars();
          if (!targets.length) { note('No text bars on this row to notch.'); return; }
          var drawnW = renderedArtworkWidth(id);
          if (!drawnW) { note('Cannot see the artwork in the preview yet \u2014 try again in a moment.'); return; }
          /* the point's depth as it is drawn, in the overlay's own pixels */
          var depth = Math.round(info.depthFrac * drawnW);
          var clamped = Math.max(4, Math.min(80, depth));
          targets.forEach(function (o) {
            sendEl(o.id, 'style.edges.mode', 'chevron');
            sendEl(o.id, 'style.edges.chamfer', clamped);
          });
          var msg = 'Notched ' + targets.length + ' bar' + (targets.length > 1 ? 's' : '') + ' to ' + clamped + 'px.';
          if (clamped !== depth) msg += ' (Artwork point is ' + depth + 'px; the edge control stops at ' + clamped + '.)';
          note(msg);
          refresh();
        });
        row.appendChild(b);
      }
      if (info.margin > 1) {
        var t = el('button', null, 'Trim ' + info.margin + 'px margin');
        t.title = 'This picture has transparent padding baked into the file, which makes it sit smaller than its box. Scale it up to compensate.';
        t.addEventListener('click', function () {
          var cur = findEl(id);
          var scale = dig(cur || {}, 'image.scale') || 1;
          /* An ABSOLUTE target, not a multiplier on whatever the scale is now:
             a contain-fitted picture fills its box at 1x, so the scale that
             cancels the baked-in margin is simply the file-to-ink ratio. That
             makes the action idempotent — pressing it twice does not compound. */
          var grow = Math.max(info.w / Math.max(1, info.box.w), info.h / Math.max(1, info.box.h));
          var next = Math.min(3, +grow.toFixed(2));
          if (Math.abs(next - scale) < 0.005) { note('Already filling its box.'); return; }
          sendEl(id, 'image.scale', next);
          note('Scaled ' + scale + '\u00d7 \u2192 ' + next + '\u00d7 to fill the transparent margin.');
        });
        row.appendChild(t);
      }
      if (row.childNodes.length) wrap.appendChild(row);
    }

    function sync() {
      var me = findEl(id);
      var url = (me && me.image && me.image.url) || '';
      if (url === lastUrl) return;
      lastUrl = url;
      wrap.innerHTML = '';
      if (!url) return;
      probeArtwork(url, function (info) {
        if (lastUrl === url) render(info);
      });
    }
    sync();
    return { node: wrap, sync: sync };
  }

  function buildLogoSources(elem) {
    var id = elem.id;
    var wrap = el('div', 'logo-wrap');
    var MAX = 12;              // matches the cap in both state engines
    var draft = false;         // an empty slot the operator has not filled yet
    var lastSig = null;

    function sourcesOf() {
      var e = findEl(id);
      return ((e && e.image && e.image.sources) || []).map(function (x) {
        return { url: (x && x.url) || '' };
      });
    }
    function setSources(list) {
      sendEl(id, 'image.sources', list.filter(function (x) { return x.url; }).slice(0, MAX));
    }
    /* An upload finishes long after its row was built, by which time a
       removal or reorder may have shifted every index. Find the slot by the
       url it held instead of trusting the position it had. */
    function replaceUrl(was, now) {
      var next = sourcesOf();
      var k = -1;
      for (var i = 0; i < next.length; i++) if (next[i].url === was) { k = i; break; }
      if (k < 0) { setSources(next.concat([{ url: now }])); return; }
      next[k] = { url: now };
      setSources(next);
    }

    function row(src, i, list) {
      var r = el('div', 'logo-row');
      var input = el('input');
      input.type = 'text';
      input.value = src.url;
      input.placeholder = 'image / video URL';
      input.title = src.url;
      input.addEventListener('change', function () {
        if (src.url) replaceUrl(src.url, input.value);
        else if (input.value) { draft = false; setSources(sourcesOf().concat([{ url: input.value }])); }
      });
      var up = el('button', 'mini', '\ud83d\udcc1');
      up.title = 'Upload a picture or a short video for this slot';
      up.addEventListener('click', function () {
        pickImage(function (url) {
          if (src.url) replaceUrl(src.url, url);
          else { draft = false; setSources(sourcesOf().concat([{ url: url }])); }
        });
      });
      var mv = el('button', 'mini', '\u25b2');
      mv.title = 'Move this logo earlier in the rotation';
      mv.disabled = i === 0 || !src.url;
      mv.addEventListener('click', function () {
        var next = sourcesOf();
        if (i > 0 && i < next.length) {
          var t = next[i - 1]; next[i - 1] = next[i]; next[i] = t;
          setSources(next);
        }
      });
      var x = el('button', 'mini', '\u2715');
      x.title = src.url ? 'Remove this logo from the rotation' : 'Discard this empty slot';
      x.addEventListener('click', function () {
        if (!src.url) { draft = false; lastSig = null; render(); return; }
        var next = sourcesOf();
        for (var k = 0; k < next.length; k++) if (next[k].url === src.url) { next.splice(k, 1); break; }
        setSources(next);
      });
      r.appendChild(input); r.appendChild(up); r.appendChild(mv); r.appendChild(x);
      return { node: r, input: input };
    }

    function render() {
      var e = findEl(id);
      if (!e || e.kind !== 'image') { wrap.innerHTML = ''; lastSig = null; return; }
      var list = sourcesOf();
      /* rebuilding under the operator's finger swallows the click; the draft
         flag is part of the signature so adding one always redraws */
      var sig = list.map(function (x) { return x.url; }).join('|') + '|' + draft;
      if (sig === lastSig && wrap.childNodes.length) return;
      lastSig = sig;
      wrap.innerHTML = '';

      list.forEach(function (src, i) { wrap.appendChild(row(src, i, list).node); });

      var full = list.length >= MAX;
      /* the draft is an EXTRA row on top of the real ones, never a
         replacement for them */
      var draftInput = null;
      if (draft && !full) {
        var d = row({ url: '' }, list.length, list);
        wrap.appendChild(d.node);
        draftInput = d.input;
      }

      if (!list.length && !draft) {
        wrap.appendChild(el('div', 'hint', 'One logo only. Add more to rotate between them.'));
      }
      if (full) {
        wrap.appendChild(el('div', 'hint', 'Maximum ' + MAX + ' logos.'));
      }

      var addRow = el('div', 'logo-add');
      var addBtn = el('button', null, '\uff0b add logo');
      addBtn.title = 'Add another logo for this element to rotate to';
      addBtn.disabled = full;
      addBtn.addEventListener('click', function () {
        pickImage(function (url) { setSources(sourcesOf().concat([{ url: url }])); });
      });
      var addUrl = el('button', null, '\uff0b by URL');
      addUrl.title = 'Add an empty slot and type a URL into it';
      addUrl.disabled = full || draft;
      addUrl.addEventListener('click', function () { draft = true; render(); });
      addRow.appendChild(addBtn);
      addRow.appendChild(addUrl);
      wrap.appendChild(addRow);

      if (draftInput) draftInput.focus();
    }

    render();
    return { node: wrap, sync: render };
  }

  function obsHintText() {
    var st = obsStatus.status;
    if (NATIVE) {
      return 'Running inside OBS (native plugin) — the Transition button commits pending changes automatically' +
        (obsStatus.studioMode ? '. Studio Mode is ON.' : '. Enable Studio Mode in OBS to use the preview/transition workflow.');
    }
    if (st === 'off') return 'Enable to let the OBS “Transition” button put your pending changes on air. In OBS: Tools → WebSocket Server Settings → Enable, then copy the password here.';
    if (st === 'connected') return 'Connected to OBS' + (obsStatus.studioMode ? ' — Studio Mode is ON.' : ' — Studio Mode is OFF.');
    if (st === 'connecting') return 'Connecting to OBS…';
    if (st === 'auth-failed') return 'OBS refused the connection — wrong or missing password.';
    return 'OBS not reachable — retrying…';
  }

  function fetchFonts() {
    fetch('/api/fonts').then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && Array.isArray(j.fonts)) { FONTLIST = j.fonts; fillFontDatalist(); }
    }).catch(function () { /* older server */ });
  }

  function fillFontDatalist() {
    var dl = $('#st-fontlist');
    if (!dl) return;
    dl.innerHTML = '';
    var seen = {};
    uploadsArr().map(function (f) { return f && f.name; }).concat(FONTLIST).forEach(function (n) {
      if (!n || seen[n]) return;
      seen[n] = 1;
      var o = el('option');
      o.value = n;
      dl.appendChild(o);
    });
  }

  function uploadsArr() {
    var u = getVal('style.font.uploads');
    return Array.isArray(u) ? u : [];
  }

  function applyFontFamily(name) {
    sendField('style.font.family', '"' + String(name).replace(/["\\]/g, '') + '", \'Segoe UI\', Arial, sans-serif');
    refresh();
  }

  $('#st-logo-file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file || !pendingImageSetter) return;
    var setter = pendingImageSetter;
    pendingImageSetter = null;
    fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.url) { setter(j.url); refresh(); return; }
        /* an oversized or unwritable file used to fail in total silence */
        note(j.error || 'Upload failed');
      })
      .catch(function () { note('Upload failed — is the file too large?'); });
  });

  $('#st-font-file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.url) {
          var name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Custom font';
          sendField('style.font.uploads', uploadsArr().concat([{ name: name, url: j.url }]));
          applyFontFamily(name);
          
          refresh();
        }
      })
      .catch(function () { /* ignore */ });
  });

  /* ===================================== studio ===================================== */

  /* ------------------------------------------------------- design shell */
  function currentSubtab() {
    var b = $('#st-subnav .st-seg.on');
    return b ? b.dataset.sub : 'element';
  }
  var lastSubFor = null;
  function setSubtab(name) {
    var btns = $('#st-subnav').querySelectorAll('.st-seg');
    for (var i = 0; i < btns.length; i++) {
      var onIt = btns[i].dataset.sub === name;
      btns[i].classList.toggle('on', onIt);
      btns[i].setAttribute('aria-pressed', onIt ? 'true' : 'false');
    }
    var subs = document.querySelectorAll('#st-dpane .st-sub');
    for (var k = 0; k < subs.length; k++) subs[k].hidden = subs[k].id !== 'st-sub-' + name;
    store('lt-studio-subtab', name);
    if (!(name === 'element' && lastSubFor === selectedId)) $('#st-dpane').scrollTop = 0;
    lastSubFor = name === 'element' ? selectedId : null;
  }
  function buildDesignShell() {
    var btns = $('#st-subnav').querySelectorAll('.st-seg');
    for (var i = 0; i < btns.length; i++) {
      (function (b) { b.addEventListener('click', function () { setSubtab(b.dataset.sub); }); })(btns[i]);
    }
    $('#st-place-air').addEventListener('click', function () { setPlace('air'); });
    $('#st-place-design').addEventListener('click', function () { setPlace('design'); });
    var sub = load('lt-studio-subtab');
    setSubtab(sub === 'layout' || sub === 'look' || sub === 'presets' ? sub : 'element');
  }

  /* a group heading whose summary refreshes with its values */
  function group(host, title, summaryFn) {
    var g = el('div', 'st-group');
    var head = el('div', 'st-group-head');
    head.appendChild(el('span', null, title));
    var sum = el('span', 'st-sum');
    head.appendChild(sum);
    g.appendChild(head);
    var body = el('div', 'st-group-body');
    g.appendChild(body);
    host.appendChild(g);
    return { node: g, head: head, body: body, sync: function () { var t = summaryFn ? (summaryFn() || '') : ''; if (sum.textContent !== t) sum.textContent = t; } };
  }

  /* ---------------------------------------------------------- inspector
     One continuous form for the selected element, with a jump bar and live
     group summaries. Rebuilt only when the selection changes. */
  var inspector = (function () {
    var builtId = false, syncsI = [], host = null, groups = {};   /* false: never equal to null or an id */
    function point(id) {
      host = $('#st-sub-element');
      if (id === builtId) { syncsI.forEach(function (f) { f(); }); return; }
      builtId = id;
      host.innerHTML = ''; syncsI = []; groups = {};
      var e = id ? findEl(id) : null;
      if (!e) { host.appendChild(el('div', 'st-empty', 'Tap a bar in NEXT, a card in AIR or a chip in LAYOUT')); return; }
      build(e);
      syncsI.forEach(function (f) { f(); });
    }
    function build(e) {
      var id = e.id;
      var head = el('div'); head.id = 'st-insp-head';
      var nameIn = el('input', 'st-name'); nameIn.type = 'text'; nameIn.placeholder = 'name';
      nameIn.addEventListener('input', function () { sendEl(id, 'name', nameIn.value); });
      var kind = el('span', 'st-kind', e.kind === 'image' ? 'IMG' : 'TXT');
      var eye = el('input', 'st-eye'); eye.type = 'checkbox'; eye.title = 'Show this element';
      eye.addEventListener('change', function () { sendEl(id, 'enabled', eye.checked); });
      var pos = el('span', 'st-pos');
      var toMap = el('button', 'link-btn', '▸ show in LAYOUT');
      toMap.addEventListener('click', function () { setSubtab('layout'); });
      head.appendChild(eye); head.appendChild(nameIn); head.appendChild(kind); head.appendChild(pos); head.appendChild(toMap);
      host.appendChild(head);
      syncsI.push(function () {
        var cur = findEl(id); if (!cur) return;
        if (nameIn !== document.activeElement && nameIn.value !== (cur.name || '')) nameIn.value = cur.name || '';
        if (eye !== document.activeElement) eye.checked = cur.enabled !== false;
        var where = posTag(cur); if (pos.textContent !== where) pos.textContent = where;
      });

      var jump = el('div'); jump.id = 'st-jump';
      host.appendChild(jump);
      var form = el('div'); form.id = 'st-insp-form';
      host.appendChild(form);

      var GROUPS = e.kind === 'text'
        ? ['content', 'place', 'colour', 'type', 'box', 'motion']
        : ['content', 'place', 'colour', 'box', 'motion'];
      var TITLES = { content: 'CONTENT', place: 'PLACE', colour: 'COLOUR', type: 'TYPE', box: 'BOX', motion: 'MOTION' };
      var cur = null;
      function grp(key, summaryFn) {
        var gobj = group(form, TITLES[key], summaryFn);
        groups[key] = gobj;
        syncsI.push(gobj.sync);
        cur = gobj.body;
        var chip = el('button', null, TITLES[key]);
        chip.dataset.key = key;
        chip.addEventListener('click', function () {
          var pane = $('#st-dpane');
          pane.scrollTop = gobj.node.offsetTop - pane.offsetTop - 4;
        });
        jump.appendChild(chip);
      }
      function add(spec) { var r = makeRow(spec); cur.appendChild(r.row); syncsI.push(r.sync); return r; }
      function addNode(n) { cur.appendChild(n); }
      var E = function () { return findEl(id) || {}; };
      var D = function (p) { return dig(E(), p); };

      /* ---- CONTENT ---- */
      grp('content', function () {
        var c = E();
        if (c.kind === 'text') return String(c.text || '').slice(0, 30);
        var n = ((c.image && c.image.sources) || []).length;
        var r = c.image && c.image.rotate;
        return 'main' + (n ? ' + ' + n + ' logo' + (n > 1 ? 's' : '') : '') + (r && r.mode !== 'off' ? ' · ' + r.mode + ' ' + Math.round(r.everyMs / 1000) + 's' : '');
      });
      if (e.kind === 'text') {
        var taRow = el('div', 'row');
        taRow.appendChild(el('label', 'lbl', 'Text'));
        var ctl = el('div', 'ctl');
        var ta = el('textarea', 'st-cue-text'); ta.rows = 1; ta.setAttribute('dir', 'auto');
        ta.addEventListener('input', function () { sendEl(id, 'text', ta.value); });
        ta.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); transport.arm(); } });
        ctl.appendChild(ta); taRow.appendChild(ctl); addNode(taRow);
        syncsI.push(function () { var c = E(); if (ta !== document.activeElement && ta.value !== (c.text || '')) ta.value = c.text || ''; });
        var lines = buildLines(id, ta, { limit: 12 });
        addNode(lines.node); syncsI.push(lines.sync);
      } else {
        add({ type: 'imagepick', label: 'Image', get: function () { return D('image.url'); }, set: function (v) { sendEl(id, 'image.url', v); } });
        add({ type: 'select', label: 'Image fit', options: [{ v: 'contain', l: 'Contain' }, { v: 'cover', l: 'Cover' }, { v: 'fill', l: 'Stretch' }],
          get: function () { return D('image.fit'); }, set: function (v) { sendEl(id, 'image.fit', v); } });
        add({ type: 'slider', label: 'Image size', min: 0.2, max: 3, step: 0.05, unit: '×',
          title: 'Size inside its box — give the element more room with padding or min width to make the picture bigger',
          get: function () { return D('image.scale'); }, set: function (v) { sendEl(id, 'image.scale', v); } });
        var sf = buildShapeFit(e); addNode(sf.node); syncsI.push(sf.sync);
        add({ type: 'subhead', label: 'MORE LOGOS' });
        var lg = buildLogoSources(e); addNode(lg.node); syncsI.push(lg.sync);
        var hasAlts = function () { return !!((E().image && E().image.sources) || []).length; };
        var rotating = function () { return hasAlts() && D('image.rotate.mode') !== 'off'; };
        add({ type: 'select', label: 'Rotate logos', showIf: hasAlts,
          options: [{ v: 'off', l: 'Off — main logo only' }, { v: 'cycle', l: 'Cycle through all' }, { v: 'return', l: 'Swap out, then return to main' }],
          get: function () { return D('image.rotate.mode'); }, set: function (v) { sendEl(id, 'image.rotate.mode', v); } });
        add({ type: 'slider', label: 'Swap every', min: 1, max: 300, step: 1, unit: 's', showIf: rotating,
          get: function () { return Math.round((D('image.rotate.everyMs') || 8000) / 1000); },
          set: function (v) { sendEl(id, 'image.rotate.everyMs', Math.round(v * 1000)); } });
        add({ type: 'slider', label: 'Alternate stays for', min: 1, max: 120, step: 1, unit: 's',
          showIf: function () { return rotating() && D('image.rotate.mode') === 'return'; },
          get: function () { return Math.round((D('image.rotate.showMs') || 6000) / 1000); },
          set: function (v) { sendEl(id, 'image.rotate.showMs', Math.round(v * 1000)); } });
        add({ type: 'select', label: 'Swap animation', showIf: rotating,
          options: [{ v: 'fade', l: 'Fade' }, { v: 'slide', l: 'Slide up' }, { v: 'push', l: 'Push across' }, { v: 'wipe', l: 'Wipe across' },
                    { v: 'flip', l: 'Flip' }, { v: 'cube', l: 'Cube turn' }, { v: 'zoom', l: 'Zoom' }, { v: 'iris', l: 'Iris' }, { v: 'none', l: 'Cut' }],
          get: function () { return D('image.rotate.anim'); }, set: function (v) { sendEl(id, 'image.rotate.anim', v); } });
        add({ type: 'slider', label: 'Swap duration', min: 0, max: 2000, step: 50, unit: 'ms', showIf: rotating,
          get: function () { return D('image.rotate.animMs'); }, set: function (v) { sendEl(id, 'image.rotate.animMs', v); } });
      }

      /* ---- PLACE ---- */
      grp('place', function () {
        var c = E(); if (!c.place) return '';
        return posTag(c) + (c.place.stretch ? ' · stretch' : '') + (c.place.pin && c.place.pin !== 'auto' ? ' · pinned ' + c.place.pin : '');
      });
      var move = el('div', 'st-move');
      [['▲', 'up', 'Move to the row above'], ['▼', 'down', 'Move to the row below'],
       ['◀', 'left', 'Move one column left'], ['▶', 'right', 'Move one column right']].forEach(function (m) {
        var b = el('button', 'mini', m[0]); b.title = m[2];
        b.addEventListener('click', function () { send({ type: 'element-move', id: id, dir: m[1] }); });
        move.appendChild(b);
      });
      var nr = el('button', 'mini', 'own row'); nr.title = 'Put this element on a new row of its own';
      nr.addEventListener('click', function () { send({ type: 'element-newrow', id: id }); });
      move.appendChild(nr);
      addNode(move);
      add({ type: 'toggle', label: 'Stretch to fill', title: 'Take up the remaining width of the row',
        get: function () { return D('place.stretch'); }, set: function (v) { sendEl(id, 'place.stretch', v); } });
      add({ type: 'select', label: 'Pin to edge', options: [{ v: 'auto', l: 'Auto' }, { v: 'left', l: 'Far left' }, { v: 'right', l: 'Far right' }],
        title: 'Push this element to one side of its row',
        get: function () { return D('place.pin'); }, set: function (v) { sendEl(id, 'place.pin', v); } });
      add({ type: 'toggle', label: 'Full height', title: 'Span every row — e.g. a logo standing beside the whole block',
        get: function () { return D('place.spanAll'); }, set: function (v) { sendEl(id, 'place.spanAll', v); } });
      add({ type: 'slider', label: 'Min width', min: 0, max: 600, step: 5, unit: 'px',
        get: function () { return D('style.minWidth'); }, set: function (v) { sendEl(id, 'style.minWidth', v); } });

      /* ---- COLOUR ---- */
      grp('colour', function () {
        var st = E().style || {};
        return (st.bg || '') + ' · ' + Math.round((st.bgOpacity === undefined ? 1 : st.bgOpacity) * 100) + '%' +
          ' · gradient ' + (st.gradient && st.gradient.enabled ? st.gradient.type : 'off') +
          (st.bgImage && st.bgImage.enabled ? ' · picture' : '');
      });
      add({ type: 'color', label: 'Background', get: function () { return D('style.bg'); }, set: function (v) { sendEl(id, 'style.bg', v); } });
      add({ type: 'slider', label: 'Bg opacity', min: 0, max: 1, step: 0.01, unit: '%pct',
        get: function () { return D('style.bgOpacity'); }, set: function (v) { sendEl(id, 'style.bgOpacity', v); } });
      if (e.kind === 'text') {
        add({ type: 'color', label: 'Text colour', get: function () { return D('style.color'); }, set: function (v) { sendEl(id, 'style.color', v); } });
      }
      var gradOn = function () { return !!D('style.gradient.enabled'); };
      var gtype = function () { return D('style.gradient.type'); };
      add({ type: 'toggle', label: 'Gradient', get: gradOn, set: function (v) { sendEl(id, 'style.gradient.enabled', v); } });
      add({ type: 'select', label: 'Gradient type', showIf: gradOn,
        options: [{ v: 'linear', l: 'Linear' }, { v: 'radial', l: 'Radial' }, { v: 'conic', l: 'Conic / angle' }],
        get: gtype, set: function (v) { sendEl(id, 'style.gradient.type', v); } });
      add({ type: 'slider', label: 'Angle', min: 0, max: 360, step: 1, unit: '°', showIf: function () { return gradOn() && gtype() !== 'radial'; },
        get: function () { return D('style.gradient.angle'); }, set: function (v) { sendEl(id, 'style.gradient.angle', v); } });
      add({ type: 'select', label: 'Shape', options: [{ v: 'ellipse', l: 'Ellipse' }, { v: 'circle', l: 'Circle' }], showIf: function () { return gradOn() && gtype() === 'radial'; },
        get: function () { return D('style.gradient.shape'); }, set: function (v) { sendEl(id, 'style.gradient.shape', v); } });
      add({ type: 'slider', label: 'Centre X', min: 0, max: 100, step: 1, unit: '%', showIf: function () { return gradOn() && gtype() !== 'linear'; },
        get: function () { return D('style.gradient.posX'); }, set: function (v) { sendEl(id, 'style.gradient.posX', v); } });
      add({ type: 'slider', label: 'Centre Y', min: 0, max: 100, step: 1, unit: '%', showIf: function () { return gradOn() && gtype() !== 'linear'; },
        get: function () { return D('style.gradient.posY'); }, set: function (v) { sendEl(id, 'style.gradient.posY', v); } });
      var ge = buildGradientEditor(e); addNode(ge.node);
      syncsI.push(function () { ge.node.classList.toggle('st-hidden', !gradOn()); if (gradOn()) ge.sync(); });
      var picOn = function () { return !!D('style.bgImage.enabled'); };
      add({ type: 'toggle', label: 'Background image', title: 'The colour above becomes a tint over the picture — lower its opacity to reveal more image',
        get: picOn, set: function (v) { sendEl(id, 'style.bgImage.enabled', v); } });
      add({ type: 'imagepick', label: 'Picture', showIf: picOn, get: function () { return D('style.bgImage.url'); }, set: function (v) { sendEl(id, 'style.bgImage.url', v); } });
      add({ type: 'select', label: 'Picture fit', options: FITS, showIf: picOn,
        get: function () { return D('style.bgImage.fit'); }, set: function (v) { sendEl(id, 'style.bgImage.fit', v); } });

      /* ---- TYPE ---- */
      if (e.kind === 'text') {
        grp('type', function () {
          var st = E().style || {};
          return (st.fontFamily ? st.fontFamily.replace(/"/g, '') : 'default font') + ' · ' + st.size + 'px · ' + st.weight;
        });
        add({ type: 'fontpick', label: 'Font', title: 'Font for this element only. Leave empty to follow the default font set under LOOK.',
          get: function () { return D('style.fontFamily'); }, set: function (v) { sendEl(id, 'style.fontFamily', v); } });
        add({ type: 'slider', label: 'Size', min: 8, max: 160, step: 1, unit: 'px', get: function () { return D('style.size'); }, set: function (v) { sendEl(id, 'style.size', v); } });
        add({ type: 'slider', label: 'Weight', min: 100, max: 900, step: 100, get: function () { return D('style.weight'); }, set: function (v) { sendEl(id, 'style.weight', v); } });
        add({ type: 'slider', label: 'Letter spacing', min: -3, max: 24, step: 0.5, unit: 'px', get: function () { return D('style.letterSpacing'); }, set: function (v) { sendEl(id, 'style.letterSpacing', v); } });
        add({ type: 'slider', label: 'Line height', min: 0.8, max: 2.4, step: 0.02, unit: '×', get: function () { return D('style.lineHeight'); }, set: function (v) { sendEl(id, 'style.lineHeight', v); } });
        add({ type: 'select', label: 'Align', options: ALIGNS, get: function () { return D('style.align'); }, set: function (v) { sendEl(id, 'style.align', v); } });
        add({ type: 'toggle', label: 'Never wrap', get: function () { return D('style.nowrap'); }, set: function (v) { sendEl(id, 'style.nowrap', v); } });
      }

      /* ---- BOX ---- */
      grp('box', function () {
        var st = E().style || {};
        var ed = st.edges || {};
        return st.padX + '/' + st.padY + ' · ' + (ed.mode === 'inherit' ? 'edges as look' : ed.mode + (ed.mode === 'rounded' ? ' ' + ed.radius : (ed.mode === 'chamfer' || ed.mode === 'chevron' ? ' ' + ed.chamfer : ''))) +
          (st.accent && st.accent.mode !== 'none' ? ' · accent ' + st.accent.mode : '');
      });
      add({ type: 'slider', label: 'Pad horizontal', min: 0, max: 90, step: 1, unit: 'px', get: function () { return D('style.padX'); }, set: function (v) { sendEl(id, 'style.padX', v); } });
      add({ type: 'slider', label: 'Pad vertical', min: 0, max: 70, step: 1, unit: 'px', get: function () { return D('style.padY'); }, set: function (v) { sendEl(id, 'style.padY', v); } });
      var emode = function () { return D('style.edges.mode'); };
      add({ type: 'select', label: 'Edges', options: [{ v: 'inherit', l: 'Same as look' }, { v: 'square', l: 'Square' }, { v: 'rounded', l: 'Rounded' }, { v: 'chamfer', l: 'Slanted' }, { v: 'chevron', l: 'Chevron' }],
        get: emode, set: function (v) { sendEl(id, 'style.edges.mode', v); } });
      add({ type: 'slider', label: 'Corner radius', min: 0, max: 60, step: 1, unit: 'px', showIf: function () { return emode() === 'rounded'; },
        get: function () { return D('style.edges.radius'); }, set: function (v) { sendEl(id, 'style.edges.radius', v); } });
      var depthRow = add({ type: 'slider', label: 'Slant amount', min: 4, max: 80, step: 1, unit: 'px', showIf: function () { return emode() === 'chamfer' || emode() === 'chevron'; },
        get: function () { return D('style.edges.chamfer'); }, set: function (v) { sendEl(id, 'style.edges.chamfer', v); } });
      syncsI.push(function () {
        var l = depthRow.row.querySelector('.lbl'), want = emode() === 'chevron' ? 'Chevron depth' : 'Slant amount';
        if (l && l.textContent !== want) l.textContent = want;
      });
      var amode = function () { return D('style.accent.mode'); };
      add({ type: 'select', label: 'Accent strip', options: [{ v: 'none', l: 'None' }, { v: 'top', l: 'Top' }, { v: 'bottom', l: 'Bottom' }, { v: 'side', l: 'Side' }],
        get: amode, set: function (v) { sendEl(id, 'style.accent.mode', v); } });
      add({ type: 'color', label: 'Accent colour', showIf: function () { return amode() && amode() !== 'none'; }, get: function () { return D('style.accent.color'); }, set: function (v) { sendEl(id, 'style.accent.color', v); } });
      add({ type: 'slider', label: 'Accent size', min: 1, max: 30, step: 1, unit: 'px', showIf: function () { return amode() && amode() !== 'none'; },
        get: function () { return D('style.accent.thickness'); }, set: function (v) { sendEl(id, 'style.accent.thickness', v); } });

      /* ---- MOTION ---- */
      grp('motion', function () {
        var a = E().anim || {};
        var r = a.reactTo ? findEl(a.reactTo) : null;
        return (a.inStyle === 'inherit' ? 'as look' : a.inStyle) + (r ? ' · reacts to ' + (r.name || 'logo') : '');
      });
      add({ type: 'select', label: 'Entrance', options: [{ v: 'inherit', l: 'Same as the look' }, { v: 'slide-up', l: 'Slide up' }, { v: 'slide-side', l: 'Slide from the side' }, { v: 'wipe', l: 'Wipe' }, { v: 'fade', l: 'Fade' }, { v: 'pop', l: 'Pop' }],
        title: 'Give this one element its own way in. "Slide from the side" enters from the right on an RTL layout and from the left on LTR. The exit mirrors it.',
        get: function () { return D('anim.inStyle'); }, set: function (v) { sendEl(id, 'anim.inStyle', v); } });
      add({ type: 'slider', label: 'Entrance time', min: 0, max: 3000, step: 50, unit: 'ms', title: '0 = use the look’s in-duration',
        get: function () { return D('anim.inMs'); }, set: function (v) { sendEl(id, 'anim.inMs', v); } });
      add({ type: 'slider', label: 'Extra delay', min: 0, max: 3000, step: 50, unit: 'ms', title: 'Held back this much on top of the stagger',
        get: function () { return D('anim.delayMs'); }, set: function (v) { sendEl(id, 'anim.delayMs', v); } });
      add({ type: 'subhead', label: 'REACT TO A LOGO CHANGE' });
      var logoOpts = [{ v: '', l: 'Nothing — stay still' }], logoIds = [];
      elements().forEach(function (o) { if (o.id !== id && o.kind === 'image') { logoOpts.push({ v: o.id, l: o.name || 'Image' }); logoIds.push(o.id); } });
      var reactRow = add({ type: 'select', label: 'When this changes', options: logoOpts,
        title: 'Pick a logo. Every time it rotates to another picture, this element moves — so a chevron, rule or divider carries the change.',
        get: function () { return D('anim.reactTo'); }, set: function (v) { sendEl(id, 'anim.reactTo', v); } });
      syncsI.push(function () {
        var sel = reactRow.row.querySelector('select'); if (!sel) return;
        logoIds.forEach(function (oid, k) { var o = findEl(oid); var opt = sel.options[k + 1]; if (o && opt && opt.textContent !== (o.name || 'Image')) opt.textContent = o.name || 'Image'; });
      });
      var reacts = function () { return !!D('anim.reactTo'); };
      add({ type: 'select', label: 'This element', showIf: reacts, options: [{ v: 'flick', l: 'Flicks through' }, { v: 'replay', l: 'Enters again' }, { v: 'pulse', l: 'Pulses' }, { v: 'none', l: 'Does nothing' }],
        get: function () { return D('anim.reactStyle'); }, set: function (v) { sendEl(id, 'anim.reactStyle', v); } });
      add({ type: 'slider', label: 'Reaction time', min: 0, max: 2000, step: 50, unit: 'ms', showIf: reacts,
        get: function () { return D('anim.reactMs'); }, set: function (v) { sendEl(id, 'anim.reactMs', v); } });
      add({ type: 'toggle', label: 'Cover the swap', showIf: reacts, title: 'Hold the logo change until this element is halfway through its move',
        get: function () { return D('anim.cover'); }, set: function (v) { sendEl(id, 'anim.cover', v); } });

      /* ---- footer ---- */
      var foot = el('div', 'st-insp-foot');
      var dup = el('button', null, '⧉ duplicate');
      dup.addEventListener('click', function () { send({ type: 'element-duplicate', id: id }); });
      var del = armed(el('button', null, '✕ remove'), { label: '✕ remove', armedLabel: '✕ sure?', ms: 2500, danger: true,
        fire: function () { send({ type: 'element-remove', id: id }); } });
      foot.appendChild(dup); foot.appendChild(del);
      form.appendChild(foot);

      /* jump-bar highlight follows the scroll */
      var pane = $('#st-dpane'), lastT = 0;
      pane.addEventListener('scroll', function () {
        var now = Date.now(); if (now - lastT < 100) return; lastT = now;
        if (currentSubtab() !== 'element') return;
        var best = null, bestD = 1e9;
        Object.keys(groups).forEach(function (k) {
          var d = Math.abs(groups[k].node.getBoundingClientRect().top - pane.getBoundingClientRect().top);
          if (d < bestD) { bestD = d; best = k; }
        });
        var chips = jump.querySelectorAll('button');
        for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('on', chips[i].dataset.key === best);
      });
    }
    return { point: point, sync: function () { syncsI.forEach(function (f) { f(); }); } };
  })();

  /* --------------------------------------------------------- layout map */
  var mapSig = null, mapDrag = null, mapSyncs = [];
  function mapSignature() {
    return elements().map(function (e) {
      return [e.id, e.kind, e.place.row, e.place.col, e.place.order, e.place.spanAll ? 1 : 0, e.enabled === false ? 0 : 1, e.name].join(':');
    }).join('|');
  }
  function renderMap() {
    var host = $('#st-sub-layout');
    if (!host) return;
    var sig = mapSignature();
    if (mapDrag || sig === mapSig) { mapSyncs.forEach(function (f) { f(); }); return; }
    mapSig = sig;
    host.innerHTML = ''; mapSyncs = [];
    var dir = readingDir();
    var list = elements();
    var maxRow = -1;
    list.forEach(function (e) { if (!e.place.spanAll && e.place.row > maxRow) maxRow = e.place.row; });
    function track(label, rowKey, members) {
      var t = el('div', 'st-track');
      t.dataset.row = rowKey;
      t.style.direction = dir;
      t.appendChild(el('div', 'st-track-lbl', label));
      members.sort(function (a, b) { return (a.place.col - b.place.col) || (a.place.order - b.place.order); })
        .forEach(function (e) { t.appendChild(chip(e)); });
      if (rowKey !== 'full') {
        var add = el('button', 'st-add', '＋'); add.title = 'Add a text element to this row';
        add.addEventListener('click', function () { send({ type: 'element-add', kind: 'text', row: parseInt(rowKey, 10), col: 99 }); });
        t.appendChild(add);
      }
      host.appendChild(t);
    }
    for (var r = 0; r <= maxRow; r++) {
      track('ROW ' + (r + 1), String(r), list.filter(function (e) { return !e.place.spanAll && e.place.row === r; }));
    }
    track('FULL HEIGHT', 'full', list.filter(function (e) { return e.place.spanAll; }));

    var tools = el('div', 'st-track-tools');
    function tb(label, title, fn) { var b = el('button', 'mini', label); b.title = title; b.addEventListener('click', function () { if (selectedId) fn(selectedId); }); tools.appendChild(b); return b; }
    var mv = [
      tb('▲', 'Move to the row above', function (id) { send({ type: 'element-move', id: id, dir: 'up' }); }),
      tb('▼', 'Move to the row below', function (id) { send({ type: 'element-move', id: id, dir: 'down' }); }),
      tb('◀', 'Move one column left', function (id) { send({ type: 'element-move', id: id, dir: 'left' }); }),
      tb('▶', 'Move one column right', function (id) { send({ type: 'element-move', id: id, dir: 'right' }); }),
      tb('own row', 'A row of its own', function (id) { send({ type: 'element-newrow', id: id }); }),
      tb('full height', 'Span every row', function (id) { var e = findEl(id); if (e) sendEl(id, 'place.spanAll', !e.place.spanAll); }),
      tb('⧉ copy', 'Duplicate', function (id) { send({ type: 'element-duplicate', id: id }); }),
    ];
    var del = armed(el('button', 'mini', '✕ remove'), { label: '✕ remove', armedLabel: '✕ sure?', ms: 2500, danger: true,
      fire: function () { if (selectedId) send({ type: 'element-remove', id: selectedId }); } });
    tools.appendChild(del);
    host.appendChild(tools);
    var adds = el('div', 'st-tools');
    var at = el('button', null, '＋ text'); at.addEventListener('click', function () { send({ type: 'element-add', kind: 'text' }); });
    var ai = el('button', null, '＋ image'); ai.addEventListener('click', function () { send({ type: 'element-add', kind: 'image' }); });
    adds.appendChild(at); adds.appendChild(ai);
    host.appendChild(adds);
    mapSyncs.push(function () {
      var has = !!selectedId;
      mv.forEach(function (b) { b.disabled = !has; });
      del.disabled = !has;
      var chips = host.querySelectorAll('.st-chip');
      for (var i = 0; i < chips.length; i++) {
        chips[i].classList.toggle('sel', chips[i].dataset.id === selectedId);
        var dot = chips[i].querySelector('.st-dotm');
        if (dot) dot.style.display = diffRes.byId[chips[i].dataset.id] ? '' : 'none';
      }
    });
    mapSyncs.forEach(function (f) { f(); });
  }
  function chip(e) {
    var c = el('div', 'st-chip' + (e.enabled === false ? ' st-off' : ''));
    c.dataset.id = e.id;
    c.appendChild(el('span', 'st-glyph', e.kind === 'image' ? '▣' : 'T'));
    c.appendChild(el('span', 'st-chip-name', e.name || e.kind));
    var eye = el('input', 'st-eye'); eye.type = 'checkbox'; eye.checked = e.enabled !== false; eye.title = 'Show this element';
    eye.addEventListener('click', function (ev) { ev.stopPropagation(); });
    eye.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    eye.addEventListener('change', function () { sendEl(e.id, 'enabled', eye.checked); });
    c.appendChild(eye);
    c.appendChild(el('span', 'st-dotm st-diff'));
    c.addEventListener('click', function () { select(e.id, 'map'); });
    c.addEventListener('pointerdown', function (ev) { beginMapDrag(ev, c, e.id); });
    return c;
  }
  function beginMapDrag(ev, chipNode, id) {
    if (mapDrag || ev.button !== 0) return;
    var line = el('div', 'st-drop');
    mapDrag = { id: id, chip: chipNode, pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY, moved: false, slot: null, target: ev.target };
    try { ev.target.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    function clearLine() { if (line.parentNode) line.parentNode.removeChild(line); chipNode.classList.remove('drag-void'); }
    function move(e2) {
      if (!mapDrag || e2.pointerId !== mapDrag.pointerId) return;
      if (e2.buttons === 0) { finish(false); return; }
      if (!mapDrag.moved) {
        if (Math.abs(e2.clientX - mapDrag.x0) + Math.abs(e2.clientY - mapDrag.y0) < 6) return;
        mapDrag.moved = true; chipNode.classList.add('dragging');
      }
      var tracks = document.querySelectorAll('#st-sub-layout .st-track');
      var target = null;
      for (var i = 0; i < tracks.length; i++) {
        var r = tracks[i].getBoundingClientRect();
        if (e2.clientY >= r.top - 24 && e2.clientY <= r.bottom + 24) { target = tracks[i]; break; }
      }
      if (!target) { mapDrag.slot = null; clearLine(); chipNode.classList.add('drag-void'); return; }
      chipNode.classList.remove('drag-void');
      var rtl = getComputedStyle(target).direction === 'rtl';
      var others = [];
      var kids = target.querySelectorAll('.st-chip');
      for (var k = 0; k < kids.length; k++) if (kids[k] !== chipNode) others.push(kids[k]);
      var index = 0, before = null;
      for (var m = 0; m < others.length; m++) {
        var cr = others[m].getBoundingClientRect();
        var cx = cr.left + cr.width / 2;
        var precedes = rtl ? (cx > e2.clientX) : (cx < e2.clientX);
        if (precedes) index++; else if (!before) before = others[m];
      }
      var rowKey = target.dataset.row;
      mapDrag.slot = { row: rowKey === 'full' ? 'full' : parseInt(rowKey, 10), index: index };
      if (before) target.insertBefore(line, before);
      else { var addBtn = target.querySelector('.st-add'); if (addBtn) target.insertBefore(line, addBtn); else target.appendChild(line); }
    }
    function finish(commit) {
      if (!mapDrag) return;
      try { mapDrag.target.releasePointerCapture(mapDrag.pointerId); } catch (e) { /* ignore */ }
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey);
      chipNode.classList.remove('dragging');
      clearLine();
      var slot = mapDrag.slot, moved = mapDrag.moved;
      mapDrag = null;
      if (commit && moved && slot) send({ type: 'element-reorder', id: id, row: slot.row, index: slot.index });
      renderMap();
    }
    function onUp(e2) { if (mapDrag && e2.pointerId === mapDrag.pointerId) finish(true); }
    function onCancel(e2) { if (mapDrag && e2.pointerId === mapDrag.pointerId) finish(false); }
    function onKey(e2) { if (e2.key === 'Escape') { e2.preventDefault(); finish(false); } }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
  }

  /* ------------------------------------------------- preview-drag reorder
     DESIGN only: move a bar by dragging it onto another bar in the picture. */
  var dragging = false;
  function beginPreviewDrag(ev, hit, id) {
    var wide = document.body.classList.contains('st-wide');
    if (!(document.body.classList.contains('place-design') || (wide && $('#st-design').contains(document.activeElement)))) return;
    if (ev.button !== 0) return;
    var st = { pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY, moved: false, slot: null };
    var line = el('div', 'st-drop-line');
    try { hit.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    function move(e2) {
      if (e2.pointerId !== st.pointerId) return;
      if (e2.buttons === 0) { finish(false); return; }
      if (!st.moved) {
        if (Math.abs(e2.clientX - st.x0) + Math.abs(e2.clientY - st.y0) < 6) return;
        st.moved = true; dragging = true; hitsPaused = true; hit.classList.add('st-dragging');
      }
      var hits = document.querySelectorAll('#st-pv-hit .hit');
      var target = null;
      for (var i = 0; i < hits.length; i++) {
        if (hits[i] === hit) continue;
        var r = hits[i].getBoundingClientRect();
        if (e2.clientX >= r.left && e2.clientX <= r.right && e2.clientY >= r.top && e2.clientY <= r.bottom) { target = hits[i]; break; }
      }
      if (!target) { st.slot = null; hit.classList.add('st-void'); if (line.parentNode) line.parentNode.removeChild(line); return; }
      hit.classList.remove('st-void');
      var tEl = findEl(target.dataset.id), me = findEl(id);
      if (!tEl || !me) return;
      var row = tEl.place.spanAll ? 'full' : tEl.place.row;
      var others = elements().filter(function (o) {
        return o.id !== id && (row === 'full' ? o.place.spanAll : (!o.place.spanAll && o.place.row === row));
      }).sort(function (a, b) { return (a.place.col - b.place.col) || (a.place.order - b.place.order); });
      var idx = -1; for (var k = 0; k < others.length; k++) if (others[k].id === tEl.id) idx = k;
      var tr = target.getBoundingClientRect();
      var cx = tr.left + tr.width / 2;
      var after = readingDir() === 'rtl' ? (e2.clientX < cx) : (e2.clientX > cx);
      st.slot = { row: row, index: idx + (after ? 1 : 0) };
      var host = $('#st-pv-hit'), hr = host.getBoundingClientRect();
      line.style.top = (tr.top - hr.top) + 'px'; line.style.height = tr.height + 'px';
      var nearLeft = readingDir() === 'rtl' ? !after : after;
      line.style.left = ((nearLeft ? tr.right : tr.left) - hr.left - 1) + 'px';
      if (!line.parentNode) host.appendChild(line);
    }
    function finish(commit) {
      try { hit.releasePointerCapture(st.pointerId); } catch (e) { /* ignore */ }
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey);
      hit.classList.remove('st-dragging'); hit.classList.remove('st-void');
      if (line.parentNode) line.parentNode.removeChild(line);
      var slot = st.slot, moved = st.moved;
      dragging = false; hitsPaused = false;
      if (commit && moved && slot) send({ type: 'element-reorder', id: id, row: slot.row, index: slot.index });
      paintHits();
    }
    function onUp(e2) { if (e2.pointerId === st.pointerId) finish(true); }
    function onCancel(e2) { if (e2.pointerId === st.pointerId) finish(false); }
    function onKey(e2) { if (e2.key === 'Escape') { e2.preventDefault(); finish(false); } }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
  }

  /* ------------------------------------------------------------- LOOK */
  var lookSyncs = [];
  function buildLook() {
    var host = $('#st-sub-look');
    host.innerHTML = ''; lookSyncs = [];
    function section(key, title, summaryFn) {
      var gobj = group(host, title, summaryFn);
      lookSyncs.push(gobj.sync);
      GLOBAL_FIELDS.filter(function (f) { return f.sec === key; }).forEach(function (f) {
        var r = makeRow(f); gobj.body.appendChild(r.row); lookSyncs.push(r.sync);
      });
      return gobj;
    }
    section('layout', 'LAYOUT & POSITION', function () {
      var st = S.pending.style;
      return (st.direction === 'auto' ? 'auto (' + readingDir() + ')' : st.direction) + ' · ' +
        (st.layout.fullWidth ? 'full width' : 'anchored ' + st.layout.anchor + ' · ' + st.layout.maxWidth + '%');
    });
    var fonts = group(host, 'FONTS', function () {
      var f = S.pending.style.font;
      var fam = String(f.family || '').split(',')[0].replace(/["']/g, '').trim();
      var n = uploadsArr().length;
      return (fam || 'default') + (n ? ' · ' + n + ' uploaded' : '');
    });
    lookSyncs.push(fonts.sync);
    var pickRow = el('div', 'row');
    pickRow.appendChild(el('label', 'lbl', 'Pick a font'));
    var pctl = el('div', 'ctl');
    var pick = el('input'); pick.type = 'text'; pick.setAttribute('list', 'st-fontlist');
    pick.placeholder = 'type to search fonts on this PC…';
    pick.addEventListener('change', function () { if (pick.value.trim()) { applyFontFamily(pick.value.trim()); pick.value = ''; } });
    pctl.appendChild(pick); pickRow.appendChild(pctl); fonts.body.appendChild(pickRow);
    var upRow = el('div', 'row');
    upRow.appendChild(el('label', 'lbl', 'Font file'));
    var uctl = el('div', 'ctl');
    var upB = el('button', null, '⬆ upload .ttf / .otf / .woff2');
    upB.addEventListener('click', function () { $('#st-font-file').click(); });
    uctl.appendChild(upB); upRow.appendChild(uctl); fonts.body.appendChild(upRow);
    var upList = el('div'); fonts.body.appendChild(upList);
    lookSyncs.push(function () {
      var arr = uploadsArr();
      var sig = arr.map(function (f) { return f && f.name; }).join('|');
      if (upList.dataset.sig === sig) return;
      upList.dataset.sig = sig; upList.innerHTML = '';
      arr.forEach(function (f) {
        var r = el('div', 'st-font-up');
        r.appendChild(el('span', null, f.name));
        var use = el('button', 'mini', 'use'); use.addEventListener('click', function () { applyFontFamily(f.name); });
        var x = el('button', 'mini', '✕'); x.title = 'Remove this uploaded font';
        x.addEventListener('click', function () { sendField('style.font.uploads', uploadsArr().filter(function (u) { return u !== f; })); });
        r.appendChild(use); r.appendChild(x); upList.appendChild(r);
      });
    });
    GLOBAL_FIELDS.filter(function (f) { return f.sec === 'type'; }).forEach(function (f) {
      var r = makeRow(f); fonts.body.appendChild(r.row); lookSyncs.push(r.sync);
    });
    section('edges', 'EDGES & SHADOW', function () {
      var e = S.pending.style.edges;
      return e.style + (e.style === 'rounded' ? ' ' + e.radius : (e.style === 'chamfer' || e.style === 'chevron' ? ' ' + e.chamfer : '')) + ' · shadow ' + S.pending.style.shadow;
    });
    section('anim', 'ANIMATION', function () {
      var a = S.anim;
      return (a.enabled === false ? 'OFF' : a.inStyle + ' ' + a.inMs + 'ms · stagger ' + a.staggerMs);
    });
    var obs = section('obs', 'OBS & OUTPUT', function () {
      return NATIVE ? 'native plugin' + (obsStatus.studioMode ? ' · studio mode' : '') : 'obs ' + obsStatus.status;
    });
    var hint = el('div', 'hint'); obs.body.insertBefore(hint, obs.body.firstChild);
    lookSyncs.push(function () { var t = obsHintText(); if (hint.textContent !== t) hint.textContent = t; });
    obs.body.appendChild(el('div', 'subhead', 'URLS'));
    var base = location.origin;
    [['/overlay', 'Program overlay — the OBS source'],
     ['/overlay?role=preview', 'Preview — open in a BROWSER window, never as an OBS source'],
     ['/control', 'Classic dock'], ['/studio', 'This dock'],
     ['/api/take', 'Commit pending'], ['/api/show', 'Show'], ['/api/hide', 'Hide']].forEach(function (u) {
      var r = el('div', 'st-url');
      var c = el('code', null, base + u[0]); c.title = u[1];
      var b = el('button', 'mini', 'copy'); b.addEventListener('click', function () { copyText(base + u[0]); note('Copied'); });
      r.appendChild(c); r.appendChild(b); obs.body.appendChild(r);
    });
    obs.body.appendChild(el('div', 'subhead', 'MAINTENANCE'));
    var rs = armed(el('button', null, 'reset global style to defaults'), { label: 'reset global style to defaults', armedLabel: 'reset the look’s style?', ms: 2500, danger: true,
      fire: function () { send({ type: 'reset-style' }); } });
    obs.body.appendChild(rs);
    var dock = group(host, 'DOCK', function () { return 'preview ' + currentMode() + (load('lt-studio-enter-arm') === '1' ? ' · Enter arms SHOW' : ''); });
    lookSyncs.push(dock.sync);
    var fr = makeRow({ type: 'select', label: 'Preview framing', options: [{ v: 'strap', l: 'Strap (crop to the bar)' }, { v: 'full', l: 'Full frame' }],
      get: function () { return currentMode(); }, set: function (v) { pvMode = v; store('lt-studio-preview', v); lastCrop = null; fitPreview(); syncPreview(); } });
    dock.body.appendChild(fr.row); lookSyncs.push(fr.sync);
    var ea = makeRow({ type: 'toggle', label: 'Enter arms SHOW', title: 'Off: Enter does nothing in a text field; Ctrl+Enter always shows',
      get: function () { return load('lt-studio-enter-arm') === '1'; }, set: function (v) { store('lt-studio-enter-arm', v ? '1' : '0'); } });
    dock.body.appendChild(ea.row); lookSyncs.push(ea.sync);
    dock.body.appendChild(el('div', 'hint', 'Off: Enter does nothing in a text field. Ctrl+Enter always shows.'));
  }

  /* ---------------------------------------------------------- presets */
  var undo = {
    snap: null, serial: 0, label: '',
    stash: function (snap, label) {
      undo.snap = snap; undo.serial = editSerial; undo.label = label;
      toast(activeLane(), label + ' — ', { action: 'Undo', ms: 15000,
        onAction: function () { undo.restore(); }, onDismiss: function () { undo.snap = null; } });
    },
    restore: function () {
      if (!undo.snap) return;
      if (editSerial !== undo.serial) { note('Cannot undo — edited since'); undo.snap = null; return; }
      var snap = undo.snap; undo.snap = null;
      send({ type: 'edit', patch: { elements: snap.elements, style: snap.style } });
      send({ type: 'anim', patch: snap.anim });
    },
  };
  var armedPreset = null;
  function renderPresets() {
    var host = $('#st-sub-presets');
    if (!host || !S) return;
    host.innerHTML = '';
    host.appendChild(el('div', 'st-guard'));
    var list = S.presets || [];
    if (!list.length) host.appendChild(el('div', 'hint', 'No presets yet — save the current look below.'));
    list.forEach(function (p) {
      var card = el('div', 'st-preset');
      var sw = el('div', 'st-swatches');
      (p.elements || []).forEach(function (e) { var sp = el('span'); sp.style.background = (e.style && e.style.bg) || '#333'; sw.appendChild(sp); });
      card.appendChild(sw);
      var row = el('div', 'st-preset-row');
      row.appendChild(el('span', 'st-preset-name', p.name));
      row.appendChild(el('span', 'st-preset-n', (p.elements || []).length + ' elements'));
      var more = el('button', 'st-preset-more', '⋯'); more.title = 'Overwrite or delete';
      row.appendChild(more);
      card.appendChild(row);
      var arm = el('div', 'st-arm');
      var msg = el('span', 'st-arm-msg');
      var loadB = el('button', 'st-arm-load', 'LOAD');
      var cancel = el('button', 'st-arm-cancel', 'cancel');
      arm.appendChild(msg); arm.appendChild(loadB); arm.appendChild(cancel);
      card.appendChild(arm);
      var menu = el('div', 'st-preset-menu'); menu.hidden = true;
      var ow = armed(el('button', 'mini', 'Overwrite with current look'), { label: 'Overwrite with current look', armedLabel: 'Overwrite?', ms: 2500,
        fire: function () { send({ type: 'preset-update', id: p.id }); menu.hidden = true; } });
      var dl = armed(el('button', 'mini', 'Delete'), { label: 'Delete', armedLabel: 'Delete?', ms: 2500, danger: true,
        fire: function () { send({ type: 'preset-delete', id: p.id }); } });
      menu.appendChild(ow); menu.appendChild(dl);
      card.appendChild(menu);
      more.addEventListener('click', function (ev) { ev.stopPropagation(); menu.hidden = !menu.hidden; });
      function disarm() { card.classList.remove('st-armed'); if (armedPreset === card) armedPreset = null; if (card._t) { clearTimeout(card._t); card._t = null; } }
      card._disarm = disarm;
      card.addEventListener('click', function (ev) {
        if (ev.target === loadB || ev.target === cancel || menu.contains(ev.target)) return;
        if (armedPreset && armedPreset !== card && armedPreset._disarm) armedPreset._disarm();
        var n = diffRes.count;
        msg.textContent = 'Load “' + p.name + '” into NEXT — ' + (n ? 'this discards ' + n + ' unsent edit' + (n === 1 ? '' : 's') : 'nothing is unsent');
        card.classList.add('st-armed'); armedPreset = card;
        if (card._t) clearTimeout(card._t);
        card._t = setTimeout(disarm, 5000);
      });
      cancel.addEventListener('click', function (ev) { ev.stopPropagation(); disarm(); });
      loadB.addEventListener('click', function (ev) {
        ev.stopPropagation();
        undo.stash({ elements: clone(S.pending.elements), style: clone(S.pending.style), anim: clone(S.anim) }, 'Loaded “' + p.name + '” into NEXT');
        send({ type: 'preset-load', id: p.id });
        disarm();
      });
      host.appendChild(card);
    });
    var saveRow = el('div', 'st-save-row');
    var nm = el('input'); nm.type = 'text'; nm.placeholder = 'new preset name…';
    var sv = el('button', null, '＋ save current look');
    sv.addEventListener('click', function () { send({ type: 'preset-save', name: nm.value.trim() || 'Preset ' + ((S.presets || []).length + 1) }); nm.value = ''; });
    saveRow.appendChild(nm); saveRow.appendChild(sv);
    host.appendChild(saveRow);
    var rb = armed(el('button', 'link-btn', 'restore built-in presets'), { label: 'restore built-in presets', armedLabel: 'restore the built-ins?', ms: 2500,
      fire: function () { send({ type: 'preset-restore' }); } });
    host.appendChild(rb);
  }
  document.addEventListener('pointerdown', function (ev) {
    if (armedPreset && !armedPreset.contains(ev.target) && armedPreset._disarm) armedPreset._disarm();
  }, true);

  /* ---------------------------------------------------------- keyboard */
  function buildKeys() {
    document.addEventListener('compositionstart', function () { composing = true; });
    document.addEventListener('compositionend', function () { composing = false; });
    document.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        if (composing || ev.isComposing) return;
        ev.preventDefault(); transport.fire(); return;
      }
      if (ev.key === 'Escape') {
        var menu = $('#st-pv-menu');
        if (menu && !menu.hidden) { menu.hidden = true; return; }
        if (armedButtons.length) { disarmAll(); return; }
        if (armedPreset && armedPreset._disarm) { armedPreset._disarm(); return; }
        if ($('#st-primary').classList.contains('st-armed')) { transport.disarm(); return; }
        if (!isField(document.activeElement)) clearSelection();
        return;
      }
      if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        ev.preventDefault(); walkSelection(ev.key === 'ArrowDown' ? 1 : -1);
      }
    });
  }

  /* -------------------------------------------------------- wide + split */
  function buildWide() {
    var mq = window.matchMedia ? window.matchMedia('(min-width: 900px)') : null;
    function apply() {
      var wide = !!(mq && mq.matches);
      if (wide === document.body.classList.contains('st-wide')) return;
      document.body.classList.toggle('st-wide', wide);
      lastCrop = null;
      fitPreview();
    }
    setInterval(apply, 700);
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply); }
    window.addEventListener('resize', apply);
    apply();
    var saved = parseInt(load('lt-studio-split'), 10);
    if (saved > 0) $('#st-app').style.setProperty('--st-split', saved + 'px');
    var split = $('#st-split'), app = $('#st-app'), sess = null;
    split.addEventListener('pointerdown', function (ev) {
      if (sess) return;
      ev.preventDefault();
      sess = { pointerId: ev.pointerId, target: ev.target, px: null };
      document.body.classList.add('st-splitting'); split.classList.add('st-dragging');
      try { ev.target.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      function move(e2) {
        if (!sess || e2.pointerId !== sess.pointerId) return;
        if (e2.buttons === 0) { end(); return; }
        var ar = app.getBoundingClientRect();
        var px = Math.max(420, Math.min(ar.width - 380 - 10, e2.clientX - ar.left));
        sess.px = px;
        app.style.setProperty('--st-split', px + 'px');
        fitPreview();
      }
      function end(e2) {
        if (!sess) return;
        if (e2 && e2.pointerId != null && e2.pointerId !== sess.pointerId) return;
        try { sess.target.releasePointerCapture(sess.pointerId); } catch (e) { /* ignore */ }
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
        document.removeEventListener('visibilitychange', end);
        sess.target.removeEventListener('lostpointercapture', end);
        document.body.classList.remove('st-splitting'); split.classList.remove('st-dragging');
        if (sess.px) store('lt-studio-split', String(Math.round(sess.px)));
        sess = null;
        fitPreview();
      }
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
      window.addEventListener('blur', end);
      document.addEventListener('visibilitychange', end);
      ev.target.addEventListener('lostpointercapture', end);
    });
    split.addEventListener('dblclick', function () { store('lt-studio-split', null); app.style.removeProperty('--st-split'); fitPreview(); });
  }

  /* -------------------------------------------------------------- boot */
  function buildAll() {
    buildPreview(); buildReadout(); buildTransport(); buildDesignShell(); buildKeys(); buildWide();
    buildLook();
    reg(syncStatus); reg(syncPreview); reg(syncReadout); reg(syncTransport);
    reg(function () { renderCue(false); });
    reg(function () { inspector.sync(); });
    reg(function () { renderMap(); });
    reg(function () { lookSyncs.forEach(function (f) { f(); }); });
    var place = load('lt-studio-place');
    setPlace(place === 'design' ? 'design' : 'air');
    fetchFonts();
    /* the font uploads list lives in the look; rebuild the datalist only when it changes */
    var fontSig = null;
    reg(function () {
      var sig = FONTLIST.length + '|' + uploadsArr().map(function (f) { return f && f.name; }).join('|');
      if (sig === fontSig) return;
      fontSig = sig; fillFontDatalist();
    });
  }

  function onMessage(msg) {
    var t = msg.type;
    if (t === 'hello') {
      S = msg.state;
      NATIVE = !!(msg.state && msg.state.native);
      obsStatus = msg.obs || obsStatus;
      counts = msg.counts || counts;
      if (!built) { buildAll(); built = true; }
      renderCue(true); renderPresets(); inspector.point(selectedId);
      refresh(); fitPreview();
      emit('hello');
      return;
    }
    if (!S) return;
    if (t === 'pending') { S.pending = msg.pending; reapplyInFlight(); }
    else if (t === 'anim') { S.anim = msg.anim; reapplyInFlight(); }
    else if (t === 'settings') { S.settings = msg.settings; reapplyInFlight(); }
    else if (t === 'presets') { S.presets = msg.presets; renderPresets(); }
    else if (t === 'snippets') { S.snippets = msg.snippets; }
    else if (t === 'commit') { S.live = msg.live; }
    else if (t === 'show') { S.live = msg.live; S.visible = true; S.shownAt = msg.shownAt || Date.now(); }
    else if (t === 'hide') { S.visible = false; }
    else if (t === 'obs') { obsStatus = msg; }
    else if (t === 'counts') { counts = msg.counts; }
    emit(t);
    refresh();
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    sock = new WebSocket(proto + location.host + '/ws?role=control');
    sock.onopen = function () { document.body.classList.remove('offline'); };
    sock.onmessage = function (ev) { try { onMessage(JSON.parse(ev.data)); } catch (e) { /* ignore */ } };
    sock.onclose = function () { document.body.classList.add('offline'); setTimeout(connect, 1500); };
    sock.onerror = function () { try { sock.close(); } catch (e) { /* ignore */ } };
  }
  connect();

})();
