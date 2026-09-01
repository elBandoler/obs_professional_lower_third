/* OBS Lower Thirds — control panel logic (dynamic element model) */
(function () {
  'use strict';

  var S = null;          // full public state from server
  var NATIVE = false;    // true when served by the native OBS plugin
  var obsStatus = { status: 'off', studioMode: false };
  var counts = { program: 0, preview: 0, control: 0 };
  var built = false;
  var sock = null;

  /* ------------------------------------------------------------ helpers */

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  var REPLACING = { revert: 1, 'preset-load': 1, 'snippet-load': 1, 'reset-style': 1, 'preset-restore': 1 };
  function send(msg) {
    if (msg && REPLACING[msg.type]) clearAllInFlight();
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(msg));
  }

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

  /* global (non-element) fields ------------------------------------- */

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

  var throttleTimers = {};

  /* Edits are applied locally at once and sent throttled. A broadcast that
     was already in flight would otherwise overwrite the value the operator
     just set, so every in-flight edit is re-applied on top of server state
     until the server has echoed it back. */
  var inFlight = {};

  /* Only edits that have NOT reached the server yet are re-applied. Once a
     value is sent the server is the authority again, so an explicit action
     (discard, preset-load, snippet recall) is never fought by a stale local
     value. Replacing actions also clear the guard outright. */
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

  /* leading + trailing throttle: the first move goes out at once so the
     preview tracks a drag, the rest are coalesced */
  var lastSent = {};
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
    refreshMeta();
  }

  /* element fields --------------------------------------------------- */

  function elements() { return (S && S.pending && S.pending.elements) || []; }
  function findEl(id) {
    return elements().filter(function (e) { return e.id === id; })[0];
  }
  /* saved texts live beside the look, not inside it, so saving one never
     dirties the state and loading a preset never wipes them */
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
    refreshMeta();
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

  /* ------------------------------------------------- generic row builder */

  /* spec: {type,label,unit,min,max,step,options,placeholder,title,lazy}
     get(): current value    set(v): store it */
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
      input.addEventListener('change', function () { spec.set(input.checked); if (spec.rebuild) scheduleRebuild(); });
    } else if (spec.type === 'select') {
      input = el('select');
      spec.options.forEach(function (o) {
        var opt = el('option');
        opt.value = o.v; opt.textContent = o.l;
        input.appendChild(opt);
      });
      input.addEventListener('change', function () { spec.set(input.value); if (spec.rebuild) scheduleRebuild(); });
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
      input.setAttribute('list', 'fontlist');
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

  /* image upload target ------------------------------------------------ */

  var pendingImageSetter = null;
  function pickImage(setter) {
    pendingImageSetter = setter;
    $('#logo-file').click();
  }

  /* ------------------------------------------------------ gradient editor */

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

  /* ---------------------------------------------------------- snippets */

  function buildSnippets(elem, compact) {
    var id = elem.id;
    var wrap = el('div', 'snip-wrap');

    var lastSig = null;
    function render() {
      var e = findEl(id);
      if (!e || e.kind !== 'text') { wrap.innerHTML = ''; lastSig = null; return; }
      /* rebuilding under the operator's finger swallows the click */
      var sig = snippetsOf(id).map(function (s) { return s.id + ':' + s.label; }).join('|');
      if (sig === lastSig) return;
      lastSig = sig;
      wrap.innerHTML = '';
      var list = el('div', 'snip-list');
      snippetsOf(id).forEach(function (s) {
        var b = el('button', 'snip', s.label || s.text || '—');
        b.title = 'Load this text into the preview (then press SHOW or TAKE)';
        b.addEventListener('click', function () {
          send({ type: 'snippet-load', id: id, snippetId: s.id });
        });
        var x = el('button', 'snip-x', '✕');
        x.title = 'Delete this saved text';
        x.addEventListener('click', function () {
          send({ type: 'snippet-delete', id: id, snippetId: s.id });
        });
        var g = el('span', 'snip-group');
        g.appendChild(b); g.appendChild(x);
        list.appendChild(g);
      });
      /* No window.prompt(): it is unreliable inside OBS's embedded browser.
         The saved text itself is the label, which is what an operator scans for. */
      var save = el('button', 'snip snip-save', '＋ save text');
      save.title = 'Save this element’s current text so you can recall it later';
      save.addEventListener('click', function () {
        var cur = findEl(id);
        var text = (cur && cur.text) || '';
        if (!text.trim()) return;
        send({ type: 'snippet-save', id: id, label: text.slice(0, 40), text: text });
      });
      list.appendChild(save);
      wrap.appendChild(list);
    }
    render();
    return { node: wrap, sync: render };
  }

  /* ------------------------------------------------------- element cards */

  var elementSyncs = [];

  /* Only STRUCTURAL facts belong here — things that change which rows exist.
     Values (colours, positions, sizes) are pushed through sync() instead, so
     a live broadcast never rebuilds the DOM under a slider or a drag. */
  function elementSignature() {
    return elements().map(function (e) {
      var st = e.style || {};
      /* NOTE: e.name is deliberately absent — it changes on every keystroke and
         rebuilding the list would steal focus from the Name field */
      return [e.id, e.kind, e.place.row, e.place.col, e.place.order,
              e.place.spanAll ? 1 : 0,
              snippetsOf(e.id).length,
              (st.gradient && st.gradient.enabled) ? 1 : 0,
              st.gradient && st.gradient.type,
              ((st.gradient && st.gradient.stops) || []).length,
              (st.bgImage && st.bgImage.enabled) ? 1 : 0,
              st.edges && st.edges.mode,
              st.accent && st.accent.mode].join(':');
    }).join('|');
  }

  var lastSig = null;
  var rebuildTimer = null;
  function scheduleRebuild() {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(function () { rebuildTimer = null; renderElements(true); }, 30);
  }

  var ALIGNS = [{ v: 'auto', l: 'Auto' }, { v: 'start', l: 'Start' }, { v: 'center', l: 'Center' }, { v: 'end', l: 'End' }];
  var FITS = [{ v: 'cover', l: 'Cover (fill)' }, { v: 'contain', l: 'Contain' }, { v: 'stretch', l: 'Stretch' }, { v: 'tile', l: 'Tile' }];

  function elementCard(e) {
    var id = e.id;
    var card = el('details', 'el-card');
    card.open = !!openCards[id];
    card.addEventListener('toggle', function () { openCards[id] = card.open; });

    /* ---- header ---- */
    var sum = el('summary', 'el-head');

    var en = el('input', 'el-en');
    en.type = 'checkbox';
    en.checked = e.enabled !== false;
    en.title = 'Show this element';
    en.addEventListener('click', function (ev) { ev.stopPropagation(); });
    en.addEventListener('change', function () { sendEl(id, 'enabled', en.checked); });

    var nm = el('span', 'el-name', e.name || (e.kind === 'image' ? 'Image' : 'Text'));
    var kindTag = el('span', 'el-kind', e.kind === 'image' ? 'IMG' : 'TXT');
    var pos = el('span', 'el-pos', 'r' + (e.place.row + 1) + '·c' + (e.place.col + 1));

    sum.appendChild(en);
    sum.appendChild(nm);
    sum.appendChild(kindTag);
    sum.appendChild(pos);
    card.appendChild(sum);

    var body = el('div', 'el-body');
    card.appendChild(body);

    var syncs = [];
    function add(spec) {
      var r = makeRow(spec);
      body.appendChild(r.row);
      syncs.push(r.sync);
    }
    function addNode(n) { body.appendChild(n); }

    /* ---- placement ---- */
    var move = el('div', 'el-move');
    [['▲', 'up', 'Move to the row above'],
     ['▼', 'down', 'Move to the row below'],
     ['◀', 'left', 'Move one column left'],
     ['▶', 'right', 'Move one column right']].forEach(function (m) {
      var b = el('button', 'mini', m[0]);
      b.title = m[2];
      b.addEventListener('click', function () { send({ type: 'element-move', id: id, dir: m[1] }); });
      move.appendChild(b);
    });
    var nr = el('button', 'mini wide', 'own row');
    nr.title = 'Put this element on a new row of its own';
    nr.addEventListener('click', function () { send({ type: 'element-newrow', id: id }); });
    move.appendChild(nr);
    var dup = el('button', 'mini wide', '⧉ copy');
    dup.title = 'Duplicate this element';
    dup.addEventListener('click', function () { send({ type: 'element-duplicate', id: id }); });
    move.appendChild(dup);
    var del = el('button', 'mini wide danger', '✕ remove');
    del.title = 'Delete this element (click twice)';
    del.addEventListener('click', function () {
      if (del.dataset.armed) { send({ type: 'element-remove', id: id }); return; }
      del.dataset.armed = '1';
      del.textContent = '✕ sure?';
      setTimeout(function () { delete del.dataset.armed; del.textContent = '✕ remove'; }, 2500);
    });
    move.appendChild(del);
    addNode(move);

    /* no scheduleRebuild here: the card header is refreshed by syncHead(), and
       rebuilding the list would replace this input and steal focus mid-word */
    add({ type: 'text', label: 'Name', get: function () { return findEl(id) ? findEl(id).name : ''; },
      set: function (v) { sendEl(id, 'name', v); } });

    if (e.kind === 'text') {
      add({ type: 'text', label: 'Text', get: function () { var x = findEl(id); return x ? x.text : ''; },
        set: function (v) { sendEl(id, 'text', v); } });
      var sn = buildSnippets(e);
      addNode(sn.node);
      syncs.push(sn.sync);
    } else {
      add({ type: 'imagepick', label: 'Image', get: function () { return dig(findEl(id) || {}, 'image.url'); },
        set: function (v) { sendEl(id, 'image.url', v); } });
      add({ type: 'select', label: 'Image fit', options: [{ v: 'contain', l: 'Contain' }, { v: 'cover', l: 'Cover' }, { v: 'fill', l: 'Stretch' }],
        get: function () { return dig(findEl(id) || {}, 'image.fit'); }, set: function (v) { sendEl(id, 'image.fit', v); } });
      add({ type: 'slider', label: 'Image size', min: 0.2, max: 1, step: 0.05, unit: '×',
        title: 'Size inside its box — give the element more room with padding or min width to make the picture bigger',
        get: function () { return dig(findEl(id) || {}, 'image.scale'); }, set: function (v) { sendEl(id, 'image.scale', v); } });
    }

    add({ type: 'subhead', label: 'PLACEMENT' });
    add({ type: 'toggle', label: 'Stretch to fill', title: 'Take up the remaining width of the row',
      get: function () { return dig(findEl(id) || {}, 'place.stretch'); }, set: function (v) { sendEl(id, 'place.stretch', v); } });
    add({ type: 'select', label: 'Pin to edge',
      options: [{ v: 'auto', l: 'Auto' }, { v: 'left', l: 'Far left' }, { v: 'right', l: 'Far right' }],
      title: 'Push this element to one side of its row. Two elements sharing a row can then sit at opposite edges — e.g. one hard left, one tucked against the logo.',
      get: function () { return dig(findEl(id) || {}, 'place.pin'); },
      set: function (v) { sendEl(id, 'place.pin', v); } });
    add({ type: 'toggle', label: 'Full height', title: 'Span every row — e.g. a logo standing beside the whole block',
      get: function () { return dig(findEl(id) || {}, 'place.spanAll'); }, set: function (v) { sendEl(id, 'place.spanAll', v); scheduleRebuild(); } });
    add({ type: 'slider', label: 'Min width', min: 0, max: 600, step: 5, unit: 'px',
      get: function () { return dig(findEl(id) || {}, 'style.minWidth'); }, set: function (v) { sendEl(id, 'style.minWidth', v); } });

    add({ type: 'subhead', label: 'COLOURS' });
    add({ type: 'color', label: 'Background', get: function () { return dig(findEl(id) || {}, 'style.bg'); }, set: function (v) { sendEl(id, 'style.bg', v); } });
    add({ type: 'slider', label: 'Bg opacity', min: 0, max: 1, step: 0.01, unit: '%pct',
      get: function () { return dig(findEl(id) || {}, 'style.bgOpacity'); }, set: function (v) { sendEl(id, 'style.bgOpacity', v); } });
    if (e.kind === 'text') {
      add({ type: 'color', label: 'Text colour', get: function () { return dig(findEl(id) || {}, 'style.color'); }, set: function (v) { sendEl(id, 'style.color', v); } });
    }

    add({ type: 'toggle', label: 'Gradient', rebuild: true,
      get: function () { return dig(findEl(id) || {}, 'style.gradient.enabled'); },
      set: function (v) { sendEl(id, 'style.gradient.enabled', v); } });
    if (e.style.gradient && e.style.gradient.enabled) {
      add({ type: 'select', label: 'Gradient type', options: [{ v: 'linear', l: 'Linear' }, { v: 'radial', l: 'Radial' }, { v: 'conic', l: 'Conic / angle' }], rebuild: true,
        get: function () { return dig(findEl(id) || {}, 'style.gradient.type'); }, set: function (v) { sendEl(id, 'style.gradient.type', v); } });
      var gtype = e.style.gradient.type;
      if (gtype !== 'radial') {
        add({ type: 'slider', label: 'Angle', min: 0, max: 360, step: 1, unit: '°',
          get: function () { return dig(findEl(id) || {}, 'style.gradient.angle'); }, set: function (v) { sendEl(id, 'style.gradient.angle', v); } });
      }
      if (gtype === 'radial') {
        add({ type: 'select', label: 'Shape', options: [{ v: 'ellipse', l: 'Ellipse' }, { v: 'circle', l: 'Circle' }],
          get: function () { return dig(findEl(id) || {}, 'style.gradient.shape'); }, set: function (v) { sendEl(id, 'style.gradient.shape', v); } });
      }
      if (gtype === 'radial' || gtype === 'conic') {
        add({ type: 'slider', label: 'Centre X', min: 0, max: 100, step: 1, unit: '%',
          get: function () { return dig(findEl(id) || {}, 'style.gradient.posX'); }, set: function (v) { sendEl(id, 'style.gradient.posX', v); } });
        add({ type: 'slider', label: 'Centre Y', min: 0, max: 100, step: 1, unit: '%',
          get: function () { return dig(findEl(id) || {}, 'style.gradient.posY'); }, set: function (v) { sendEl(id, 'style.gradient.posY', v); } });
      }
      var ge = buildGradientEditor(e);
      addNode(ge.node);
      syncs.push(ge.sync);
    }

    add({ type: 'toggle', label: 'Background image', rebuild: true,
      title: 'The colour above becomes a tint over the picture — lower its opacity to reveal more image',
      get: function () { return dig(findEl(id) || {}, 'style.bgImage.enabled'); },
      set: function (v) { sendEl(id, 'style.bgImage.enabled', v); } });
    if (e.style.bgImage && e.style.bgImage.enabled) {
      add({ type: 'imagepick', label: 'Picture', get: function () { return dig(findEl(id) || {}, 'style.bgImage.url'); }, set: function (v) { sendEl(id, 'style.bgImage.url', v); } });
      add({ type: 'select', label: 'Picture fit', options: FITS,
        get: function () { return dig(findEl(id) || {}, 'style.bgImage.fit'); }, set: function (v) { sendEl(id, 'style.bgImage.fit', v); } });
    }

    if (e.kind === 'text') {
      add({ type: 'subhead', label: 'TYPE' });
      add({ type: 'fontpick', label: 'Font',
        title: 'Font for this element only. Leave empty to follow the default font set under FONTS.',
        get: function () { return dig(findEl(id) || {}, 'style.fontFamily'); },
        set: function (v) { sendEl(id, 'style.fontFamily', v); } });
      add({ type: 'slider', label: 'Size', min: 8, max: 160, step: 1, unit: 'px',
        get: function () { return dig(findEl(id) || {}, 'style.size'); }, set: function (v) { sendEl(id, 'style.size', v); } });
      add({ type: 'slider', label: 'Weight', min: 100, max: 900, step: 100,
        get: function () { return dig(findEl(id) || {}, 'style.weight'); }, set: function (v) { sendEl(id, 'style.weight', v); } });
      add({ type: 'slider', label: 'Letter spacing', min: -3, max: 24, step: 0.5, unit: 'px',
        get: function () { return dig(findEl(id) || {}, 'style.letterSpacing'); }, set: function (v) { sendEl(id, 'style.letterSpacing', v); } });
      add({ type: 'slider', label: 'Line height', min: 0.8, max: 2.4, step: 0.02, unit: '×',
        get: function () { return dig(findEl(id) || {}, 'style.lineHeight'); }, set: function (v) { sendEl(id, 'style.lineHeight', v); } });
      add({ type: 'select', label: 'Align', options: ALIGNS,
        get: function () { return dig(findEl(id) || {}, 'style.align'); }, set: function (v) { sendEl(id, 'style.align', v); } });
      add({ type: 'toggle', label: 'Never wrap',
        get: function () { return dig(findEl(id) || {}, 'style.nowrap'); }, set: function (v) { sendEl(id, 'style.nowrap', v); } });
    }

    add({ type: 'subhead', label: 'BOX' });
    add({ type: 'slider', label: 'Pad horizontal', min: 0, max: 90, step: 1, unit: 'px',
      get: function () { return dig(findEl(id) || {}, 'style.padX'); }, set: function (v) { sendEl(id, 'style.padX', v); } });
    add({ type: 'slider', label: 'Pad vertical', min: 0, max: 70, step: 1, unit: 'px',
      get: function () { return dig(findEl(id) || {}, 'style.padY'); }, set: function (v) { sendEl(id, 'style.padY', v); } });
    add({ type: 'select', label: 'Edges', options: [{ v: 'inherit', l: 'Same as global' }, { v: 'square', l: 'Square' }, { v: 'rounded', l: 'Rounded' }, { v: 'chamfer', l: 'Slanted' }], rebuild: true,
      get: function () { return dig(findEl(id) || {}, 'style.edges.mode'); }, set: function (v) { sendEl(id, 'style.edges.mode', v); } });
    if (e.style.edges && e.style.edges.mode === 'rounded') {
      add({ type: 'slider', label: 'Corner radius', min: 0, max: 60, step: 1, unit: 'px',
        get: function () { return dig(findEl(id) || {}, 'style.edges.radius'); }, set: function (v) { sendEl(id, 'style.edges.radius', v); } });
    }
    if (e.style.edges && e.style.edges.mode === 'chamfer') {
      add({ type: 'slider', label: 'Slant amount', min: 4, max: 80, step: 1, unit: 'px',
        get: function () { return dig(findEl(id) || {}, 'style.edges.chamfer'); }, set: function (v) { sendEl(id, 'style.edges.chamfer', v); } });
    }
    add({ type: 'select', label: 'Accent strip', options: [{ v: 'none', l: 'None' }, { v: 'top', l: 'Top' }, { v: 'bottom', l: 'Bottom' }, { v: 'side', l: 'Side' }], rebuild: true,
      get: function () { return dig(findEl(id) || {}, 'style.accent.mode'); }, set: function (v) { sendEl(id, 'style.accent.mode', v); } });
    if (e.style.accent && e.style.accent.mode !== 'none') {
      add({ type: 'color', label: 'Accent colour', get: function () { return dig(findEl(id) || {}, 'style.accent.color'); }, set: function (v) { sendEl(id, 'style.accent.color', v); } });
      add({ type: 'slider', label: 'Accent size', min: 1, max: 30, step: 1, unit: 'px',
        get: function () { return dig(findEl(id) || {}, 'style.accent.thickness'); }, set: function (v) { sendEl(id, 'style.accent.thickness', v); } });
    }

    function syncHead() {
      var cur = findEl(id);
      if (!cur) return;
      if (en !== document.activeElement) en.checked = cur.enabled !== false;
      var label = cur.name || (cur.kind === 'image' ? 'Image' : 'Text');
      if (nm.textContent !== label) nm.textContent = label;
      var where = cur.place.spanAll ? 'full' : ('r' + (cur.place.row + 1) + '·c' + (cur.place.col + 1));
      if (pos.textContent !== where) pos.textContent = where;
    }

    return {
      card: card,
      sync: function () { syncHead(); syncs.forEach(function (s) { s(); }); },
    };
  }

  var openCards = {};

  function renderElements(force) {
    var host = $('#el-list');
    if (!host || !S) return;
    var sig = elementSignature();
    if (!force && sig === lastSig) {
      elementSyncs.forEach(function (s) { s(); });
      return;
    }
    lastSig = sig;
    host.innerHTML = '';
    elementSyncs = [];

    /* group visually by row so the list mirrors the layout */
    var byRow = {};
    elements().forEach(function (e) {
      var r = e.place.spanAll ? 'full' : e.place.row;
      (byRow[r] = byRow[r] || []).push(e);
    });
    Object.keys(byRow).sort(function (a, b) {
      if (a === 'full') return 1;
      if (b === 'full') return -1;
      return a - b;
    }).forEach(function (r) {
      var head = el('div', 'row-head', r === 'full' ? 'FULL HEIGHT' : ('ROW ' + (parseInt(r, 10) + 1)));
      host.appendChild(head);
      byRow[r].sort(function (a, b) {
        return (a.place.col - b.place.col) || (a.place.order - b.place.order);
      }).forEach(function (e) {
        var c = elementCard(e);
        host.appendChild(c.card);
        elementSyncs.push(c.sync);
      });
    });

    elementSyncs.forEach(function (s) { s(); });
    renderSimple(true);
  }

  /* --------------------------------------------------------- simple mode */

  var simpleSyncs = [];
  var simpleSig = null;

  function renderSimple(force) {
    var host = $('#simple-texts');
    if (!host || !S) return;
    var texts = elements().filter(function (e) { return e.kind === 'text' && e.enabled !== false; });
    var sig = texts.map(function (e) { return e.id + ':' + snippetsOf(e.id).length + ':' + e.name; }).join('|');
    if (!force && sig === simpleSig) {
      simpleSyncs.forEach(function (s) { s(); });
      return;
    }
    simpleSig = sig;
    host.innerHTML = '';
    simpleSyncs = [];

    if (!texts.length) {
      host.appendChild(el('div', 'hint', 'No text elements — switch to ADVANCED to add one.'));
      return;
    }

    texts.forEach(function (e) {
      var block = el('div', 'simple-block');
      var r = makeRow({
        type: 'text', label: e.name || 'Text',
        get: function () { var x = findEl(e.id); return x ? x.text : ''; },
        set: function (v) { sendEl(e.id, 'text', v); },
      });
      block.appendChild(r.row);
      simpleSyncs.push(r.sync);
      var sn = buildSnippets(e, true);
      block.appendChild(sn.node);
      simpleSyncs.push(sn.sync);
      host.appendChild(block);
    });
    simpleSyncs.forEach(function (s) { s(); });
  }

  /* ------------------------------------------------- global field schema */

  var A_STYLES = [
    { v: 'slide-up', l: 'Slide up' },
    { v: 'slide-side', l: 'Slide from side' },
    { v: 'wipe', l: 'Wipe' },
    { v: 'fade', l: 'Fade' },
    { v: 'pop', l: 'Pop' },
  ];
  function notFullWidth() { return !getVal('style.layout.fullWidth'); }

  function g(path) { return function () { return getVal(path); }; }
  function s(path) { return function (v) { sendField(path, v); }; }

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

    { sec: 'edges', type: 'select', label: 'Edge style', options: [{ v: 'square', l: 'Square' }, { v: 'rounded', l: 'Rounded' }, { v: 'chamfer', l: 'Slanted' }], get: g('style.edges.style'), set: s('style.edges.style') },
    { sec: 'edges', type: 'slider', label: 'Corner radius', min: 0, max: 60, step: 1, unit: 'px', get: g('style.edges.radius'), set: s('style.edges.radius') },
    { sec: 'edges', type: 'slider', label: 'Slant amount', min: 0, max: 80, step: 1, unit: 'px', get: g('style.edges.chamfer'), set: s('style.edges.chamfer') },
    { sec: 'edges', type: 'slider', label: 'Shadow', min: 0, max: 100, step: 1, get: g('style.shadow'), set: s('style.shadow') },

    { sec: 'anim', type: 'toggle', label: 'Enable animations', title: 'Off = TAKE / OBS Transition applies changes instantly', get: g('anim.enabled'), set: s('anim.enabled') },
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
    { sec: 'obs', type: 'toggle', label: 'TAKE on Transition', get: g('settings.obs.commitOnTransition'), set: s('settings.obs.commitOnTransition') },
    { sec: 'obs', type: 'toggle', label: 'Only in Studio Mode', get: g('settings.obs.onlyStudioMode'), set: s('settings.obs.onlyStudioMode') },
    { sec: 'obs', type: 'select', label: 'Transition does', options: [{ v: 'take', l: 'Commit changes' }, { v: 'take-show', l: 'Commit + show if hidden' }], get: g('settings.obs.transitionAction'), set: s('settings.obs.transitionAction') },
  ];

  var SECTIONS = [
    { id: 'simple', label: 'QUICK', open: true },
    { id: 'elements', label: 'ELEMENTS', open: true },
    { id: 'layout', label: 'LAYOUT & POSITION' },
    { id: 'type', label: 'FONTS' },
    { id: 'edges', label: 'EDGES & EFFECTS' },
    { id: 'anim', label: 'ANIMATION' },
    { id: 'presets', label: 'PRESETS', open: true },
    { id: 'obs', label: 'OBS & INTEGRATIONS' },
  ];

  var globalSyncs = [];

  function buildSections() {
    var main = $('#sections');
    SECTIONS.forEach(function (sec) {
      var det = el('details', 'sec');
      det.id = 'sec-' + sec.id;
      if (sec.open) det.open = true;
      det.appendChild(el('summary', null, sec.label));
      var body = el('div', 'sec-body');
      body.id = 'sec-body-' + sec.id;
      det.appendChild(body);
      main.appendChild(det);
    });

    GLOBAL_FIELDS.forEach(function (f) {
      var r = makeRow(f);
      $('#sec-body-' + f.sec).appendChild(r.row);
      globalSyncs.push(r.sync);
    });

    buildSimpleUi();
    buildElementsUi();
    buildFontExtras();
    buildPresetUi();
    buildObsExtras();
    fetchFonts();
  }

  function buildSimpleUi() {
    var body = $('#sec-body-simple');
    body.appendChild(el('div', 'hint', 'Tap a preset to load it, edit the text, then press SHOW or TAKE.'));
    var grid = el('div', null);
    grid.id = 'quick-grid';
    body.appendChild(grid);
    var texts = el('div', null);
    texts.id = 'simple-texts';
    body.appendChild(texts);
  }

  function buildElementsUi() {
    var body = $('#sec-body-elements');
    var list = el('div', null);
    list.id = 'el-list';
    body.appendChild(list);

    var addRow = el('div', 'el-add');
    var addT = el('button', null, '＋ text');
    addT.addEventListener('click', function () { send({ type: 'element-add', kind: 'text' }); });
    var addI = el('button', null, '＋ image');
    addI.addEventListener('click', function () { send({ type: 'element-add', kind: 'image' }); });
    addRow.appendChild(addT);
    addRow.appendChild(addI);
    body.appendChild(addRow);
  }

  /* fonts ------------------------------------------------------------ */

  var FONTLIST = [];
  function uploadsArr() {
    var u = getVal('style.font.uploads');
    return Array.isArray(u) ? u : [];
  }
  function fetchFonts() {
    fetch('/api/fonts').then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && Array.isArray(j.fonts)) { FONTLIST = j.fonts; fillFontDatalist(); }
    }).catch(function () { /* older server */ });
  }
  function fillFontDatalist() {
    var dl = $('#fontlist');
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
  function applyFontFamily(name) {
    sendField('style.font.family', '"' + String(name).replace(/["\\]/g, '') + '", \'Segoe UI\', Arial, sans-serif');
    syncAll();
  }
  function buildFontExtras() {
    var body = $('#sec-body-type');
    var wrap = el('div', null);
    wrap.id = 'font-tools';

    var pickRow = el('div', 'row');
    pickRow.appendChild(el('label', 'lbl', 'Pick a font'));
    var pctl = el('div', 'ctl');
    var pick = el('input');
    pick.type = 'text';
    pick.setAttribute('list', 'fontlist');
    pick.placeholder = 'default font — type to search fonts on this PC…';
    pick.addEventListener('change', function () { if (pick.value.trim()) applyFontFamily(pick.value.trim()); });
    pctl.appendChild(pick);
    pickRow.appendChild(pctl);
    wrap.appendChild(pickRow);

    var upRow = el('div', 'row');
    upRow.appendChild(el('label', 'lbl', 'Font file'));
    var uctl = el('div', 'ctl');
    var upBtn = el('button', null, '⬆ upload .ttf / .otf / .woff2');
    upBtn.addEventListener('click', function () { $('#font-file').click(); });
    uctl.appendChild(upBtn);
    upRow.appendChild(uctl);
    wrap.appendChild(upRow);

    var list = el('div', null);
    list.id = 'upfont-list';
    wrap.appendChild(list);
    body.insertBefore(wrap, body.firstChild);
  }

  var upFontCache = '';
  function renderUploadedFonts() {
    var list = $('#upfont-list');
    if (!list || !S) return;
    var arr = uploadsArr();
    var key = JSON.stringify(arr);
    if (key === upFontCache) return;
    upFontCache = key;
    list.innerHTML = '';
    arr.forEach(function (f, i) {
      if (!f || !f.url) return;
      var row = el('div', 'upfont-row');
      row.appendChild(el('span', 'upfont-name', f.name || 'font'));
      var use = el('button', null, 'use');
      use.addEventListener('click', function () { applyFontFamily(f.name); });
      var del = el('button', null, '✕');
      del.addEventListener('click', function () {
        sendField('style.font.uploads', uploadsArr().filter(function (_, idx) { return idx !== i; }));
        upFontCache = '';
        renderUploadedFonts();
        fillFontDatalist();
      });
      row.appendChild(use);
      row.appendChild(del);
      list.appendChild(row);
    });
    fillFontDatalist();
  }

  /* presets ---------------------------------------------------------- */

  function buildPresetUi() {
    var body = $('#sec-body-presets');
    var list = el('div', null);
    list.id = 'preset-list';
    body.appendChild(list);

    var saveRow = el('div', 'preset-save-row');
    var nameIn = el('input');
    nameIn.type = 'text';
    nameIn.placeholder = 'new preset name…';
    var saveBtn = el('button', null, '＋ save');
    saveBtn.title = 'Save the whole current look as a preset';
    saveBtn.addEventListener('click', function () {
      send({ type: 'preset-save', name: nameIn.value.trim() || ('Preset ' + (S.presets.length + 1)) });
      nameIn.value = '';
    });
    saveRow.appendChild(nameIn);
    saveRow.appendChild(saveBtn);
    body.appendChild(saveRow);

    var restore = el('button', 'link-btn', 'restore built-in presets');
    restore.addEventListener('click', function () { send({ type: 'preset-restore' }); });
    body.appendChild(restore);
  }

  function renderPresets() {
    var qg = $('#quick-grid');
    if (qg && S) {
      qg.innerHTML = '';
      if (!S.presets.length) {
        qg.appendChild(el('div', 'hint', 'No presets yet — build a look in ADVANCED and save it.'));
      }
      S.presets.forEach(function (p) {
        var b = el('button', 'quick-preset', p.name);
        b.title = 'Load "' + p.name + '" into the preview — then TAKE or SHOW';
        b.addEventListener('click', function () { send({ type: 'preset-load', id: p.id }); });
        qg.appendChild(b);
      });
    }

    var list = $('#preset-list');
    if (!list) return;
    list.innerHTML = '';
    if (!S.presets.length) list.appendChild(el('div', 'hint', 'No presets yet.'));
    S.presets.forEach(function (p) {
      var row = el('div', 'preset-row');
      var load = el('button', 'preset-load', p.name);
      load.title = 'Load into preview (press TAKE or SHOW to put it on air)';
      load.addEventListener('click', function () { send({ type: 'preset-load', id: p.id }); });
      var upd = el('button', 'preset-mini', '⤓');
      upd.title = 'Overwrite this preset with the current look';
      upd.addEventListener('click', function () { send({ type: 'preset-update', id: p.id }); });
      var del = el('button', 'preset-mini', '✕');
      del.title = 'Delete preset (click twice)';
      del.addEventListener('click', function () {
        if (del.dataset.armed) { send({ type: 'preset-delete', id: p.id }); return; }
        del.dataset.armed = '1';
        del.textContent = '✕?';
        setTimeout(function () { delete del.dataset.armed; del.textContent = '✕'; }, 2500);
      });
      row.appendChild(load); row.appendChild(upd); row.appendChild(del);
      list.appendChild(row);
    });
  }

  /* obs & integration extras ----------------------------------------- */

  function buildObsExtras() {
    var body = $('#sec-body-obs');
    var status = el('div', 'hint');
    status.id = 'obs-hint';
    body.insertBefore(status, body.firstChild);

    body.appendChild(el('div', 'subhead', 'URLS & API'));
    [
      { l: 'Program overlay (browser source)', u: location.origin + '/overlay' },
      { l: 'Preview mirror', u: location.origin + '/overlay?role=preview' },
      { l: 'Control panel', u: location.origin + '/control' },
      { l: 'Hotkey: take', u: location.origin + '/api/take' },
      { l: 'Hotkey: show', u: location.origin + '/api/show' },
      { l: 'Hotkey: hide', u: location.origin + '/api/hide' },
    ].forEach(function (x) {
      var kv = el('div', 'kv');
      kv.title = x.l;
      var code = el('code', null, x.u);
      var btn = el('button', null, 'copy');
      btn.addEventListener('click', function () {
        copyText(x.u);
        btn.textContent = '✓';
        setTimeout(function () { btn.textContent = 'copy'; }, 1200);
      });
      kv.appendChild(code); kv.appendChild(btn);
      body.appendChild(kv);
    });

    body.appendChild(el('div', 'subhead', 'MAINTENANCE'));
    var reset = el('button', 'link-btn', 'reset global style to defaults (keeps elements)');
    reset.addEventListener('click', function () { send({ type: 'reset-style' }); });
    body.appendChild(reset);
  }

  function obsHintText() {
    var st = obsStatus.status;
    if (NATIVE) {
      return 'Running inside OBS (native plugin) — the Transition button commits pending changes automatically' +
        (obsStatus.studioMode ? '. Studio Mode is ON.' : '. Enable Studio Mode in OBS to use the preview/transition workflow.');
    }
    if (st === 'off') return 'Enable to let the OBS “Transition” button TAKE your changes. In OBS: Tools → WebSocket Server Settings → Enable, then copy the password here.';
    if (st === 'connected') return 'Connected to OBS' + (obsStatus.studioMode ? ' — Studio Mode is ON.' : ' — Studio Mode is OFF.');
    if (st === 'connecting') return 'Connecting to OBS…';
    if (st === 'auth-failed') return 'OBS refused the connection — wrong or missing password.';
    return 'OBS not reachable — retrying…';
  }

  /* ---------------------------------------------------------- populate */

  function syncAll() {
    if (!S || !built) return;
    globalSyncs.forEach(function (f) { f(); });
    renderElements(false);
    renderSimple(false);
    renderUploadedFonts();
    $('#anim-master').checked = !!S.anim.enabled;
    refreshMeta();
  }

  function refreshMeta() {
    if (!S) return;
    var dirty = JSON.stringify(S.live) !== JSON.stringify(S.pending);
    document.body.classList.toggle('dirty', dirty);
    document.body.classList.toggle('anim-off', !S.anim.enabled);

    var onair = $('#pill-onair');
    onair.textContent = S.visible ? 'ON AIR' : 'HIDDEN';
    onair.className = 'pill' + (S.visible ? ' onair' : '');

    var pgm = $('#pill-pgm');
    pgm.textContent = 'PGM ' + (counts.program > 0 ? '✓' : '0');
    pgm.className = 'pill ' + (counts.program > 0 ? 'ok' : 'warn');
    pgm.title = counts.program > 0
      ? counts.program + ' program overlay source(s) connected'
      : 'No program overlay connected — add a "Lower Third" source or a Browser Source with the /overlay URL';

    var obsPill = $('#pill-obs');
    var st = obsStatus.status;
    var cls = 'pill', txt = 'OBS off';
    if (st === 'connected') { cls += ' ok'; txt = obsStatus.studioMode ? 'OBS ✓ studio' : 'OBS ✓'; }
    else if (st === 'connecting') { cls += ' warn'; txt = 'OBS …'; }
    else if (st === 'disconnected') { cls += ' warn'; txt = 'OBS retry'; }
    else if (st === 'auth-failed') { cls += ' err'; txt = 'OBS auth!'; }
    obsPill.className = cls;
    obsPill.textContent = txt;

    var hint = $('#obs-hint');
    if (hint) hint.textContent = obsHintText();
    $('#btn-take').textContent = S.anim.enabled ? 'TAKE' : 'TAKE (cut)';
  }

  setInterval(function () {
    if (!S) return;
    var btn = $('#btn-hide');
    if (S.visible && S.anim.autoHideSec > 0 && S.shownAt) {
      var left = Math.ceil(S.anim.autoHideSec - (Date.now() - S.shownAt) / 1000);
      btn.textContent = left > 0 ? 'HIDE ' + left + 's' : 'HIDE';
    } else {
      btn.textContent = 'HIDE';
    }
  }, 300);

  /* ---------------------------------------------------------- preview */

  function fitPreview() {
    var box = $('#preview-box');
    var frame = $('#preview-frame');
    if (!box || !frame) return;
    frame.style.transform = 'scale(' + (box.clientWidth / 1920) + ')';
  }
  if (window.ResizeObserver) new ResizeObserver(fitPreview).observe(document.body);
  window.addEventListener('resize', fitPreview);

  document.querySelectorAll('.pv-bg').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.pv-bg').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      $('#preview-frame').src = '/overlay?role=preview&label=off&bg=' + b.dataset.bg;
    });
  });
  var defBg = document.querySelector('.pv-bg[data-bg="checker"]');
  if (defBg) defBg.classList.add('active');

  /* ----------------------------------------------------------- wiring */

  $('#btn-take').addEventListener('click', function () { send({ type: 'take' }); });
  $('#btn-show').addEventListener('click', function () { send({ type: 'show' }); });
  $('#btn-hide').addEventListener('click', function () { send({ type: 'hide' }); });
  $('#btn-revert').addEventListener('click', function () { send({ type: 'revert' }); });
  $('#btn-preview-anim').addEventListener('click', function () { send({ type: 'preview-anim' }); });
  $('#anim-master').addEventListener('change', function () {
    send({ type: 'anim', patch: { enabled: $('#anim-master').checked } });
  });

  $('#logo-file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file || !pendingImageSetter) return;
    var setter = pendingImageSetter;
    pendingImageSetter = null;
    fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.ok && j.url) { setter(j.url); syncAll(); } })
      .catch(function () { /* ignore */ });
  });

  $('#font-file').addEventListener('change', function () {
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
          upFontCache = '';
          renderUploadedFonts();
        }
      })
      .catch(function () { /* ignore */ });
  });

  /* mode toggle ------------------------------------------------------ */

  var MODE = 'advanced';
  try { if (localStorage.getItem('lt-mode') === 'simple') MODE = 'simple'; } catch (e) { /* ignore */ }
  function applyMode() {
    document.body.classList.toggle('mode-simple', MODE === 'simple');
    $('#mode-toggle').textContent = MODE === 'simple' ? 'ADVANCED' : 'SIMPLE';
    /* QUICK is the whole of SIMPLE — if it was collapsed in ADVANCED the panel
       would otherwise come up empty with no header left to click */
    if (MODE === 'simple') {
      var quick = $('#sec-simple');
      if (quick) quick.open = true;
      var presets = $('#sec-presets');
      if (presets) presets.open = true;
    }
  }
  $('#mode-toggle').addEventListener('click', function () {
    MODE = MODE === 'simple' ? 'advanced' : 'simple';
    try { localStorage.setItem('lt-mode', MODE); } catch (e) { /* ignore */ }
    applyMode();
  });
  applyMode();

  $('#foot-note').textContent = 'obs-lower-thirds · edit in preview, TAKE (or OBS Transition) to air';

  /* -------------------------------------------------------------- ws */

  function onMessage(msg) {
    var t = msg.type;
    if (t === 'hello') {
      S = msg.state;
      NATIVE = !!(msg.state && msg.state.native);
      obsStatus = msg.obs || obsStatus;
      counts = msg.counts || counts;
      if (!built) { buildSections(); built = true; }
      renderElements(true);
      renderPresets();
      syncAll();
      fitPreview();
      return;
    }
    if (!S) return;
    if (t === 'pending') { S.pending = msg.pending; reapplyInFlight(); syncAll(); }
    else if (t === 'anim') { S.anim = msg.anim; reapplyInFlight(); syncAll(); }
    else if (t === 'settings') { S.settings = msg.settings; reapplyInFlight(); syncAll(); }
    else if (t === 'presets') { S.presets = msg.presets; renderPresets(); }
    else if (t === 'snippets') { S.snippets = msg.snippets; renderElements(false); renderSimple(false); }
    else if (t === 'commit') { S.live = msg.live; refreshMeta(); }
    else if (t === 'show') { S.live = msg.live; S.visible = true; S.shownAt = msg.shownAt || Date.now(); refreshMeta(); }
    else if (t === 'hide') { S.visible = false; refreshMeta(); }
    else if (t === 'obs') { obsStatus = msg; refreshMeta(); }
    else if (t === 'counts') { counts = msg.counts; refreshMeta(); }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    sock = new WebSocket(proto + location.host + '/ws?role=control');
    sock.onopen = function () { document.body.classList.remove('offline'); };
    sock.onmessage = function (ev) {
      try { onMessage(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
    };
    sock.onclose = function () {
      document.body.classList.add('offline');
      setTimeout(connect, 1500);
    };
    sock.onerror = function () { try { sock.close(); } catch (e) { /* ignore */ } };
  }
  connect();
})();
