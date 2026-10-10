// reader.js — public manga-style reader for one verified example creation.
// Loads ./presentation.json, shows fixed screenshots with captions, and never
// executes anything from the data. All text goes through textContent.
(function () {
  'use strict';

  var DOCS_HREF = '/docs';
  var LOAD_TIMEOUT_MS = 15000;
  // Panel images must be plain same-directory filenames. Nothing else loads.
  var IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(png|jpg|jpeg|webp|gif)$/i;

  var els = {
    reader: document.getElementById('reader'),
    status: document.getElementById('reader-status'),
    stage: document.getElementById('reader-stage'),
    bar: document.getElementById('reader-bar'),
    prev: document.getElementById('reader-prev'),
    next: document.getElementById('reader-next'),
    counter: document.getElementById('reader-counter'),
    caption: document.getElementById('reader-caption'),
    code: document.getElementById('reader-code'),
    codeText: document.getElementById('reader-code-text'),
    meta: document.getElementById('reader-meta'),
    verified: document.getElementById('reader-verified'),
    verification: document.getElementById('reader-verification'),
    machinery: document.getElementById('reader-machinery'),
    title: document.getElementById('reader-title'),
  };

  for (var key in els) {
    if (Object.prototype.hasOwnProperty.call(els, key) && !els[key]) return;
  }

  var panels = [];
  var index = 0;
  var img = null;

  // ---------------------------------------------------------------------------
  // Loading

  function showError(message) {
    els.stage.hidden = true;
    els.bar.hidden = true;
    els.caption.hidden = true;
    els.code.hidden = true;
    els.meta.hidden = true;
    els.status.hidden = false;
    els.status.textContent = '';
    els.status.appendChild(document.createTextNode(message + ' '));
    var link = document.createElement('a');
    link.href = DOCS_HREF;
    link.textContent = 'Read how creations are built instead.';
    els.status.appendChild(link);
  }

  function isString(v) { return typeof v === 'string' && v.length > 0; }

  function validate(data) {
    if (!data || typeof data !== 'object') return 'The example data isn\'t an object.';
    if (!Array.isArray(data.panels) || data.panels.length === 0) return 'The example has no pages.';
    for (var i = 0; i < data.panels.length; i++) {
      var p = data.panels[i];
      if (!p || typeof p !== 'object') return 'Page ' + (i + 1) + ' is malformed.';
      if (!isString(p.image) || !IMAGE_NAME.test(p.image)) return 'Page ' + (i + 1) + ' has an unexpected image path.';
      if (!isString(p.caption)) return 'Page ' + (i + 1) + ' has no caption.';
      if (p.code !== undefined && typeof p.code !== 'string') return 'Page ' + (i + 1) + ' has malformed code.';
    }
    if (!data.verification || typeof data.verification !== 'object' || !isString(data.verification.description)) {
      return 'The example has no verification record.';
    }
    return null;
  }

  function load() {
    if (typeof fetch !== 'function') {
      showError('This browser can\'t load the example.');
      return;
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, LOAD_TIMEOUT_MS);
    var options = { cache: 'no-cache', credentials: 'omit' };
    if (controller) options.signal = controller.signal;

    fetch('./presentation.json', options)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        clearTimeout(timer);
        var problem = validate(data);
        if (problem) { showError('The example couldn\'t be shown. ' + problem); return; }
        start(data);
      })
      .catch(function (err) {
        clearTimeout(timer);
        var why = err && err.name === 'AbortError' ? 'It took too long to load.' : 'It couldn\'t be loaded.';
        showError('The example isn\'t available right now. ' + why);
      });
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function start(data) {
    panels = data.panels;

    if (isString(data.title)) {
      els.title.textContent = data.title;
      document.title = data.title + ' — dum intern';
    }

    els.machinery.textContent = '';
    if (Array.isArray(data.supportingMachinery)) {
      data.supportingMachinery.forEach(function (item) {
        if (!isString(item)) return;
        var li = document.createElement('li');
        li.textContent = item;
        els.machinery.appendChild(li);
      });
    }
    els.verification.textContent = data.verification.description;
    els.verified.hidden = data.verification.verified !== true;

    img = document.createElement('img');
    img.decoding = 'async';
    img.addEventListener('error', function () {
      els.caption.hidden = false;
      els.caption.textContent = 'Page ' + (index + 1) + '\'s image failed to load. ' + panels[index].caption;
    });
    els.stage.textContent = '';
    els.stage.appendChild(img);

    els.status.hidden = true;
    els.stage.hidden = false;
    els.bar.hidden = false;
    els.caption.hidden = false;
    els.meta.hidden = false;

    els.prev.addEventListener('click', function () { go(index - 1, true); });
    els.next.addEventListener('click', function () { go(index + 1, true); });
    els.reader.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', function () { go(pageFromHash(), false); });

    go(pageFromHash(), false);
  }

  function pageFromHash() {
    var m = /^#page=(\d{1,3})$/.exec(location.hash);
    if (!m) return 0;
    var n = parseInt(m[1], 10) - 1;
    return n >= 0 && n < panels.length ? n : 0;
  }

  function go(n, fromUser) {
    if (n < 0) n = 0;
    if (n > panels.length - 1) n = panels.length - 1;
    index = n;
    var p = panels[index];
    var total = panels.length;

    img.alt = 'Page ' + (index + 1) + ' of ' + total + '. ' + p.caption;
    img.src = './' + p.image;

    els.counter.textContent = 'Page ' + (index + 1) + ' / ' + total;
    els.caption.textContent = p.caption;

    if (isString(p.code)) {
      els.codeText.textContent = p.code;
      els.code.hidden = false;
    } else {
      els.codeText.textContent = '';
      els.code.hidden = true;
      els.code.open = false;
    }

    els.prev.disabled = index === 0;
    els.next.disabled = index === total - 1;

    // A button that just got disabled drops focus to the body. Keep keyboard
    // users inside the reader so the arrow keys keep working.
    var active = document.activeElement;
    if (active && active.disabled && (active === els.prev || active === els.next)) {
      els.reader.focus({ preventScroll: true });
    }

    var hash = '#page=' + (index + 1);
    if (fromUser && location.hash !== hash && typeof history.replaceState === 'function') {
      history.replaceState(null, '', hash);
    }
  }

  // Keys act only inside the reader region, and not when the visitor is on a
  // link, form control or the code <details>, so those keep their own behaviour.
  function onKey(e) {
    var t = e.target;
    if (t && t !== els.reader && t.closest && t.closest('a, input, textarea, select, details, summary')) return;
    var handled = true;
    switch (e.key) {
      case 'ArrowLeft': go(index - 1, true); break;
      case 'ArrowRight': go(index + 1, true); break;
      case 'Home': go(0, true); break;
      case 'End': go(panels.length - 1, true); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  load();
})();
