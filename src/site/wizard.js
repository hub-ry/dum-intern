// wizard.js — decorative wandering wizard at viewport bottom
// Self-contained; no framework deps. CSP-safe (external script only).
(function () {
  'use strict';

  // ── pixel art data ─────────────────────────────────────────────────────
  // Source: src/art/wizard.txt — 9 cols × 8 rows, chibi proportions.
  var PAL = {
    '.': null, 'o': '#17141f', 'p': '#4a3f9c', 'P': '#2e2a6b',
    'y': '#f0c94a', 's': '#f2cba3', 'W': '#f5f5f8', 'w': '#d2d2de',
    't': '#8a5a30', 'c': '#a8e6de',
  };

  // Three states: eyes-open idle, blink, and pondering (darker hat, shifted look).
  var FRAMES = {
    idle: [
      '...p...cc', '..ppp..cc', '.pyppp..t', 'yyyyyyy.t',
      '.sosos..t', '.sWWWs..t', 'pWWWWWp.t', '.ppypp..t',
    ],
    blink: [
      '...p...cc', '..ppp..cc', '.pyppp..t', 'yyyyyyy.t',
      '.swsws..t', '.sWWWs..t', 'pWWWWWp.t', '.ppypp..t',
    ],
    ponder: [
      '...P...cc', '..PPP..cc', '.PyPPP..t', 'yyyyyyy.t',
      '.ssoso..t', '.sWWWs..t', 'PWWWWWP.t', '.PPyPP..t',
    ],
  };

  var COLS = 9, ROWS = 8, SCALE = 4;
  var PW = COLS * SCALE; // 36px displayed
  var PH = ROWS * SCALE; // 32px displayed

  // ── canvas ────────────────────────────────────────────────────────────
  var dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  var canvas = document.createElement('canvas');
  canvas.width  = PW * dpr;
  canvas.height = PH * dpr;
  canvas.style.cssText =
    'position:fixed;bottom:8px;left:0;' +
    'width:'  + PW + 'px;height:' + PH + 'px;' +
    'pointer-events:none;z-index:9999;' +
    'image-rendering:pixelated;image-rendering:crisp-edges;' +
    'will-change:left,transform;';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.wizardState = 'offscreen';

  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);

  // ── draw frame ────────────────────────────────────────────────────────
  function draw(key) {
    var frame = FRAMES[key];
    ctx.clearRect(0, 0, PW, PH);
    for (var y = 0; y < ROWS; y++) {
      var row = frame[y];
      for (var x = 0; x < COLS; x++) {
        var c = PAL[row[x]];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
      }
    }
  }

  // ── motion preference ────────────────────────────────────────────────
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ── visibility-aware delay ────────────────────────────────────────────
  // A single registry of active timers; all paused/resumed together when
  // the tab hides/shows.  No per-call event listener accumulation.
  var activeTimers = [];

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      // Freeze every active timer, recording how much time was left.
      var now = Date.now();
      activeTimers.forEach(function (t) {
        if (t.id === null) return; // already cancelled
        clearTimeout(t.id);
        t.id = null;
        t.remaining = Math.max(0, t.deadline - now);
      });
    } else {
      // Resume: reschedule with remaining time.
      var now = Date.now();
      activeTimers.forEach(function (t) {
        if (t.cancelled || t.id !== null) return;
        t.deadline = now + t.remaining;
        t.id = setTimeout(t.fire, t.remaining);
      });
    }
  });

  function delay(ms, fn) {
    var entry = {
      id: null,
      remaining: ms,
      deadline: Date.now() + ms,
      cancelled: false,
      fire: null,
    };
    entry.fire = function () {
      // Remove from registry
      var idx = activeTimers.indexOf(entry);
      if (idx !== -1) activeTimers.splice(idx, 1);
      if (!entry.cancelled) fn();
    };
    if (document.hidden) {
      // Don't start yet; visibilitychange resume will schedule it.
      activeTimers.push(entry);
    } else {
      entry.id = setTimeout(entry.fire, ms);
      activeTimers.push(entry);
    }
    return function cancel() {
      entry.cancelled = true;
      if (entry.id !== null) { clearTimeout(entry.id); entry.id = null; }
      var idx = activeTimers.indexOf(entry);
      if (idx !== -1) activeTimers.splice(idx, 1);
    };
  }

  function cancelAll() {
    // Cancel every active timer (used on reset).
    activeTimers.slice().forEach(function (t) {
      t.cancelled = true;
      if (t.id !== null) { clearTimeout(t.id); t.id = null; }
    });
    activeTimers.length = 0;
  }

  // ── bob (subtle vertical waddle while walking) ────────────────────────
  var bobInterval = null;
  var bobUp = false;

  function startBob() {
    if (bobInterval) return;
    bobInterval = setInterval(function () {
      bobUp = !bobUp;
      canvas.style.bottom = bobUp ? '10px' : '8px';
    }, 280);
  }

  function stopBob() {
    clearInterval(bobInterval);
    bobInterval = null;
    canvas.style.bottom = '8px';
  }

  // ── facing direction ──────────────────────────────────────────────────
  // facingRight=true → no flip (staff on right, default art orientation).
  // facingRight=false → scaleX(-1) mirrors the canvas so staff is on left.
  function setFacing(facingRight) {
    canvas.style.transform = facingRight ? '' : 'scaleX(-1)';
  }

  // ── move with CSS transition ──────────────────────────────────────────
  function moveTo(x, ms) {
    canvas.style.transition = ms ? 'left ' + ms + 'ms linear' : 'left 0s';
    canvas.style.left = x + 'px';
  }

  // ── main sequence ─────────────────────────────────────────────────────
  var fromRight = false; // which edge the wizard next enters from

  function runSequence() {
    if (reduced.matches) { runReduced(); return; }

    var vw = window.innerWidth;
    var walkDist = Math.min(Math.max(vw * 0.30, 100), 200);

    // offscreen entry and onscreen stop positions
    var enterX = fromRight ? vw : -PW;
    var stopX  = fromRight ? vw - PW - walkDist : walkDist;

    draw('idle');
    canvas.dataset.wizardState = 'entering';
    // entering from right → face left; from left → face right
    setFacing(!fromRight);
    moveTo(enterX, 0);

    // tiny initial delay lets the left:0→enterX settle before transition
    delay(60, function () {
      moveTo(stopX, 1800);
      startBob();

      // arrive, then do confused pause
      delay(1860, function () {
        stopBob();
        canvas.dataset.wizardState = 'confused';

        // confused sub-sequence: blink, settle, ponder, blink, ponder, idle
        draw('blink');
        delay(180, function () {
          draw('idle');
          delay(900, function () {
            draw('ponder');
            delay(800, function () {
              draw('blink');
              delay(160, function () {
                draw('idle');
                delay(500, function () {
                  draw('ponder');
                  delay(600, function () {
                    draw('idle');

                    // turn: pause, flip facing, then exit
                    canvas.dataset.wizardState = 'exiting';
                    delay(240, function () {
                      setFacing(fromRight); // now faces back toward entry side
                      delay(120, function () {
                        moveTo(enterX, 1800);
                        startBob();

                        // wait to clear the screen, then gap before next cycle
                        delay(1920, function () {
                          stopBob();
                          canvas.dataset.wizardState = 'offscreen';
                          fromRight = !fromRight;
                          // random gap 18–30 s
                          delay(18000 + Math.random() * 12000, runSequence);
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  }

  // ── reduced-motion variant ────────────────────────────────────────────
  // Stationary sprite at the bottom corner; fades in, lingers, fades out.
  function runReduced() {
    var vw = window.innerWidth;
    var x = fromRight ? vw - PW - 8 : 8;
    draw('idle');
    canvas.dataset.wizardState = 'reduced';
    setFacing(!fromRight);
    canvas.style.transition = 'none';
    canvas.style.left = x + 'px';
    canvas.style.opacity = '0';

    delay(100, function () {
      canvas.style.transition = 'opacity 1s';
      canvas.style.opacity = '0.55';

      delay(5000, function () {
        canvas.style.opacity = '0';
        delay(1200, function () {
          canvas.dataset.wizardState = 'offscreen';
          canvas.style.transition = 'none';
          fromRight = !fromRight;
          delay(25000 + Math.random() * 15000, runSequence);
        });
      });
    });
  }

  // ── first arrival ─────────────────────────────────────────────────────
  // 4 s gives the page time to render; early enough to notice promptly.
  draw('idle');
  delay(4000, runSequence);

  // ── react to reduced-motion changes ───────────────────────────────────
  reduced.addEventListener('change', function () {
    cancelAll();
    stopBob();
    canvas.style.transition = 'none';
    canvas.style.opacity = '';
    runSequence();
  });

})();
