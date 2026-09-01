/* OBS Lower Thirds — overlay renderer (dynamic element model, schema 2).
 * role=program  -> renders the LIVE state, animates on TAKE / SHOW / HIDE
 * role=preview  -> mirrors the PENDING state instantly (this is the preview)
 *
 * Layout: a CSS grid of rows x auto-derived columns. Every element declares
 * place{row, order, stretch, rowSpan}; the column index is its order within
 * the row, so elements at the same order line up vertically across rows
 * (that is what keeps a badge sitting exactly above a logo).
 */
(function () {
  'use strict';

  var qs = new URLSearchParams(location.search);
  var ROLE = qs.get('role') === 'preview' ? 'preview' : 'program';
  var BG = qs.get('bg') || 'transparent';
  var SHOW_TAG = ROLE === 'preview' && qs.get('label') !== 'off';

  if (BG !== 'transparent') document.body.classList.add('bg-' + BG);
  if (SHOW_TAG) document.getElementById('pvw-tag').style.display = 'block';

  var stage = document.getElementById('stage');
  var lt = document.getElementById('lt');

  var anim = null;      // animation settings
  var current = null;   // look currently displayed
  var isShown = false;  // program visibility
  var animTimer = null;
  var grid = null;      // the .lt-grid node
  var nodes = {};       // element id -> { cell, box, line, txt, img }
  var maxStagger = 0;   // highest --i in the current layout
  var outInFlight = false;
  var deferredLook = null;

  var EASINGS = {
    smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
    snappy: 'cubic-bezier(0.16, 1, 0.3, 1)',
    bouncy: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    linear: 'linear',
  };

  /* --------------------------------------------------------------- utils */

  function rgba(hex, op) {
    if (typeof hex !== 'string') return 'rgba(0,0,0,1)';
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return hex;
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var a = op === undefined ? 1 : Math.max(0, Math.min(1, op));
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function safeUrl(u) { return String(u || '').replace(/["\\)]/g, ''); }

  var RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  function visibleElements(look) {
    return (look.elements || []).filter(function (e) { return e && e.enabled !== false; });
  }
  function resolveDir(look) {
    var d = look.style.direction;
    if (d === 'rtl' || d === 'ltr') return d;
    var probe = visibleElements(look).map(function (e) {
      return e.kind === 'text' ? (e.text || '') : '';
    }).join(' ');
    return RTL_RE.test(probe) ? 'rtl' : 'ltr';
  }

  /* ------------------------------------------------------- gradients/bg */

  function stopsCss(stops, mul) {
    return stops.slice().sort(function (a, b) { return (a.pos || 0) - (b.pos || 0); })
      .map(function (s) {
        var op = (s.opacity === undefined ? 1 : s.opacity) * (mul === undefined ? 1 : mul);
        return rgba(s.color, op) + ' ' + (s.pos || 0) + '%';
      }).join(', ');
  }

  function cssGradient(g, mul) {
    var s = stopsCss(g.stops || [], mul);
    if (g.type === 'radial') {
      return 'radial-gradient(' + (g.shape === 'circle' ? 'circle' : 'ellipse') +
        ' at ' + (g.posX || 0) + '% ' + (g.posY || 0) + '%, ' + s + ')';
    }
    if (g.type === 'conic') {
      return 'conic-gradient(from ' + (g.angle || 0) + 'deg at ' +
        (g.posX || 0) + '% ' + (g.posY || 0) + '%, ' + s + ')';
    }
    return 'linear-gradient(' + (g.angle === undefined ? 180 : g.angle) + 'deg, ' + s + ')';
  }

  function boxBackground(st) {
    var img = st.bgImage;
    var hasImg = !!(img && img.enabled && img.url);
    var tint;
    if (st.gradient && st.gradient.enabled) {
      tint = cssGradient(st.gradient, st.bgOpacity);
    } else {
      var c = rgba(st.bg, st.bgOpacity);
      tint = hasImg ? 'linear-gradient(' + c + ', ' + c + ')' : c;
    }
    if (!hasImg) return tint;
    var fit = img.fit || 'cover';
    var layout = fit === 'contain' ? 'center / contain no-repeat'
      : fit === 'stretch' ? 'center / 100% 100% no-repeat'
      : fit === 'tile' ? 'top left / auto repeat'
      : 'center / cover no-repeat';
    return tint + ', url("' + safeUrl(img.url) + '") ' + layout;
  }

  /* ---------------------------------------------------------------- fonts */

  var fontLink = null;
  function ensureFontCss(url) {
    var href = (url || '').trim();
    if (fontLink && fontLink.dataset.href === href) return;
    if (fontLink) { fontLink.remove(); fontLink = null; }
    if (!href || !/^https?:\/\//.test(href)) return;
    fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = href;
    fontLink.dataset.href = href;
    document.head.appendChild(fontLink);
  }

  var upFontsEl = null;
  var upFontsCache = '';
  function ensureUploadedFonts(uploads) {
    var arr = Array.isArray(uploads) ? uploads : [];
    var key = JSON.stringify(arr);
    if (key === upFontsCache) return;
    upFontsCache = key;
    if (!upFontsEl) {
      upFontsEl = document.createElement('style');
      document.head.appendChild(upFontsEl);
    }
    upFontsEl.textContent = arr.map(function (f) {
      if (!f || !f.url || !f.name) return '';
      return '@font-face{font-family:"' + String(f.name).replace(/["\\]/g, '') +
        '";src:url("' + safeUrl(f.url) + '");font-display:swap;}';
    }).join('\n');
  }

  /* ------------------------------------------------------------ stage vars */

  function setAnimVars(a) {
    var s = stage.style;
    s.setProperty('--in-ms', a.inMs + 'ms');
    s.setProperty('--out-ms', a.outMs + 'ms');
    s.setProperty('--change-ms', a.changeMs + 'ms');
    s.setProperty('--stagger', a.staggerMs + 'ms');
    s.setProperty('--ease', EASINGS[a.easing] || EASINGS.snappy);
  }

  function setStageVars(look) {
    var st = look.style, s = stage.style;
    s.setProperty('--font', st.font.family || 'sans-serif');
    s.setProperty('--margin-side', st.layout.sideMargin + 'px');
    s.setProperty('--margin-bottom', st.layout.bottomMargin + 'px');
    s.setProperty('--maxw', st.layout.maxWidth + '%');
    s.setProperty('--gap', st.gap + 'px');
    s.setProperty('--talign', st.textAlign || 'start');

    var sh = Math.max(0, Math.min(100, st.shadow || 0));
    s.setProperty('--shadow-filter', sh === 0 ? 'none'
      : 'drop-shadow(0 ' + (3 + sh * 0.09).toFixed(1) + 'px ' + (sh * 0.45).toFixed(1) +
        'px rgba(0,0,0,' + (0.12 + sh * 0.005).toFixed(3) + '))');

    ensureFontCss(st.font.customCssUrl);
    ensureUploadedFonts(st.font.uploads);
  }

  /* --------------------------------------------------------- grid layout */

  /* Elements are placed by (row, col); several can share one cell and then
     render as a horizontal line ordered by place.order. Columns are shared
     across rows, which is what keeps a badge exactly above a logo. */
  function layoutOf(look) {
    var els = visibleElements(look);
    var rows = 0, cols = 0;
    els.forEach(function (e) {
      /* full-height elements must not create rows of their own */
      if (!e.place.spanAll) rows = Math.max(rows, e.place.row + (e.place.rowSpan || 1));
      cols = Math.max(cols, e.place.col + (e.place.colSpan || 1));
    });
    rows = Math.max(rows, 1);
    cols = Math.max(cols, 1);

    var stretchCols = {};
    els.forEach(function (e) { if (e.place.stretch) stretchCols[e.place.col] = true; });

    var cells = {};
    els.forEach(function (e) {
      var row = e.place.spanAll ? 0 : e.place.row;
      var span = e.place.spanAll ? rows : (e.place.rowSpan || 1);
      var k = row + ':' + e.place.col;
      if (!cells[k]) {
        cells[k] = { row: row, col: e.place.col, rowSpan: 1, colSpan: 1, els: [] };
      }
      cells[k].rowSpan = Math.max(cells[k].rowSpan, span);
      cells[k].colSpan = Math.max(cells[k].colSpan, e.place.colSpan || 1);
      cells[k].els.push(e);
    });
    Object.keys(cells).forEach(function (k) {
      cells[k].els.sort(function (a, b) { return a.place.order - b.place.order; });
    });

    return {
      els: els, cells: cells,
      rows: Math.max(rows, 1), cols: Math.max(cols, 1),
      stretchCols: stretchCols,
    };
  }

  function gridTemplates(L, look) {
    var flex = {};
    for (var k in L.stretchCols) flex[k] = true;

    /* Nothing marked stretch but the block must fill the width: hand the slack
       to the column holding the biggest text, never to a logo column — auto
       columns would otherwise share it equally and balloon the logo. */
    if (!Object.keys(flex).length && look && look.style.layout.fullWidth) {
      var best = null, bestSize = -1;
      L.els.forEach(function (e) {
        if (e.kind !== 'text') return;
        var sz = (e.style && e.style.size) || 0;
        if (sz > bestSize) { bestSize = sz; best = e; }
      });
      if (best) flex[best.place.col] = true;
    }

    var colDefs = [];
    for (var c = 0; c < L.cols; c++) {
      colDefs.push(flex[c] ? 'minmax(0, 1fr)' : 'auto');
    }
    return {
      columns: colDefs.join(' '),
      rows: new Array(L.rows).fill('auto').join(' '),
      flexCols: flex,
    };
  }

  /* identity of the DOM structure — a change here needs a rebuild */
  function structureOf(look) {
    var L = layoutOf(look);
    return [
      resolveDir(look),
      look.style.layout.anchor,
      look.style.layout.fullWidth ? 1 : 0,
      L.rows, L.cols,
      L.els.map(function (e) {
        return [e.id, e.kind, e.place.row, e.place.col, e.place.order, e.place.rowSpan,
                e.place.colSpan, e.place.stretch ? 1 : 0, e.place.spanAll ? 1 : 0].join(':');
      }).join(','),
    ].join('|');
  }

  function buildGrid(look) {
    var L = layoutOf(look);
    nodes = {};
    lt.innerHTML = '';
    grid = document.createElement('div');
    grid.className = 'lt-grid';
    var tpl = gridTemplates(L, look);
    grid.style.gridTemplateColumns = tpl.columns;
    grid.style.gridTemplateRows = tpl.rows;
    L.flexCols = tpl.flexCols;
    grid._flexCols = tpl.flexCols;

    /* stagger order: bottom row first, then left to right */
    var maxRow = L.rows - 1;
    var maxI = 0;

    Object.keys(L.cells).forEach(function (key) {
      var c = L.cells[key];
      var cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.cell = key;
      cell.style.gridRow = (c.row + 1) + ' / span ' + c.rowSpan;
      cell.style.gridColumn = (c.col + 1) + ' / span ' + c.colSpan;

      c.els.forEach(function (e) {
        var i = (maxRow - e.place.row) + e.place.col * 0.35;
        maxI = Math.max(maxI, i);

        var box = document.createElement('div');
        box.className = 'box anim-el' + (e.kind === 'image' ? ' img-box' : '');
        box.dataset.id = e.id;
        box.style.setProperty('--i', i.toFixed(2));

        if (e.kind === 'image') {
          var img = document.createElement('img');
          img.alt = '';
          box.appendChild(img);
          nodes[e.id] = { cell: cell, box: box, img: img };
        } else {
          var txt = document.createElement('span');
          txt.className = 'txt';
          var line = document.createElement('span');
          line.className = 'line';
          line.setAttribute('dir', 'auto');
          txt.appendChild(line);
          box.appendChild(txt);
          nodes[e.id] = { cell: cell, box: box, txt: txt, line: line };
        }
        cell.appendChild(box);
      });

      grid.appendChild(cell);
    });

    maxStagger = maxI;
    stage.style.setProperty('--n', (maxI + 1).toFixed(2));
    lt.appendChild(grid);
  }

  /* ------------------------------------------------------- element styles */

  function applyElementStyle(e, look, L) {
    var n = nodes[e.id];
    if (!n) return;
    var st = e.style;
    var box = n.box, cell = n.cell;

    box.style.background = boxBackground(st);
    box.style.color = st.color;
    box.style.fontSize = st.size + 'px';
    box.style.fontWeight = st.weight;
    box.style.letterSpacing = st.letterSpacing + 'px';
    box.style.padding = st.padY + 'px ' + st.padX + 'px';
    box.style.lineHeight = st.lineHeight || 1.2;
    box.style.minWidth = (st.minWidth || 0) + 'px';
    /* Fill the cell when this element stretches, and also when it sits in an
       auto-sized column: that column is exactly as wide as its widest member,
       so filling keeps stacked side elements (badge over logo) flush. In a
       flexible (1fr) column a non-stretching bar hugs its own text instead. */
    var inFlexCol = !!(L && (L.flexCols || L.stretchCols)[e.place.col]);
    var cellKey = (e.place.spanAll ? 0 : e.place.row) + ':' + e.place.col;
    var sharesCell = !!(L && L.cells[cellKey] && L.cells[cellKey].els.length > 1);
    var wantWidth = (e.place.stretch || (!inFlexCol && !sharesCell)) ? '100%' : '';
    box.dataset.width = wantWidth;
    if (!box._widthTimer) box.style.width = wantWidth;   // never fight a running flip
    box.style.flex = e.place.stretch ? '1 1 auto' : '0 0 auto';

    /* edges: per element, or inherited from the global look */
    var ed = st.edges && st.edges.mode !== 'inherit' ? st.edges : null;
    var mode = ed ? ed.mode : look.style.edges.style;
    var radius = ed ? ed.radius : look.style.edges.radius;
    var chamfer = ed ? ed.chamfer : look.style.edges.chamfer;
    box.dataset.edges = mode;
    box.style.setProperty('--radius', (radius || 0) + 'px');
    box.style.setProperty('--chamfer', (chamfer || 0) + 'px');

    box.dataset.accent = (st.accent && st.accent.mode) || 'none';
    box.style.setProperty('--accent-color', (st.accent && st.accent.color) || '#1c56d6');
    box.style.setProperty('--accent-h', ((st.accent && st.accent.thickness) || 6) + 'px');

    if (e.kind === 'text') {
      n.txt.style.textAlign = st.align && st.align !== 'auto' ? st.align : (look.style.textAlign || 'start');
      n.txt.style.whiteSpace = st.nowrap ? 'nowrap' : '';
      if (e.place.stretch) cell.dataset.stretch = '1';
    } else {
      box.style.minHeight = Math.round((st.size || 56) * 1.18 + (st.padY || 0) * 2) + 'px';
      box.style.setProperty('--img-scale', (e.image && e.image.scale) || 1);
      n.img.style.objectFit = (e.image && e.image.fit) || 'contain';
    }
  }

  /* ------------------------------------------------------------- updates */

  function swapText(container, line, newText, mode) {
    var cls = mode === 'crossfade' ? 'swap-fade' : 'swap-slide';
    /* a swap arriving before the previous one finished: drop the old clone and
       cancel its timer, otherwise it strips this swap's classes mid-flight */
    if (line._swapTimer) { clearTimeout(line._swapTimer); line._swapTimer = null; }
    var stale = container.querySelectorAll('.line-exit');
    for (var si = 0; si < stale.length; si++) stale[si].remove();
    line.classList.remove('line-enter', 'swap-slide', 'swap-fade');
    void line.offsetWidth;
    /* Freeze the outgoing text's geometry before the new text can resize the
       box. Measured with the fractional rect: offsetWidth rounds down, and
       losing that sub-pixel is enough to re-wrap the last word, which shows
       up as the old text "jumping a line" mid-animation. */
    var r = line.getBoundingClientRect();
    var rtl = stage.dataset.dir === 'rtl';
    var clone = line.cloneNode(true);
    clone.className = 'line line-exit ' + cls;
    clone.style.width = (r.width + 1) + 'px';
    clone.style.height = Math.ceil(r.height) + 'px';
    if (rtl) { clone.style.right = '0'; clone.style.left = 'auto'; }
    else { clone.style.left = '0'; clone.style.right = 'auto'; }
    container.appendChild(clone);
    line.textContent = newText;
    line.classList.add('line-enter', cls);
    line._swapTimer = setTimeout(function () {
      line._swapTimer = null;
      clone.remove();
      line.classList.remove('line-enter', 'swap-slide', 'swap-fade');
    }, (anim ? anim.changeMs : 450) + 120);
  }

  /* Animate a box between its old and new natural width, then hand the width
     back to the layout — applyElementStyle may have pinned it to 100% and
     clearing it outright would leave the box misaligned with its column. */
  function flipWidth(box, mutate) {
    var settled = box.dataset.width || '';
    var w0 = box.getBoundingClientRect().width;
    mutate();
    box.style.width = settled;
    var w1 = box.getBoundingClientRect().width;
    if (Math.abs(w1 - w0) < 2) return;
    box.style.width = w0 + 'px';
    void box.offsetWidth;
    box.style.width = w1 + 'px';
    if (box._widthTimer) clearTimeout(box._widthTimer);
    box._widthTimer = setTimeout(function () {
      box._widthTimer = null;
      box.style.width = box.dataset.width || '';
    }, (anim ? anim.changeMs : 450) + 80);
  }

  function updateText(e, animate) {
    var n = nodes[e.id];
    if (!n || !n.line) return;
    var newText = e.text || '';
    if (n.line.textContent === newText) return;
    var mode = anim ? anim.changeStyle : 'slide-swap';
    if (animate && mode !== 'instant') {
      if (e.place.stretch) {
        /* width is dictated by the layout, not the text */
        swapText(n.txt, n.line, newText, mode);
      } else {
        flipWidth(n.box, function () { swapText(n.txt, n.line, newText, mode); });
      }
    } else {
      n.line.textContent = newText;
    }
  }

  function updateImage(e, animate) {
    var n = nodes[e.id];
    if (!n || !n.img) return;
    var target = (e.image && e.image.url) || '';
    if (n.img.dataset.src === target) return;
    n.img.dataset.src = target;
    if (animate && n.img.src) {
      if (n.img._swapTimer) { clearTimeout(n.img._swapTimer); n.img._swapTimer = null; }
      var stale = n.box.querySelectorAll('.img-exit');
      for (var si = 0; si < stale.length; si++) stale[si].remove();
      n.img.classList.remove('img-enter');
      var clone = n.img.cloneNode(false);
      clone.className = 'img-exit';
      n.box.appendChild(clone);
      void n.img.offsetWidth;
      n.img.classList.add('img-enter');
      n.img.src = target;
      n.img._swapTimer = setTimeout(function () {
        n.img._swapTimer = null;
        clone.remove();
        n.img.classList.remove('img-enter');
      }, (anim ? anim.changeMs : 450) + 120);
    } else {
      n.img.src = target;
    }
  }

  function updateDom(look, animate) {
    setStageVars(look);

    var d = stage.dataset;
    d.dir = resolveDir(look);
    d.anchor = look.style.layout.anchor;
    d.fullwidth = look.style.layout.fullWidth ? '1' : '0';

    if (!grid || !current || structureOf(current) !== structureOf(look)) {
      buildGrid(look);
      animate = false; /* a fresh DOM has nothing to animate from */
    }

    var L = layoutOf(look);
    if (grid && grid._flexCols) L.flexCols = grid._flexCols;
    L.els.forEach(function (e) {
      applyElementStyle(e, look, L);
      if (e.kind === 'text') updateText(e, animate);
      else updateImage(e, animate);
    });

    current = look;
  }

  /* --------------------------------------------------------- transitions */

  function clearAnimTimer() {
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
  }

  /* the last element starts staggerMs * maxStagger after the first, so the
     whole sequence needs that much longer than a single element's duration */
  function inTotal() { return anim.inMs + anim.staggerMs * maxStagger + 80; }
  function outTotal() { return anim.outMs + anim.staggerMs * maxStagger + 80; }

  function playIn(done) {
    clearAnimTimer();
    stage.dataset.in = anim.inStyle;
    stage.classList.remove('anim-out', 'hidden');
    void stage.offsetWidth;
    stage.classList.add('anim-in');
    animTimer = setTimeout(function () {
      stage.classList.remove('anim-in');
      if (done) done();
    }, inTotal());
  }

  function playOut(done) {
    clearAnimTimer();
    stage.dataset.out = anim.outStyle === 'auto' ? anim.inStyle : anim.outStyle;
    stage.classList.remove('anim-in');
    void stage.offsetWidth;
    stage.classList.add('anim-out');
    outInFlight = true;
    animTimer = setTimeout(function () {
      stage.classList.add('hidden');
      stage.classList.remove('anim-out');
      outInFlight = false;
      /* a commit that landed mid-hide was held back so it could not appear on
         air inside the fading bar — apply it now that nothing is visible */
      if (deferredLook) { updateDom(deferredLook, false); deferredLook = null; }
      if (done) done();
    }, outTotal());
  }

  function showInstant() {
    clearAnimTimer();
    outInFlight = false;
    stage.classList.remove('anim-in', 'anim-out', 'hidden');
  }

  function hideInstant() {
    clearAnimTimer();
    outInFlight = false;
    deferredLook = null;
    stage.classList.remove('anim-in', 'anim-out');
    stage.classList.add('hidden');
  }

  var propTimer = null;
  function withPropAnim() {
    stage.classList.add('prop-anim');
    if (propTimer) clearTimeout(propTimer);
    propTimer = setTimeout(function () {
      stage.classList.remove('prop-anim');
    }, anim.changeMs + 150);
  }

  /* quick out -> rebuild -> quick in (for structural changes) */
  function quickOutIn(look) {
    var s = stage.style;
    s.setProperty('--out-ms', Math.max(160, Math.round(anim.outMs * 0.55)) + 'ms');
    playOut(function () {
      updateDom(look, false);
      s.setProperty('--in-ms', Math.max(200, Math.round(anim.inMs * 0.6)) + 'ms');
      playIn(function () {
        s.setProperty('--in-ms', anim.inMs + 'ms');
        s.setProperty('--out-ms', anim.outMs + 'ms');
      });
    });
  }

  function applyCommit(look, animate) {
    var canAnimate = animate && anim && anim.changeStyle !== 'instant';
    /* still sliding off screen: hold the new look until it is really gone */
    if (ROLE === 'program' && outInFlight) { deferredLook = look; return; }
    if (ROLE === 'program' && !isShown) { updateDom(look, false); return; }
    if (!canAnimate) { updateDom(look, false); return; }
    if (current && structureOf(current) !== structureOf(look)) {
      quickOutIn(look);
      return;
    }
    withPropAnim();
    updateDom(look, true);
  }

  /* ------------------------------------------------------------------ ws */

  function onMessage(msg) {
    var t = msg.type;

    if (t === 'hello') {
      anim = msg.state.anim;
      setAnimVars(anim);
      if (ROLE === 'preview') {
        updateDom(msg.state.pending, false);
        showInstant();
      } else {
        updateDom(msg.state.live, false);
        isShown = !!msg.state.visible;
        if (isShown) showInstant(); else hideInstant();
      }
      return;
    }

    if (t === 'anim') { anim = msg.anim; setAnimVars(anim); return; }

    if (t === 'pending') {
      if (ROLE === 'preview') updateDom(msg.pending, false);
      return;
    }

    if (t === 'commit') {
      if (ROLE === 'program') applyCommit(msg.live, msg.animate);
      return;
    }

    if (t === 'show') {
      if (ROLE !== 'program') return;
      if (isShown && !outInFlight) {
        applyCommit(msg.live, msg.animate);
      } else {
        if (outInFlight) { clearAnimTimer(); outInFlight = false; deferredLook = null; }
        updateDom(msg.live, false);
        isShown = true;
        if (msg.animate) playIn(); else showInstant();
      }
      return;
    }

    if (t === 'hide') {
      if (ROLE !== 'program') return;
      isShown = false;
      if (msg.animate) playOut(); else hideInstant();
      return;
    }

    if (t === 'preview-anim') {
      if (ROLE === 'preview' && anim) {
        hideInstant();
        void stage.offsetWidth;
        playIn();
      }
      return;
    }
  }

  var ws = null;
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws?role=' + ROLE);
    ws.onmessage = function (ev) {
      try { onMessage(JSON.parse(ev.data)); } catch (e) { /* keep last frame */ }
    };
    ws.onclose = function () { setTimeout(connect, 1500); };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* ignore */ } };
  }
  connect();
})();
