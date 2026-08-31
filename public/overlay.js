/* OBS Lower Thirds — overlay renderer.
 * role=program  -> renders the LIVE state, animates on TAKE / SHOW / HIDE
 * role=preview  -> mirrors the PENDING state instantly (this is the preview)
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

  var EASINGS = {
    smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
    snappy: 'cubic-bezier(0.16, 1, 0.3, 1)',
    bouncy: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    linear: 'linear',
  };

  /* ------------------------------------------------------------ skeleton */

  lt.innerHTML =
    '<div class="lt-grid">' +
      '<div class="topline-cell"><div class="bar topline anim-el" style="--i:1.4">' +
        '<span class="txt"><span class="line" dir="auto"></span></span></div></div>' +
      '<div class="badge-cell"><div class="badge anim-el" style="--i:2">' +
        '<span class="txt"><span class="line" dir="auto"></span></span></div></div>' +
      '<div class="headline-cell"><div class="bar headline anim-el" style="--i:0.7">' +
        '<span class="txt"><span class="line" dir="auto"></span></span></div></div>' +
      '<div class="logo-cell"><div class="logobox anim-el" style="--i:0"><img alt=""></div></div>' +
    '</div>';

  var el = {
    topline: lt.querySelector('.bar.topline'),
    headline: lt.querySelector('.bar.headline'),
    badge: lt.querySelector('.badge'),
    logobox: lt.querySelector('.logobox'),
    logoImg: lt.querySelector('.logobox img'),
  };

  /* --------------------------------------------------------------- utils */

  function hexToRgba(hex, op) {
    if (typeof hex !== 'string') return 'rgba(0,0,0,1)';
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return hex;
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var a = op === undefined ? 1 : Math.max(0, Math.min(1, op));
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  var RTL_RE = /[֐-ࣿיִ-﷽ﹰ-ﻼ]/;
  function resolveDir(look) {
    var d = look.style.direction;
    if (d === 'rtl' || d === 'ltr') return d;
    var probe = (look.content.headline.text || '') + (look.content.topline.text || '');
    return RTL_RE.test(probe) ? 'rtl' : 'ltr';
  }

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

  /* ---------------------------------------------------------------- vars */

  function setAnimVars(a) {
    var s = stage.style;
    s.setProperty('--in-ms', a.inMs + 'ms');
    s.setProperty('--out-ms', a.outMs + 'ms');
    s.setProperty('--change-ms', a.changeMs + 'ms');
    s.setProperty('--stagger', a.staggerMs + 'ms');
    s.setProperty('--ease', EASINGS[a.easing] || EASINGS.snappy);
    s.setProperty('--n', 3);
  }

  function barBg(cfg) {
    var base = hexToRgba(cfg.bg, cfg.bgOpacity);
    var tint = base;
    if (cfg.gradient && cfg.gradient.enabled) {
      tint = 'linear-gradient(' + (cfg.gradient.angle || 180) + 'deg, ' +
        base + ', ' + hexToRgba(cfg.gradient.color2, cfg.bgOpacity) + ')';
    }
    var img = cfg.image;
    if (img && img.enabled && img.url) {
      /* color/gradient acts as a tint layer above the picture */
      var tintLayer = (cfg.gradient && cfg.gradient.enabled)
        ? tint
        : 'linear-gradient(' + base + ', ' + base + ')';
      var fit = img.fit || 'cover';
      var layout = 'center / cover no-repeat';
      if (fit === 'contain') layout = 'center / contain no-repeat';
      else if (fit === 'stretch') layout = 'center / 100% 100% no-repeat';
      else if (fit === 'tile') layout = 'top left / auto repeat';
      var url = String(img.url).replace(/["\\)]/g, '');
      return tintLayer + ', url("' + url + '") ' + layout;
    }
    return tint;
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
      var fam = String(f.name).replace(/["\\]/g, '');
      var url = String(f.url).replace(/["\\)]/g, '');
      return '@font-face{font-family:"' + fam + '";src:url("' + url + '");font-display:swap;}';
    }).join('\n');
  }

  function setVars(look) {
    var st = look.style, c = look.content, s = stage.style;
    var hl = st.bars.headline, tl = st.bars.topline, bd = st.bars.badge, lb = st.bars.logoBox;

    s.setProperty('--font', st.font.family || 'sans-serif');
    s.setProperty('--margin-side', st.layout.sideMargin + 'px');
    s.setProperty('--margin-bottom', st.layout.bottomMargin + 'px');
    s.setProperty('--maxw', st.layout.maxWidth + '%');
    s.setProperty('--gap', st.gap + 'px');
    s.setProperty('--radius', st.edges.radius + 'px');
    s.setProperty('--chamfer', st.edges.chamfer + 'px');
    s.setProperty('--accent-color', st.accent.color);
    s.setProperty('--accent-h', st.accent.thickness + 'px');
    s.setProperty('--talign', st.textAlign || 'start');

    var sh = Math.max(0, Math.min(100, st.shadow || 0));
    s.setProperty('--shadow-filter', sh === 0 ? 'none'
      : 'drop-shadow(0 ' + (3 + sh * 0.09).toFixed(1) + 'px ' + (sh * 0.45).toFixed(1) +
        'px rgba(0,0,0,' + (0.12 + sh * 0.005).toFixed(3) + '))');

    s.setProperty('--hl-bg', barBg(hl));
    s.setProperty('--hl-color', hl.color);
    s.setProperty('--hl-size', hl.size + 'px');
    s.setProperty('--hl-weight', hl.weight);
    s.setProperty('--hl-ls', hl.letterSpacing + 'px');
    s.setProperty('--hl-padx', hl.padX + 'px');
    s.setProperty('--hl-pady', hl.padY + 'px');

    s.setProperty('--tl-bg', barBg(tl));
    s.setProperty('--tl-color', tl.color);
    s.setProperty('--tl-size', tl.size + 'px');
    s.setProperty('--tl-weight', tl.weight);
    s.setProperty('--tl-ls', tl.letterSpacing + 'px');
    s.setProperty('--tl-padx', tl.padX + 'px');
    s.setProperty('--tl-pady', tl.padY + 'px');

    s.setProperty('--badge-bg', bd.bg);
    s.setProperty('--badge-color', bd.color);
    s.setProperty('--badge-size', bd.size + 'px');
    s.setProperty('--badge-weight', bd.weight);

    s.setProperty('--logo-bg', hexToRgba(lb.bg, lb.bgOpacity));
    s.setProperty('--logo-pad', lb.pad + 'px');
    s.setProperty('--logo-minw', lb.minWidth + 'px');
    s.setProperty('--logo-scale', c.logo.scale || 1);
    // logo image height ~ inner height of the headline bar
    var logoH = Math.max(24, hl.size * 1.18 + hl.padY * 2 - lb.pad * 2);
    s.setProperty('--logo-h', logoH.toFixed(0) + 'px');

    ensureFontCss(st.font.customCssUrl);
    ensureUploadedFonts(st.font.uploads);
  }

  /* structural facts — differences here need a rebuild (quick out+in),
     they cannot be morphed smoothly */
  function structureOf(look) {
    return [
      resolveDir(look),
      look.content.topline.enabled,
      look.content.badge.enabled,
      look.content.logo.enabled,
      look.style.layout.anchor,
      look.style.layout.fullWidth,
      look.style.layout.logoSide,
      look.style.edges.style,
      look.style.accent.mode,
    ].join('|');
  }

  /* ------------------------------------------------------------- updates */

  function swapText(container, line, newText, mode) {
    var cls = mode === 'crossfade' ? 'swap-fade' : 'swap-slide';
    var clone = line.cloneNode(true);
    clone.className = 'line line-exit ' + cls;
    container.appendChild(clone);
    line.textContent = newText;
    line.classList.add('line-enter', cls);
    setTimeout(function () {
      clone.remove();
      line.classList.remove('line-enter', 'swap-slide', 'swap-fade');
    }, (anim ? anim.changeMs : 450) + 120);
  }

  function flipWidth(bar, mutate) {
    var w0 = bar.offsetWidth;
    mutate();
    bar.style.width = '';
    var w1 = bar.offsetWidth;
    if (Math.abs(w1 - w0) < 2) return;
    bar.style.width = w0 + 'px';
    void bar.offsetWidth;
    bar.style.width = w1 + 'px';
    setTimeout(function () { bar.style.width = ''; }, (anim ? anim.changeMs : 450) + 80);
  }

  function updateText(which, newText, animate) {
    var box = el[which];
    var container = box.querySelector('.txt');
    var line = box.querySelector('.line');
    if (line.textContent === newText) return;
    var mode = anim ? anim.changeStyle : 'slide-swap';
    if (animate && mode !== 'instant') {
      var canFlip = (which !== 'badge') && current && !current.style.layout.fullWidth;
      if (canFlip) {
        flipWidth(box, function () { swapText(container, line, newText, mode); });
      } else {
        swapText(container, line, newText, mode);
      }
    } else {
      line.textContent = newText;
    }
  }

  function updateLogo(url, animate) {
    var img = el.logoImg;
    var target = url || '';
    if (img.dataset.src === target) return;
    img.dataset.src = target;
    if (animate && img.src) {
      var clone = img.cloneNode(false);
      clone.className = 'logo-exit';
      clone.style.cssText = 'position:absolute;inset:0;margin:auto;';
      el.logobox.appendChild(clone);
      img.classList.add('logo-enter');
      img.src = target;
      setTimeout(function () {
        clone.remove();
        img.classList.remove('logo-enter');
      }, (anim ? anim.changeMs : 450) + 120);
    } else {
      img.src = target;
    }
  }

  function updateDom(look, animate) {
    var c = look.content, st = look.style;
    setVars(look);

    var d = stage.dataset;
    d.dir = resolveDir(look);
    d.edges = st.edges.style;
    d.accent = st.accent.mode;
    d.anchor = st.layout.anchor;
    d.fullwidth = st.layout.fullWidth ? '1' : '0';
    d.logoside = st.layout.logoSide;
    d.hasTop = (c.topline.enabled || c.badge.enabled) ? '1' : '0';
    d.hasSide = (c.logo.enabled || c.badge.enabled) ? '1' : '0';

    el.topline.style.display = c.topline.enabled ? '' : 'none';
    el.badge.style.display = c.badge.enabled ? '' : 'none';
    el.logobox.style.display = c.logo.enabled ? '' : 'none';

    if (c.topline.enabled) updateText('topline', c.topline.text || '', animate);
    updateText('headline', c.headline.text || '', animate);
    if (c.badge.enabled) updateText('badge', c.badge.text || '', animate);
    if (c.logo.enabled) updateLogo(c.logo.url, animate);

    current = look;
  }

  /* --------------------------------------------------------- transitions */

  function clearAnimTimer() {
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
  }

  function inTotal() { return anim.inMs + anim.staggerMs * 2 + 80; }
  function outTotal() { return anim.outMs + anim.staggerMs * 2 + 80; }

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
    animTimer = setTimeout(function () {
      stage.classList.add('hidden');
      stage.classList.remove('anim-out');
      if (done) done();
    }, outTotal());
  }

  function showInstant() {
    clearAnimTimer();
    stage.classList.remove('anim-in', 'anim-out', 'hidden');
  }

  function hideInstant() {
    clearAnimTimer();
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

    if (t === 'anim') {
      anim = msg.anim;
      setAnimVars(anim);
      return;
    }

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
      if (isShown) {
        applyCommit(msg.live, msg.animate);
      } else {
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
