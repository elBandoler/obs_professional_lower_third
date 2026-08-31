/* OBS Lower Thirds — control panel logic */
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

  function rootFor(path) {
    if (path.indexOf('anim.') === 0) return { obj: S.anim, key: path.slice(5), kind: 'anim' };
    if (path.indexOf('settings.') === 0) return { obj: S.settings, key: path.slice(9), kind: 'settings' };
    return { obj: S.pending, key: path, kind: 'edit' };
  }

  function getVal(path) {
    if (!S) return undefined;
    var r = rootFor(path);
    var parts = r.key.split('.');
    var cur = r.obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === undefined || cur === null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function nestedPatch(key, value) {
    var parts = key.split('.');
    var patch = {};
    var cur = patch;
    for (var i = 0; i < parts.length - 1; i++) { cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = value;
    return patch;
  }

  var throttleTimers = {};
  function sendField(path, value) {
    var r = rootFor(path);
    // optimistic local update so the UI feels instant
    var parts = r.key.split('.');
    var cur = r.obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] === undefined) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;

    if (throttleTimers[path]) clearTimeout(throttleTimers[path]);
    throttleTimers[path] = setTimeout(function () {
      delete throttleTimers[path];
      send({ type: r.kind, patch: nestedPatch(r.key, value) });
    }, 60);
    refreshMeta();
  }

  function send(msg) {
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(msg));
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

  /* ------------------------------------------------------- field schema */

  var A_STYLES = [
    { v: 'slide-up', l: 'Slide up' },
    { v: 'slide-side', l: 'Slide from side' },
    { v: 'wipe', l: 'Wipe' },
    { v: 'fade', l: 'Fade' },
    { v: 'pop', l: 'Pop' },
  ];

  function notFullWidth() { return !getVal('style.layout.fullWidth'); }

  var FIELDS = [
    /* simplified operator mode: text-only editing */
    { sec: 'simple', type: 'text', path: 'content.topline.text', label: 'Top line', showIf: function () { return getVal('content.topline.enabled'); } },
    { sec: 'simple', type: 'text', path: 'content.headline.text', label: 'Headline' },
    { sec: 'simple', type: 'text', path: 'content.badge.text', label: 'Badge', showIf: function () { return getVal('content.badge.enabled'); } },

    /* content */
    { sec: 'content', type: 'toggle', path: 'content.topline.enabled', label: 'Top line' },
    { sec: 'content', type: 'text', path: 'content.topline.text', label: 'Top line text', showIf: function () { return getVal('content.topline.enabled'); } },
    { sec: 'content', type: 'text', path: 'content.headline.text', label: 'Headline' },
    { sec: 'content', type: 'toggle', path: 'content.badge.enabled', label: 'Badge / tag' },
    { sec: 'content', type: 'text', path: 'content.badge.text', label: 'Badge text', showIf: function () { return getVal('content.badge.enabled'); } },
    { sec: 'content', type: 'toggle', path: 'content.logo.enabled', label: 'Logo' },
    { sec: 'content', type: 'imagepick', path: 'content.logo.url', label: 'Logo image', showIf: function () { return getVal('content.logo.enabled'); } },
    { sec: 'content', type: 'slider', path: 'content.logo.scale', label: 'Logo size', min: 0.4, max: 1.6, step: 0.05, unit: '×', showIf: function () { return getVal('content.logo.enabled'); } },

    /* layout */
    { sec: 'layout', type: 'select', path: 'style.direction', label: 'Direction', options: [{ v: 'auto', l: 'Auto detect' }, { v: 'rtl', l: 'RTL ←' }, { v: 'ltr', l: 'LTR →' }] },
    { sec: 'layout', type: 'select', path: 'style.textAlign', label: 'Text align', options: [{ v: 'start', l: 'Start' }, { v: 'center', l: 'Center' }, { v: 'end', l: 'End' }] },
    { sec: 'layout', type: 'select', path: 'style.layout.logoSide', label: 'Logo side', options: [{ v: 'right', l: 'Right' }, { v: 'left', l: 'Left' }] },
    { sec: 'layout', type: 'toggle', path: 'style.layout.fullWidth', label: 'Full width' },
    { sec: 'layout', type: 'select', path: 'style.layout.anchor', label: 'Anchor', options: [{ v: 'left', l: 'Left' }, { v: 'center', l: 'Center' }, { v: 'right', l: 'Right' }], showIf: notFullWidth },
    { sec: 'layout', type: 'slider', path: 'style.layout.maxWidth', label: 'Max width', min: 20, max: 100, step: 1, unit: '%', showIf: notFullWidth },
    { sec: 'layout', type: 'slider', path: 'style.layout.sideMargin', label: 'Side margin', min: 0, max: 300, step: 2, unit: 'px' },
    { sec: 'layout', type: 'slider', path: 'style.layout.bottomMargin', label: 'Bottom margin', min: 0, max: 400, step: 2, unit: 'px' },
    { sec: 'layout', type: 'slider', path: 'style.gap', label: 'Block gap', min: 0, max: 30, step: 1, unit: 'px' },

    /* colors */
    { sec: 'colors', type: 'subhead', label: 'HEADLINE BAR' },
    { sec: 'colors', type: 'color', path: 'style.bars.headline.bg', label: 'Background' },
    { sec: 'colors', type: 'slider', path: 'style.bars.headline.bgOpacity', label: 'Bg opacity', min: 0, max: 1, step: 0.01, unit: '%pct' },
    { sec: 'colors', type: 'color', path: 'style.bars.headline.color', label: 'Text color' },
    { sec: 'colors', type: 'toggle', path: 'style.bars.headline.gradient.enabled', label: 'Gradient' },
    { sec: 'colors', type: 'color', path: 'style.bars.headline.gradient.color2', label: '2nd color', showIf: function () { return getVal('style.bars.headline.gradient.enabled'); } },
    { sec: 'colors', type: 'slider', path: 'style.bars.headline.gradient.angle', label: 'Angle', min: 0, max: 360, step: 5, unit: '°', showIf: function () { return getVal('style.bars.headline.gradient.enabled'); } },
    { sec: 'colors', type: 'toggle', path: 'style.bars.headline.image.enabled', label: 'Bg image', title: 'The bar color above becomes a tint over the image — lower its opacity to reveal the picture' },
    { sec: 'colors', type: 'imagepick', path: 'style.bars.headline.image.url', label: 'Image', showIf: function () { return getVal('style.bars.headline.image.enabled'); } },
    { sec: 'colors', type: 'select', path: 'style.bars.headline.image.fit', label: 'Image fit', options: [{ v: 'cover', l: 'Cover (fill)' }, { v: 'contain', l: 'Contain' }, { v: 'stretch', l: 'Stretch' }, { v: 'tile', l: 'Tile' }], showIf: function () { return getVal('style.bars.headline.image.enabled'); } },
    { sec: 'colors', type: 'subhead', label: 'TOP LINE BAR' },
    { sec: 'colors', type: 'color', path: 'style.bars.topline.bg', label: 'Background' },
    { sec: 'colors', type: 'slider', path: 'style.bars.topline.bgOpacity', label: 'Bg opacity', min: 0, max: 1, step: 0.01, unit: '%pct' },
    { sec: 'colors', type: 'color', path: 'style.bars.topline.color', label: 'Text color' },
    { sec: 'colors', type: 'toggle', path: 'style.bars.topline.image.enabled', label: 'Bg image', title: 'The bar color above becomes a tint over the image — lower its opacity to reveal the picture' },
    { sec: 'colors', type: 'imagepick', path: 'style.bars.topline.image.url', label: 'Image', showIf: function () { return getVal('style.bars.topline.image.enabled'); } },
    { sec: 'colors', type: 'select', path: 'style.bars.topline.image.fit', label: 'Image fit', options: [{ v: 'cover', l: 'Cover (fill)' }, { v: 'contain', l: 'Contain' }, { v: 'stretch', l: 'Stretch' }, { v: 'tile', l: 'Tile' }], showIf: function () { return getVal('style.bars.topline.image.enabled'); } },
    { sec: 'colors', type: 'subhead', label: 'BADGE' },
    { sec: 'colors', type: 'color', path: 'style.bars.badge.bg', label: 'Background' },
    { sec: 'colors', type: 'color', path: 'style.bars.badge.color', label: 'Text color' },
    { sec: 'colors', type: 'subhead', label: 'LOGO BOX' },
    { sec: 'colors', type: 'color', path: 'style.bars.logoBox.bg', label: 'Background' },
    { sec: 'colors', type: 'slider', path: 'style.bars.logoBox.bgOpacity', label: 'Bg opacity', min: 0, max: 1, step: 0.01, unit: '%pct' },
    { sec: 'colors', type: 'slider', path: 'style.bars.logoBox.pad', label: 'Padding', min: 0, max: 40, step: 1, unit: 'px' },
    { sec: 'colors', type: 'slider', path: 'style.bars.logoBox.minWidth', label: 'Min width', min: 0, max: 400, step: 5, unit: 'px' },
    { sec: 'colors', type: 'subhead', label: 'ACCENT' },
    { sec: 'colors', type: 'select', path: 'style.accent.mode', label: 'Accent strip', options: [{ v: 'none', l: 'None' }, { v: 'top', l: 'Top' }, { v: 'side', l: 'Side' }, { v: 'underline', l: 'Underline' }] },
    { sec: 'colors', type: 'color', path: 'style.accent.color', label: 'Accent color', showIf: function () { return getVal('style.accent.mode') !== 'none'; } },
    { sec: 'colors', type: 'slider', path: 'style.accent.thickness', label: 'Thickness', min: 2, max: 20, step: 1, unit: 'px', showIf: function () { return getVal('style.accent.mode') !== 'none'; } },

    /* typography */
    { sec: 'type', type: 'text', path: 'style.font.family', label: 'Font stack' },
    { sec: 'type', type: 'text', path: 'style.font.customCssUrl', label: 'Font CSS URL', placeholder: 'https://fonts.googleapis.com/css2?family=Heebo:wght@400;800&display=swap' },
    { sec: 'type', type: 'subhead', label: 'HEADLINE' },
    { sec: 'type', type: 'slider', path: 'style.bars.headline.size', label: 'Size', min: 16, max: 120, step: 1, unit: 'px' },
    { sec: 'type', type: 'slider', path: 'style.bars.headline.weight', label: 'Weight', min: 100, max: 900, step: 100 },
    { sec: 'type', type: 'slider', path: 'style.bars.headline.letterSpacing', label: 'Letter spacing', min: -2, max: 20, step: 0.5, unit: 'px' },
    { sec: 'type', type: 'slider', path: 'style.bars.headline.padX', label: 'Pad horizontal', min: 0, max: 80, step: 1, unit: 'px' },
    { sec: 'type', type: 'slider', path: 'style.bars.headline.padY', label: 'Pad vertical', min: 0, max: 60, step: 1, unit: 'px' },
    { sec: 'type', type: 'subhead', label: 'TOP LINE' },
    { sec: 'type', type: 'slider', path: 'style.bars.topline.size', label: 'Size', min: 12, max: 60, step: 1, unit: 'px' },
    { sec: 'type', type: 'slider', path: 'style.bars.topline.weight', label: 'Weight', min: 100, max: 900, step: 100 },
    { sec: 'type', type: 'slider', path: 'style.bars.topline.letterSpacing', label: 'Letter spacing', min: -2, max: 20, step: 0.5, unit: 'px' },
    { sec: 'type', type: 'slider', path: 'style.bars.topline.padX', label: 'Pad horizontal', min: 0, max: 80, step: 1, unit: 'px' },
    { sec: 'type', type: 'slider', path: 'style.bars.topline.padY', label: 'Pad vertical', min: 0, max: 60, step: 1, unit: 'px' },
    { sec: 'type', type: 'subhead', label: 'BADGE' },
    { sec: 'type', type: 'slider', path: 'style.bars.badge.size', label: 'Size', min: 10, max: 48, step: 1, unit: 'px' },
    { sec: 'type', type: 'slider', path: 'style.bars.badge.weight', label: 'Weight', min: 100, max: 900, step: 100 },

    /* edges & effects */
    { sec: 'edges', type: 'select', path: 'style.edges.style', label: 'Edge style', options: [{ v: 'square', l: 'Square' }, { v: 'rounded', l: 'Rounded' }, { v: 'chamfer', l: 'Slanted' }] },
    { sec: 'edges', type: 'slider', path: 'style.edges.radius', label: 'Corner radius', min: 0, max: 40, step: 1, unit: 'px', showIf: function () { return getVal('style.edges.style') === 'rounded'; } },
    { sec: 'edges', type: 'slider', path: 'style.edges.chamfer', label: 'Slant amount', min: 6, max: 60, step: 1, unit: 'px', showIf: function () { return getVal('style.edges.style') === 'chamfer'; } },
    { sec: 'edges', type: 'slider', path: 'style.shadow', label: 'Shadow', min: 0, max: 100, step: 1 },

    /* animation */
    { sec: 'anim', type: 'toggle', path: 'anim.enabled', label: 'Enable animations', title: 'Off = TAKE / OBS Transition applies changes instantly, with no motion' },
    { sec: 'anim', type: 'select', path: 'anim.inStyle', label: 'In animation', options: A_STYLES },
    { sec: 'anim', type: 'select', path: 'anim.outStyle', label: 'Out animation', options: [{ v: 'auto', l: 'Auto (reverse in)' }].concat(A_STYLES) },
    { sec: 'anim', type: 'select', path: 'anim.changeStyle', label: 'Text change', options: [{ v: 'slide-swap', l: 'Slide swap' }, { v: 'crossfade', l: 'Crossfade' }, { v: 'instant', l: 'Instant' }] },
    { sec: 'anim', type: 'select', path: 'anim.easing', label: 'Easing', options: [{ v: 'snappy', l: 'Snappy' }, { v: 'smooth', l: 'Smooth' }, { v: 'bouncy', l: 'Bouncy' }, { v: 'linear', l: 'Linear' }] },
    { sec: 'anim', type: 'slider', path: 'anim.inMs', label: 'In duration', min: 100, max: 2000, step: 50, unit: 'ms' },
    { sec: 'anim', type: 'slider', path: 'anim.outMs', label: 'Out duration', min: 100, max: 2000, step: 50, unit: 'ms' },
    { sec: 'anim', type: 'slider', path: 'anim.changeMs', label: 'Change duration', min: 100, max: 1500, step: 50, unit: 'ms' },
    { sec: 'anim', type: 'slider', path: 'anim.staggerMs', label: 'Stagger', min: 0, max: 400, step: 10, unit: 'ms' },
    { sec: 'anim', type: 'slider', path: 'anim.autoHideSec', label: 'Auto-hide (s)', min: 0, max: 120, step: 1, title: '0 = stay until you press HIDE' },

    /* obs settings (connection fields are for the standalone Node server;
       the native plugin runs inside OBS and needs none of them) */
    { sec: 'obs', type: 'toggle', path: 'settings.obs.enabled', label: 'Connect to OBS', showIf: function () { return !NATIVE; } },
    { sec: 'obs', type: 'text', path: 'settings.obs.host', label: 'Host', lazy: true, showIf: function () { return !NATIVE; } },
    { sec: 'obs', type: 'number', path: 'settings.obs.port', label: 'Port', lazy: true, showIf: function () { return !NATIVE; } },
    { sec: 'obs', type: 'password', path: 'settings.obs.password', label: 'Password', lazy: true, showIf: function () { return !NATIVE; } },
    { sec: 'obs', type: 'number', path: 'settings.server.port', label: 'Server port', lazy: true, title: 'Applied the next time OBS starts', showIf: function () { return NATIVE; } },
    { sec: 'obs', type: 'toggle', path: 'settings.obs.commitOnTransition', label: 'TAKE on Transition', title: 'Pressing Transition in OBS commits pending changes to program' },
    { sec: 'obs', type: 'toggle', path: 'settings.obs.onlyStudioMode', label: 'Only in Studio Mode' },
    { sec: 'obs', type: 'select', path: 'settings.obs.transitionAction', label: 'Transition does', options: [{ v: 'take', l: 'Commit changes' }, { v: 'take-show', l: 'Commit + show if hidden' }] },
  ];

  var SECTIONS = [
    { id: 'simple', label: 'QUICK', open: true },
    { id: 'content', label: 'CONTENT', open: true },
    { id: 'layout', label: 'LAYOUT & POSITION' },
    { id: 'colors', label: 'COLORS & BARS' },
    { id: 'type', label: 'TYPOGRAPHY' },
    { id: 'edges', label: 'EDGES & EFFECTS' },
    { id: 'anim', label: 'ANIMATION' },
    { id: 'presets', label: 'PRESETS', open: true },
    { id: 'obs', label: 'OBS & INTEGRATIONS' },
  ];

  /* -------------------------------------------------------- build form */

  function buildRow(f) {
    var row = document.createElement('div');
    row.className = 'row';
    if (f.type === 'subhead') {
      row.className = 'subhead';
      row.textContent = f.label;
      return row;
    }

    var lbl = document.createElement('label');
    lbl.className = 'lbl';
    lbl.textContent = f.label;
    if (f.title) { lbl.title = f.title; row.title = f.title; }
    row.appendChild(lbl);

    var ctl = document.createElement('div');
    ctl.className = 'ctl';
    row.appendChild(ctl);

    var input;
    if (f.type === 'toggle') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', function () { sendField(f.path, input.checked); populate(); });
    } else if (f.type === 'select') {
      input = document.createElement('select');
      f.options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.v; opt.textContent = o.l;
        input.appendChild(opt);
      });
      input.addEventListener('change', function () { sendField(f.path, input.value); populate(); });
    } else if (f.type === 'slider') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = f.min; input.max = f.max; input.step = f.step;
      var val = document.createElement('span');
      val.className = 'val';
      f.valEl = val;
      input.addEventListener('input', function () {
        var v = parseFloat(input.value);
        sendField(f.path, v);
        val.textContent = fmtVal(f, v);
      });
      ctl.appendChild(input);
      ctl.appendChild(val);
      f.el = input;
      row.dataset.path = f.path;
      return row;
    } else if (f.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.addEventListener('input', function () { sendField(f.path, input.value); });
    } else if (f.type === 'imagepick') {
      var thumb = document.createElement('img');
      thumb.className = 'pick-thumb';
      thumb.alt = '';
      f.thumbEl = thumb;
      input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'image URL or upload →';
      input.addEventListener('change', function () { sendField(f.path, input.value); });
      var up = document.createElement('button');
      up.textContent = '📁';
      up.title = 'Upload an image file';
      up.addEventListener('click', function () {
        PICK_TARGET = f.path;
        $('#logo-file').click();
      });
      ctl.appendChild(thumb);
      ctl.appendChild(input);
      ctl.appendChild(up);
      f.el = input;
      row.dataset.path = f.path;
      return row;
    } else { /* text / number / password */
      input = document.createElement('input');
      input.type = f.type === 'number' ? 'number' : (f.type === 'password' ? 'password' : 'text');
      if (f.placeholder) input.placeholder = f.placeholder;
      var evName = f.lazy ? 'change' : 'input';
      input.addEventListener(evName, function () {
        var v = f.type === 'number' ? (parseFloat(input.value) || 0) : input.value;
        sendField(f.path, v);
      });
    }
    ctl.appendChild(input);
    f.el = input;
    row.dataset.path = f.path;
    return row;
  }

  function fmtVal(f, v) {
    if (f.unit === '%pct') return Math.round(v * 100) + '%';
    if (f.unit === '×') return v.toFixed(2) + '×';
    return v + (f.unit || '');
  }

  function buildSections() {
    var main = $('#sections');
    SECTIONS.forEach(function (sec) {
      var det = document.createElement('details');
      det.className = 'sec';
      det.id = 'sec-' + sec.id;
      if (sec.open) det.open = true;
      var sum = document.createElement('summary');
      sum.textContent = sec.label;
      det.appendChild(sum);
      var body = document.createElement('div');
      body.className = 'sec-body';
      body.id = 'sec-body-' + sec.id;
      det.appendChild(body);
      main.appendChild(det);
    });

    FIELDS.forEach(function (f) {
      var body = $('#sec-body-' + f.sec);
      f.rowEl = buildRow(f);
      body.appendChild(f.rowEl);
    });

    buildSimpleExtras();
    buildFontExtras();
    buildPresetUi();
    buildObsExtras();
    fetchFonts();
  }

  /* simple mode ------------------------------------------------------ */

  function buildSimpleExtras() {
    var body = $('#sec-body-simple');
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Quick launch: tap a preset to load it into the preview, adjust the text, then TAKE or SHOW.';
    var grid = document.createElement('div');
    grid.id = 'quick-grid';
    body.insertBefore(grid, body.firstChild);
    body.insertBefore(hint, grid);
  }

  /* fonts ------------------------------------------------------------ */

  var FONTLIST = [];
  var PICK_TARGET = 'content.logo.url';

  function uploadsArr() {
    var u = getVal('style.font.uploads');
    return Array.isArray(u) ? u : [];
  }

  function fetchFonts() {
    fetch('/api/fonts').then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && Array.isArray(j.fonts)) {
        FONTLIST = j.fonts;
        fillFontDatalist();
      }
    }).catch(function () { /* endpoint may not exist on older servers */ });
  }

  function fillFontDatalist() {
    var dl = $('#fontlist');
    if (!dl) return;
    dl.innerHTML = '';
    var seen = {};
    uploadsArr().map(function (f) { return f && f.name; }).concat(FONTLIST).forEach(function (n) {
      if (!n || seen[n]) return;
      seen[n] = 1;
      var o = document.createElement('option');
      o.value = n;
      dl.appendChild(o);
    });
  }

  function applyFontFamily(name) {
    var fam = '"' + String(name).replace(/["\\]/g, '') + '", \'Segoe UI\', Arial, sans-serif';
    sendField('style.font.family', fam);
    populate();
  }

  function buildFontExtras() {
    var body = $('#sec-body-type');
    var wrap = document.createElement('div');
    wrap.id = 'font-tools';

    var pickRow = document.createElement('div');
    pickRow.className = 'row';
    pickRow.innerHTML = '<label class="lbl">Pick a font</label>';
    var pctl = document.createElement('div');
    pctl.className = 'ctl';
    var pick = document.createElement('input');
    pick.type = 'text';
    pick.setAttribute('list', 'fontlist');
    pick.placeholder = 'type to search fonts on this PC…';
    pick.addEventListener('change', function () {
      if (pick.value.trim()) applyFontFamily(pick.value.trim());
    });
    pctl.appendChild(pick);
    pickRow.appendChild(pctl);
    wrap.appendChild(pickRow);

    var upRow = document.createElement('div');
    upRow.className = 'row';
    upRow.innerHTML = '<label class="lbl">Font file</label>';
    var uctl = document.createElement('div');
    uctl.className = 'ctl';
    var upBtn = document.createElement('button');
    upBtn.textContent = '⬆ upload .ttf / .otf / .woff2';
    upBtn.title = 'Load a font file — it is stored with the overlay and used immediately';
    upBtn.addEventListener('click', function () { $('#font-file').click(); });
    uctl.appendChild(upBtn);
    upRow.appendChild(uctl);
    wrap.appendChild(upRow);

    var list = document.createElement('div');
    list.id = 'upfont-list';
    list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
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
      var row = document.createElement('div');
      row.className = 'upfont-row';
      var name = document.createElement('span');
      name.className = 'upfont-name';
      name.textContent = f.name || 'font';
      var use = document.createElement('button');
      use.textContent = 'use';
      use.title = 'Set this font as the lower-third font';
      use.addEventListener('click', function () { applyFontFamily(f.name); });
      var del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Remove from the list';
      del.addEventListener('click', function () {
        var next = uploadsArr().filter(function (_, idx) { return idx !== i; });
        sendField('style.font.uploads', next);
        upFontCache = '';
        renderUploadedFonts();
        fillFontDatalist();
      });
      row.appendChild(name);
      row.appendChild(use);
      row.appendChild(del);
      list.appendChild(row);
    });
    fillFontDatalist();
  }

  /* presets ---------------------------------------------------------- */

  function buildPresetUi() {
    var body = $('#sec-body-presets');
    var list = document.createElement('div');
    list.id = 'preset-list';
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    body.appendChild(list);

    var saveRow = document.createElement('div');
    saveRow.className = 'preset-save-row';
    var nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.placeholder = 'new preset name…';
    nameIn.id = 'preset-name';
    var saveBtn = document.createElement('button');
    saveBtn.textContent = '＋ save';
    saveBtn.title = 'Save the current look (content + style + animation) as a preset';
    saveBtn.addEventListener('click', function () {
      var n = nameIn.value.trim() || ('Preset ' + (S.presets.length + 1));
      send({ type: 'preset-save', name: n });
      nameIn.value = '';
    });
    saveRow.appendChild(nameIn);
    saveRow.appendChild(saveBtn);
    body.appendChild(saveRow);

    var restore = document.createElement('button');
    restore.className = 'link-btn';
    restore.textContent = 'restore built-in presets';
    restore.addEventListener('click', function () { send({ type: 'preset-restore' }); });
    body.appendChild(restore);
  }

  function renderPresets() {
    var qg = $('#quick-grid');
    if (qg && S) {
      qg.innerHTML = '';
      if (!S.presets.length) {
        var qe = document.createElement('div');
        qe.id = 'quick-empty';
        qe.className = 'hint';
        qe.textContent = 'No presets yet — switch to ADVANCED, style a look, and save it as a preset.';
        qg.appendChild(qe);
      }
      S.presets.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'quick-preset';
        b.textContent = p.name;
        b.title = 'Load "' + p.name + '" into the preview — then TAKE or SHOW';
        b.addEventListener('click', function () { send({ type: 'preset-load', id: p.id }); });
        qg.appendChild(b);
      });
    }

    var list = $('#preset-list');
    if (!list) return;
    list.innerHTML = '';
    if (!S.presets.length) {
      var empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = 'No presets yet — style the lower third, then save it here.';
      list.appendChild(empty);
    }
    S.presets.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'preset-row';

      var load = document.createElement('button');
      load.className = 'preset-load';
      load.textContent = p.name;
      load.title = 'Load into preview (press TAKE or SHOW to put it on air)';
      load.addEventListener('click', function () { send({ type: 'preset-load', id: p.id }); });

      var upd = document.createElement('button');
      upd.className = 'preset-mini';
      upd.textContent = '⤓';
      upd.title = 'Overwrite this preset with the current look';
      upd.addEventListener('click', function () { send({ type: 'preset-update', id: p.id }); });

      var del = document.createElement('button');
      del.className = 'preset-mini';
      del.textContent = '✕';
      del.title = 'Delete preset (click twice)';
      del.addEventListener('click', function () {
        if (del.dataset.armed) { send({ type: 'preset-delete', id: p.id }); return; }
        del.dataset.armed = '1';
        del.textContent = '✕?';
        del.style.color = '#ee7a76';
        setTimeout(function () {
          delete del.dataset.armed;
          del.textContent = '✕';
          del.style.color = '';
        }, 2500);
      });

      row.appendChild(load);
      row.appendChild(upd);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  /* obs & integration extras ----------------------------------------- */

  function buildObsExtras() {
    var body = $('#sec-body-obs');

    var status = document.createElement('div');
    status.className = 'hint';
    status.id = 'obs-hint';
    body.insertBefore(status, body.firstChild);

    var head = document.createElement('div');
    head.className = 'subhead';
    head.textContent = 'URLS & API';
    body.appendChild(head);

    var urls = [
      { l: 'Program overlay (browser source)', u: location.origin + '/overlay' },
      { l: 'Preview mirror (optional source/projector)', u: location.origin + '/overlay?role=preview' },
      { l: 'Control panel (custom browser dock)', u: location.origin + '/control' },
      { l: 'Hotkey/Stream Deck: take', u: location.origin + '/api/take' },
      { l: 'Hotkey/Stream Deck: show', u: location.origin + '/api/show' },
      { l: 'Hotkey/Stream Deck: hide', u: location.origin + '/api/hide' },
    ];
    urls.forEach(function (x) {
      var kv = document.createElement('div');
      kv.className = 'kv';
      kv.title = x.l;
      var code = document.createElement('code');
      code.textContent = x.u;
      var btn = document.createElement('button');
      btn.textContent = 'copy';
      btn.addEventListener('click', function () {
        copyText(x.u);
        btn.textContent = '✓';
        setTimeout(function () { btn.textContent = 'copy'; }, 1200);
      });
      kv.appendChild(code);
      kv.appendChild(btn);
      body.appendChild(kv);
    });

    var maint = document.createElement('div');
    maint.className = 'subhead';
    maint.textContent = 'MAINTENANCE';
    body.appendChild(maint);

    var reset = document.createElement('button');
    reset.className = 'link-btn';
    reset.textContent = 'reset style to defaults (keeps text)';
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
    if (st === 'connected') return 'Connected to OBS' + (obsStatus.studioMode ? ' — Studio Mode is ON.' : ' — Studio Mode is OFF (enable it in OBS to use preview/transition).');
    if (st === 'connecting') return 'Connecting to OBS…';
    if (st === 'auth-failed') return 'OBS refused the connection — wrong or missing password. Fix it and toggle “Connect to OBS” off/on.';
    return 'OBS not reachable — is OBS running and the WebSocket server enabled? Retrying…';
  }

  /* ---------------------------------------------------------- populate */

  function populate() {
    if (!S || !built) return;
    FIELDS.forEach(function (f) {
      if (f.type === 'subhead') return;
      var vis = !f.showIf || !!f.showIf();
      f.rowEl.classList.toggle('hidden-row', !vis);
      if (!f.el) return;
      var v = getVal(f.path);
      if (v === undefined) return;
      if (f.el !== document.activeElement) {
        if (f.type === 'toggle') f.el.checked = !!v;
        else f.el.value = v;
      }
      if (f.valEl) f.valEl.textContent = fmtVal(f, parseFloat(v) || 0);
      if (f.thumbEl) f.thumbEl.src = getVal(f.path) || '';
    });
    $('#anim-master').checked = !!S.anim.enabled;
    renderUploadedFonts();
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
      : 'No program overlay connected — add a Browser Source with the /overlay URL';

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

  /* auto-hide countdown on the HIDE button */
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
    var w = box.clientWidth;
    frame.style.transform = 'scale(' + (w / 1920) + ')';
  }
  if (window.ResizeObserver) {
    new ResizeObserver(fitPreview).observe(document.body);
  }
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
    if (!file) return;
    var target = PICK_TARGET || 'content.logo.url';
    fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.url) {
          sendField(target, j.url);
          populate();
        }
      })
      .catch(function () { /* leave as is */ });
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
      populate();
      renderPresets();
      fitPreview();
      return;
    }
    if (!S) return;
    if (t === 'pending') { S.pending = msg.pending; populate(); }
    else if (t === 'anim') { S.anim = msg.anim; populate(); }
    else if (t === 'settings') { S.settings = msg.settings; populate(); }
    else if (t === 'presets') { S.presets = msg.presets; renderPresets(); }
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
