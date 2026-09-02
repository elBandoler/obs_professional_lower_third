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
  var nodes = {};       // element id -> { cell, box, line, txt, img, rotTimer }
  var maxStagger = 0;   // highest --i in the current layout
  var maxElIn = 0;      // longest per-element entrance (delay + duration)
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

  /* getBoundingClientRect() returns the PAINTED box, so a take landing during a
     pop/slide animation would measure the element at its animated scale and pin
     the bar too narrow. Divide the scale back out. offsetWidth is not an option:
     it rounds down, and that lost sub-pixel is what re-wraps the last word. */
  function rectW(el) {
    var w = el.getBoundingClientRect().width;
    var t = getComputedStyle(el).transform;
    var m = /^matrix(?:3d)?\(\s*([^,]+),/.exec(t || '');
    var sx = m ? parseFloat(m[1]) : 1;
    return (sx && Math.abs(sx - 1) > 0.001) ? w / sx : w;
  }
  function rectH(el) {
    var r = el.getBoundingClientRect();
    var t = getComputedStyle(el).transform;
    var m = /^matrix\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([^,]+),/.exec(t || '');
    var sy = m ? parseFloat(m[1]) : 1;
    return (sy && Math.abs(sy - 1) > 0.001) ? r.height / sy : r.height;
  }

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

  /* ------------------------------------------------------------- media
     A logo can be a still (png/jpg/svg/gif) or a short video (mp4/webm/mov).
     The kind is sniffed from the URL at render time and never stored: putting
     it in the look would mean two engines sniffing in two languages, and
     changing a .png to an .mp4 would need a migration. */

  function mediaKind(url) {
    var u = String(url || '').split('?')[0].split('#')[0].toLowerCase();
    return /\.(mp4|webm|mov|m4v|ogv)$/.test(u) ? 'video' : 'image';
  }

  function makeMedia(url) {
    if (mediaKind(url) !== 'video') {
      var img = document.createElement('img');
      img.alt = '';
      return img;
    }
    var v = document.createElement('video');
    /* muted is what makes autoplay legal in the Chromium OBS embeds, and a
       logo has no business making noise. Set it both ways: the property for
       this element, the attribute so it survives being re-parented. */
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute('muted', '');
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    return v;
  }

  /* a <video> that is merely detached keeps decoding, so tear it down properly */
  function stopMedia(node) {
    if (!node) return;
    if (node.tagName === 'VIDEO') {
      try { node.pause(); node.removeAttribute('src'); node.load(); } catch (err) { /* ignore */ }
    }
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  function playIfVideo(node) {
    if (!node || node.tagName !== 'VIDEO') return;
    var p = node.play();
    /* older Chromium returns undefined; a rejected promise only means the
       frame sits on its first frame, which is survivable — never throw */
    if (p && p.catch) p.catch(function () {});
  }

  /* Swap the media NODE, not just its src: a <video> cannot be cross-faded by
     cloning (cloneNode gives an element with no playback state), and going
     from a still to a video changes the tag entirely. */
  function swapMedia(e, n, url, animate, style, ms) {
    var old = n.img;
    var next = makeMedia(url);
    next.style.objectFit = (e.image && e.image.fit) || 'contain';
    /* Scale is stamped on the node, not the shared box. A rotation swap can
       happen minutes after the commit that set the size, so reading it off the
       box would drag the outgoing logo to whatever the size is NOW; this way
       the outgoing node simply keeps the value it was built with. */
    next.style.setProperty('--img-scale', (e.image && e.image.scale) || 1);
    if (url) next.src = url;

    /* both branches must clear a swap in flight: a cut landing mid-cross-fade
       would otherwise leave the previous copy on screen until its timer fired */
    if (n.swapTimer) { clearTimeout(n.swapTimer); n.swapTimer = null; }
    var stale = n.box.querySelectorAll('.img-exit');
    for (var si = 0; si < stale.length; si++) stopMedia(stale[si]);

    if (!animate || !old || !old.getAttribute('src')) {
      if (old) stopMedia(old);
      n.box.appendChild(next);
      n.img = next;
      playIfVideo(next);
      return;
    }

    n.box.style.setProperty('--swap-ms', ms + 'ms');
    old.className = 'img-exit sw-' + style;
    n.box.appendChild(next);
    void next.offsetWidth;
    next.className = 'img-enter sw-' + style;
    n.img = next;
    playIfVideo(next);
    n.swapTimer = setTimeout(function () {
      n.swapTimer = null;
      stopMedia(old);
      next.className = '';
    }, ms + 120);
  }

  /* --------------------------------------------------- logo rotation
     image.url is the MAIN logo; image.sources are the alternates. Rotation is
     purely a render-time behaviour and never writes back into the look, so the
     dock's dirty flag does not flap every few seconds. */

  function rotationSig(e) {
    var im = e.image || {}, r = im.rotate || {};
    var srcs = (im.sources || []).map(function (x) { return (x && x.url) || ''; }).join('\u0001');
    return [im.url || '', srcs, r.mode, r.everyMs, r.showMs, r.anim, r.animMs].join('|');
  }

  function stopRotation(n) {
    if (!n) return;
    if (n.rotTimer) { clearTimeout(n.rotTimer); n.rotTimer = null; }
    /* a swap held back to land under a reaction must not fire after the
       rotation that scheduled it has been torn down — and dropping it means
       the picture it was heading for never arrived, so wind the intent back
       to whatever is actually on screen */
    if (n.coverTimer) {
      clearTimeout(n.coverTimer);
      n.coverTimer = null;
      n.wantUrl = n.mediaUrl;
    }
  }

  /* buildGrid throws the whole registry away, so a REPEATING timer would
     otherwise outlive its element forever — unlike the one-shot swap timers,
     which fire once against a detached node and die. */
  function stopAllRotations() {
    stopReactions();
    Object.keys(nodes).forEach(function (id) {
      var n = nodes[id];
      if (!n) return;
      stopRotation(n);
      /* finish, don't just cancel: a hide landing mid-swap would otherwise
         leave the outgoing copy on screen (still decoding, if it is a video)
         and it would still be there on the way back in */
      if (n.swapTimer) { clearTimeout(n.swapTimer); n.swapTimer = null; }
      if (n.box) {
        var ex = n.box.querySelectorAll('.img-exit');
        for (var i = 0; i < ex.length; i++) stopMedia(ex[i]);
      }
      if (n.img) {
        n.img.className = '';
        if (n.img.tagName === 'VIDEO') { try { n.img.pause(); } catch (err) { /* ignore */ } }
      }
    });
  }

  /* The counterpart to the pause above. A commit does not rebuild the media
     node when the URL has not changed, so without this a video logo comes back
     from a hide frozen on the frame it was paused at. */
  function resumeAllMedia() {
    Object.keys(nodes).forEach(function (id) {
      var n = nodes[id];
      if (n && n.img) playIfVideo(n.img);
    });
  }

  function rotateTo(e, n, url, r, maxWait) {
    /* wantUrl is where the rotation is heading; mediaUrl is what is actually
       on screen. They differ only while a swap is held behind a reaction, and
       keeping them apart is what stops a hide inside that window from leaving
       the renderer convinced it already showed a picture it never did. */
    if (n.wantUrl === url) return;
    n.wantUrl = url;
    /* "animations off" means an instant cut, not a stopped rotation — the
       same meaning that flag has everywhere else in the product */
    var style = (r && r.anim) || 'fade';
    var ms = Math.max(0, (r && r.animMs !== undefined) ? r.animMs : (anim ? anim.changeMs : 450));
    var animate = !!(anim && anim.enabled !== false) && style !== 'none' && ms > 0;

    /* anything wired to this logo moves first; with "cover the swap" on, the
       picture changes under the cover of that motion */
    var wait = fireReactions(e.id);
    /* never hold the swap past the tick that would cancel it — a long reaction
       against a short interval would otherwise starve the rotation completely
       and the logo would simply never change */
    if (maxWait !== undefined) wait = Math.min(wait, Math.max(0, maxWait - 80));
    if (n.coverTimer) { clearTimeout(n.coverTimer); n.coverTimer = null; }
    if (!wait) {
      n.mediaUrl = url;
      swapMedia(e, n, url, animate, style, ms);
      return;
    }
    n.coverTimer = setTimeout(function () {
      n.coverTimer = null;
      n.mediaUrl = url;
      swapMedia(e, n, url, animate, style, ms);
    }, wait);
  }

  /* the element as the last commit left it, by id */
  function currentEl(id) {
    if (!current || !current.elements) return null;
    for (var i = 0; i < current.elements.length; i++) {
      if (current.elements[i].id === id) return current.elements[i];
    }
    return null;
  }

  function syncRotation(e) {
    var n = nodes[e.id];
    if (!n || !n.img) return;
    var sig = rotationSig(e);
    if (n.rotSig === sig && n.rotTimer) return;   // already running this exact config
    stopRotation(n);
    n.rotSig = sig;

    var im = e.image || {}, r = im.rotate || {};
    var main = im.url || '';
    var alts = (im.sources || []).map(function (x) { return (x && x.url) || ''; })
      .filter(function (u) { return !!u; });
    if ((r.mode !== 'cycle' && r.mode !== 'return') || !alts.length) return;
    if (ROLE === 'program' && !isShown) return;   // nothing on air to rotate

    var every = Math.max(500, r.everyMs || 8000);
    var show = Math.max(200, r.showMs || 6000);
    var list = [main].concat(alts);
    var i = 0;            // cycle: index into list.  return: index into alts.
    var onAlt = false;

    function tick() {
      /* re-read the element every tick: rotationSig covers the sources and the
         timing, but a commit that changes only scale or fit must still reach
         the next swap rather than being frozen into this closure */
      var cur = currentEl(e.id) || e;
      if (r.mode === 'cycle') {
        i = (i + 1) % list.length;
        rotateTo(cur, n, list[i], r, every);
        n.rotTimer = setTimeout(tick, every);
      } else if (onAlt) {
        onAlt = false;
        rotateTo(cur, n, main, r, every);
        n.rotTimer = setTimeout(tick, every);
      } else {
        onAlt = true;
        rotateTo(cur, n, alts[i % alts.length], r, show);
        i++;
        n.rotTimer = setTimeout(tick, show);
      }
    }
    n.rotTimer = setTimeout(tick, every);
  }

  function syncAllRotations() {
    if (!current || !current.elements) return;
    current.elements.forEach(function (e) {
      if (e.kind === 'image' && e.enabled !== false) syncRotation(e);
    });
  }

  /* ------------------------------------------------- per-element motion
     An element can override the look's entrance and can be told to react when
     ANOTHER element's logo rotates — which is how a divider, rule or chevron
     ends up carrying the swap instead of the logo just changing on its own.
     Everything here is opt-in: 'inherit' and 0 mean "use the look's settings",
     which is what every element built before this existed reports. */

  function animOf(e) { return (e && e.anim) || {}; }

  function applyElementAnim(e, box) {
    var a = animOf(e);
    if (a.inStyle && a.inStyle !== 'inherit') box.dataset.in = a.inStyle;
    else delete box.dataset.in;
    if (a.inMs > 0) box.style.setProperty('--el-in-ms', a.inMs + 'ms');
    else box.style.removeProperty('--el-in-ms');
    if (a.delayMs > 0) box.style.setProperty('--el-delay', a.delayMs + 'ms');
    else box.style.removeProperty('--el-delay');
  }

  var REACT_CLASSES = ['react-flick', 'react-replay', 'react-pulse'];

  /* Play one element's reaction. Returns how long to wait before the logo
     should actually change, so the swap can land under the cover of the
     motion rather than beside it. */
  function playReaction(e) {
    var n = nodes[e.id];
    var a = animOf(e);
    if (!n || !n.box) return 0;
    var style = a.reactStyle || 'flick';
    var ms = Math.max(0, a.reactMs === undefined ? 400 : a.reactMs);
    if (style === 'none' || ms === 0) return 0;
    if (!(anim && anim.enabled !== false)) return 0;   /* animations off: cut */
    /* the in/out sequence owns .anim-el's animation while it runs, so a
       reaction started now would never be seen — and covering the swap behind
       an invisible reaction would only delay it for nothing */
    if (stage.classList.contains('anim-in') || stage.classList.contains('anim-out')) return 0;

    var box = n.box;
    if (n.reactTimer) { clearTimeout(n.reactTimer); n.reactTimer = null; }
    REACT_CLASSES.forEach(function (c) { box.classList.remove(c); });
    box.style.setProperty('--react-ms', ms + 'ms');
    void box.offsetWidth;                              /* restart the animation */
    box.classList.add('react-' + style);
    n.reactTimer = setTimeout(function () {
      n.reactTimer = null;
      REACT_CLASSES.forEach(function (c) { box.classList.remove(c); });
    }, ms + 60);
    /* halfway through is where a flick or a replay is at its most opaque */
    return a.cover === false ? 0 : Math.round(ms * 0.5);
  }

  /* Every element that has asked to react to this one's logo changing.
     Returns the longest cover delay any of them wants. */
  function fireReactions(sourceId) {
    var wait = 0;
    if (!current || !current.elements) return 0;
    current.elements.forEach(function (o) {
      if (o.id === sourceId || o.enabled === false) return;
      if (animOf(o).reactTo !== sourceId) return;
      wait = Math.max(wait, playReaction(o));
    });
    return wait;
  }

  function stopReactions() {
    Object.keys(nodes).forEach(function (id) {
      var n = nodes[id];
      if (!n) return;
      if (n.reactTimer) { clearTimeout(n.reactTimer); n.reactTimer = null; }
      if (n.coverTimer) { clearTimeout(n.coverTimer); n.coverTimer = null; }
      if (n.box) REACT_CLASSES.forEach(function (c) { n.box.classList.remove(c); });
    });
  }

  function buildGrid(look) {
    var L = layoutOf(look);
    stopAllRotations();
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
        applyElementAnim(e, box);

        if (e.kind === 'image') {
          var img = makeMedia((e.image && e.image.url) || '');
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
    /* a per-element family falls back to the look's default stack, so an
       uploaded or missing font still lands on something sensible */
    box.style.fontFamily = st.fontFamily
      ? '"' + String(st.fontFamily).replace(/["\\]/g, '') + '", ' + (look.style.font.family || 'sans-serif')
      : '';
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
    /* an auto margin eats the free space in the cell, which pins the box to
       the opposite edge — this is what splits two elements across a row */
    box.style.marginLeft = e.place.pin === 'right' ? 'auto' : '';
    box.style.marginRight = e.place.pin === 'left' ? 'auto' : '';

    var pinned = e.place.pin === 'left' || e.place.pin === 'right';
    var wantWidth = (!pinned && (e.place.stretch || (!inFlexCol && !sharesCell))) ? '100%' : '';
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
      /* scale and fit live on the media node itself — see swapMedia, which
         relies on an outgoing node keeping the values it was built with */
      box.style.setProperty('--img-scale', (e.image && e.image.scale) || 1);
      n.img.style.setProperty('--img-scale', (e.image && e.image.scale) || 1);
      n.img.style.objectFit = (e.image && e.image.fit) || 'contain';
    }
    /* motion is not part of structureOf(), so a change to it arrives as a
       morph and has to be re-stamped here rather than at buildGrid */
    applyElementAnim(e, box);
  }

  /* ------------------------------------------------------------- updates */

  function swapText(container, line, newText, mode) {
    var cls = mode === 'crossfade' ? 'swap-fade' : 'swap-slide';
    /* a swap arriving before the previous one finished: drop the old clone and
       cancel its timer, otherwise it strips this swap's classes mid-flight */
    if (line._swapTimer) { clearTimeout(line._swapTimer); line._swapTimer = null; }
    container.style.height = '';
    var stale = container.querySelectorAll('.line-exit');
    for (var si = 0; si < stale.length; si++) stale[si].remove();
    line.classList.remove('line-enter', 'swap-slide', 'swap-fade');
    void line.offsetWidth;
    /* Freeze the outgoing text's geometry before the new text can resize the
       box. Measured with the fractional rect: offsetWidth rounds down, and
       losing that sub-pixel is enough to re-wrap the last word, which shows
       up as the old text "jumping a line" mid-animation. */
    var lw = rectW(line);
    var lh = rectH(line);
    var rtl = stage.dataset.dir === 'rtl';
    var clone = line.cloneNode(true);
    clone.className = 'line line-exit ' + cls;
    clone.style.width = (lw + 1) + 'px';
    clone.style.height = Math.ceil(lh) + 'px';
    if (rtl) { clone.style.right = '0'; clone.style.left = 'auto'; }
    else { clone.style.left = '0'; clone.style.right = 'auto'; }
    container.appendChild(clone);

    /* The clone is out of flow, so the container would collapse to the NEW
       text's height at once and clip the outgoing lines away on frame one.
       Hold it at whichever is taller until the swap is over. */
    var h0 = rectH(container);
    line.textContent = newText;
    container.style.height = '';
    var h1 = rectH(container);
    container.style.height = Math.ceil(Math.max(h0, h1)) + 'px';

    line.classList.add('line-enter', cls);
    line._swapTimer = setTimeout(function () {
      line._swapTimer = null;
      clone.remove();
      container.style.height = '';
      line.classList.remove('line-enter', 'swap-slide', 'swap-fade');
    }, (anim ? anim.changeMs : 450) + 120);
  }

  /* Animate a box between its old and new natural width, then hand the width
     back to the layout — applyElementStyle may have pinned it to 100% and
     clearing it outright would leave the box misaligned with its column. */
  function flipWidth(box, mutate, enterLine) {
    var settled = box.dataset.width || '';
    var w0 = rectW(box);

    /* A swap arriving inside the previous one's window would otherwise be
       measured through that swap's pin: .line is a block child with an
       explicit width, which feeds straight into the box's fit-content size,
       so both w1 and the new pin would come back as the OLD text's width.
       w0 is read first because it is what is currently on screen. */
    if (enterLine) {
      if (enterLine._widthTimer) { clearTimeout(enterLine._widthTimer); enterLine._widthTimer = null; }
      enterLine.style.width = '';
    }

    mutate();
    box.style.width = settled;
    var w1 = rectW(box);

    /* Freeze the INCOMING text at the width it will finally have. While the
       box animates from the old width to the new one it is briefly narrower
       than the new text needs, and the text would wrap into several lines for
       the length of the animation before snapping back to one. Pinned, it
       simply stays one line and is revealed as the box widens (.txt clips). */
    if (enterLine) {
      enterLine.style.width = Math.ceil(rectW(enterLine) + 1) + 'px';
    }

    if (Math.abs(w1 - w0) < 2) {
      if (enterLine) enterLine.style.width = '';
      return;
    }
    box.style.width = w0 + 'px';
    void box.offsetWidth;
    box.style.width = w1 + 'px';

    var done = (anim ? anim.changeMs : 450) + 80;
    if (box._widthTimer) clearTimeout(box._widthTimer);
    box._widthTimer = setTimeout(function () {
      box._widthTimer = null;
      box.style.width = box.dataset.width || '';
    }, done);
    if (enterLine) {
      enterLine._widthTimer = setTimeout(function () {
        enterLine._widthTimer = null;
        enterLine.style.width = '';
      }, done);
    }
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
        flipWidth(n.box, function () { swapText(n.txt, n.line, newText, mode); }, n.line);
      }
    } else {
      n.line.textContent = newText;
    }
  }

  /* A commit puts the MAIN logo back on screen; rotation (if any) takes over
     from there and is restarted by syncRotation, because its signature
     includes the url that just changed. */
  function updateImage(e, animate) {
    var n = nodes[e.id];
    if (!n || !n.img) return;
    var target = (e.image && e.image.url) || '';
    if (n.mediaUrl === target) { n.wantUrl = target; return; }
    n.mediaUrl = target;
    n.wantUrl = target;
    swapMedia(e, n, target, animate, 'fade', anim ? anim.changeMs : 450);
  }

  /* the longest per-element entrance, so playIn's window can cover an element
     whose own duration and delay outrun the look's. Recomputed per commit, not
     per grid rebuild: motion is not part of structureOf(), so a change to it
     arrives as a morph and would otherwise leave this value stale. */
  function computeMaxElIn(look) {
    maxElIn = 0;
    (look.elements || []).forEach(function (el) {
      if (!el || el.enabled === false) return;
      var ea = el.anim || {};
      var dur = ea.inMs > 0 ? ea.inMs : (anim ? anim.inMs : 700);
      maxElIn = Math.max(maxElIn, (ea.delayMs || 0) + dur);
    });
  }

  function updateDom(look, animate) {
    setStageVars(look);
    computeMaxElIn(look);

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
    /* restart any rotation whose sources or timing just changed, and stop the
       ones that no longer have anywhere to rotate to */
    syncAllRotations();
  }

  /* --------------------------------------------------------- transitions */

  function clearAnimTimer() {
    if (animTimer) { clearTimeout(animTimer); animTimer = null; restoreAnimDurations(); }
  }

  /* the last element starts staggerMs * maxStagger after the first, so the
     whole sequence needs that much longer than a single element's duration */
  function totalFor(ms) { return ms + anim.staggerMs * maxStagger + 80; }
  function inTotal(ms) {
    return Math.max(totalFor(ms === undefined ? anim.inMs : ms), maxElIn + 80);
  }
  function outTotal(ms) { return totalFor(ms === undefined ? anim.outMs : ms); }

  /* quickOutIn shortens these; if it is pre-empted the configured values must
     still come back, or the whole show keeps running at the shortened speed */
  function restoreAnimDurations() {
    if (!anim) return;
    stage.style.setProperty('--in-ms', anim.inMs + 'ms');
    stage.style.setProperty('--out-ms', anim.outMs + 'ms');
  }

  function playIn(done, ms) {
    clearAnimTimer();
    if (ms !== undefined) stage.style.setProperty('--in-ms', ms + 'ms');
    stage.dataset.in = anim.inStyle;
    stage.classList.remove('anim-out', 'hidden');
    void stage.offsetWidth;
    stage.classList.add('anim-in');
    animTimer = setTimeout(function () {
      animTimer = null;
      stage.classList.remove('anim-in');
      restoreAnimDurations();
      if (done) done();
    }, inTotal(ms));
  }

  function playOut(done, ms) {
    clearAnimTimer();
    if (ms !== undefined) stage.style.setProperty('--out-ms', ms + 'ms');
    stage.dataset.out = anim.outStyle === 'auto' ? anim.inStyle : anim.outStyle;
    stage.classList.remove('anim-in');
    void stage.offsetWidth;
    stage.classList.add('anim-out');
    outInFlight = true;
    animTimer = setTimeout(function () {
      animTimer = null;
      stage.classList.add('hidden');
      stage.classList.remove('anim-out');
      outInFlight = false;
      /* a commit that landed mid-hide was held back so it could not appear on
         air inside the fading bar — apply it now that nothing is visible, and
         tell the caller, so a structural take does not overwrite it with the
         older look it captured when it started */
      var deferred = deferredLook;
      deferredLook = null;
      if (deferred) updateDom(deferred, false);
      if (done) done(deferred);
    }, outTotal(ms));
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
    var outMs = Math.max(160, Math.round(anim.outMs * 0.55));
    var inMs = Math.max(200, Math.round(anim.inMs * 0.6));
    playOut(function (deferred) {
      /* a newer commit landed while we were animating out and has already been
         applied — never put the older captured look back over it */
      if (!deferred) updateDom(look, false);
      playIn(restoreAnimDurations, inMs);
    }, outMs);
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
        if (isShown) { syncAllRotations(); resumeAllMedia(); } else stopAllRotations();
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
        resumeAllMedia();
      } else {
        if (outInFlight) { clearAnimTimer(); outInFlight = false; deferredLook = null; }
        updateDom(msg.live, false);
        isShown = true;
        /* syncRotation refuses to run while the bar is off air, so the rotation
           has to be (re)started now that it is on — and any paused video with it */
        syncAllRotations();
        resumeAllMedia();
        if (msg.animate) playIn(); else showInstant();
      }
      return;
    }

    if (t === 'hide') {
      if (ROLE !== 'program') return;
      isShown = false;
      /* nothing on air: stop rotating and pause any video, rather than burning
         a timer and a decode loop against a hidden bar */
      stopAllRotations();
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
