// game.js — dum intern endless runner
// Muted violet palette for ground and obstacles, sprite data from src/art/intern.txt.
// Idle state draws nothing animated under prefers-reduced-motion; only a game the
// visitor starts on purpose moves, and then at reduced speed.

// Palette: rose pine moon
const OVR = '#3b3460'; // ground top edge
const MUT = '#6e6a86'; // obstacle body
const SUB = '#b8b2d0'; // score / game-over detail
const TXT = '#ece8f7'; // state overlay text
const HLH = '#56526e'; // obstacle highlight
const HLM = '#44415a'; // obstacle detail
const GND = '#1f1a3a'; // ground fill, in front of the mountains

// Intern sprite pixel colors (from art/intern.txt palette section)
const _ = null;        // transparent
const y = '#d99a3c';   // amber
const Y = '#f0c266';   // bright amber
const o = '#2a1d10';   // dark (eyes / mouth)
const d = '#8a6326';   // dark amber (blocked/dead state)

// Sprite frames — 7 columns × 8 rows
// Source frames: idle, idle.blink, thinking.up, blocked (art/intern.txt)
const F = {
  idle: [
    [_,y,_,_,_,y,_],   // .y...y.  antennae
    [_,_,y,_,y,_,_],   // ..y.y..
    [_,y,Y,Y,Y,y,_],   // .yYYYy.
    [y,Y,Y,Y,Y,Y,y],   // yYYYYYy
    [y,o,Y,Y,Y,o,y],   // yoYYYoy  eyes
    [y,Y,Y,Y,Y,Y,y],
    [y,Y,Y,o,Y,Y,y],   // yYYoYYy  mouth dot
    [_,y,y,y,y,y,_],   // .yyyyy.
  ],
  blink: [              // idle.blink: eyes closed (row 4 filled)
    [_,y,_,_,_,y,_],
    [_,_,y,_,y,_,_],
    [_,y,Y,Y,Y,y,_],
    [y,Y,Y,Y,Y,Y,y],
    [y,Y,Y,Y,Y,Y,y],   // closed
    [y,Y,Y,Y,Y,Y,y],
    [y,Y,Y,o,Y,Y,y],
    [_,y,y,y,y,y,_],
  ],
  run1: [               // feet shifted left (stride)
    [_,y,_,_,_,y,_],
    [_,_,y,_,y,_,_],
    [_,y,Y,Y,Y,y,_],
    [y,Y,Y,Y,Y,Y,y],
    [y,o,Y,Y,Y,o,y],
    [y,Y,Y,Y,Y,Y,y],
    [y,Y,Y,o,Y,Y,y],
    [_,y,y,y,y,_,_],   // cols 1-4
  ],
  run2: [               // feet shifted right (stride)
    [_,y,_,_,_,y,_],
    [_,_,y,_,y,_,_],
    [_,y,Y,Y,Y,y,_],
    [y,Y,Y,Y,Y,Y,y],
    [y,o,Y,Y,Y,o,y],
    [y,Y,Y,Y,Y,Y,y],
    [y,Y,Y,o,Y,Y,y],
    [_,_,y,y,y,y,_],   // cols 2-5
  ],
  jump: [               // thinking.up: eyes moved to row 2 (looking up)
    [_,y,_,_,_,y,_],
    [_,_,y,_,y,_,_],
    [_,y,o,Y,o,y,_],   // .yoYoy.  eyes up
    [y,Y,Y,Y,Y,Y,y],
    [y,Y,Y,Y,Y,Y,y],   // no eyes here
    [y,Y,Y,Y,Y,Y,y],
    [y,Y,Y,o,Y,Y,y],
    [_,y,y,y,y,y,_],
  ],
  dead: [               // blocked: drooping antennae, dark outline, sad mouth
    [_,_,d,_,d,_,_],   // ..d.d..  antennae tips droop inward
    [_,d,_,_,_,d,_],   // .d...d.
    [_,d,y,y,y,d,_],   // .dyyyd.
    [d,y,y,y,y,y,d],   // dyyyyyd
    [d,o,y,y,y,o,d],   // doyyyod  eyes same but dark border
    [d,y,y,y,y,y,d],
    [d,y,o,o,o,y,d],   // dyoooyd  three-dot sad mouth
    [_,d,d,d,d,d,_],   // .ddddd.
  ],
};

const SW = 7, SH = 8; // sprite cell size in art pixels
const DIFFICULTY_SCORE = 6000;  // full difficulty after one minute of play (100 pts/s)

// DOM refs (set during init)
let canvas, ctx, statusEl, jumpBtn;

// Layout (recalculated on resize), in CSS pixels
let cw         = 0;  // canvas width
let ch         = 0;  // canvas height
let pr         = 1;  // device pixels per CSS pixel
let scale      = 7;  // art-pixel → CSS-pixel multiplier
let groundY    = 0;  // ground line Y in canvas coords
let internX    = 0;  // intern left edge X (fixed)
let internBaseY = 0; // intern top Y when standing on ground

// Game state
let gameState = 'idle';  // 'idle' | 'running' | 'dead'
let jumping   = false;
let score     = 0;
let speed     = 0;       // obstacle speed px/s
let vy        = 0;       // intern vertical velocity (positive = down in canvas)
let internY   = 0;       // intern top-left Y in canvas coords

// Animation
let runFrame = 0;        // 0 or 1 → run1 or run2
let runTimer = 0;        // accumulated seconds for run frame switching
let blinkOn  = false;    // whether intern is mid-blink

// Obstacles [{x, y, w, h}]
let obstacles = [];
let nextObsIn = 2;       // seconds until next obstacle

// Timing
let lastTs = null;       // previous rAF timestamp (null = reset on next frame)
let rafId  = null;

const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');

// ─── Init ────────────────────────────────────────────────────────────────────

function init() {
  canvas   = document.getElementById('game-canvas');
  ctx      = canvas.getContext('2d');
  statusEl = document.getElementById('game-status');
  jumpBtn  = document.getElementById('game-jump');

  resize();
  new ResizeObserver(resize).observe(canvas);

  canvas.addEventListener('click', act);
  jumpBtn.addEventListener('click', act);
  // Keys only reach the game while the canvas itself is focused. The play
  // button already turns Space and Enter into clicks on its own, so nothing
  // listens on the document and the rest of the page keeps its Space scroll.
  canvas.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) lastTs = null; // drop accumulated delta on tab resume
  });

  rmq.addEventListener('change', drawFrame);
  setInterval(idleTick, 2900);
  drawFrame();
}

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  pr = dpr;
  cw = Math.max(Math.floor(r.width), 200);
  ch = Math.max(Math.floor(r.height), 1);
  // Backing store at device resolution so sprites and text stay sharp on HiDPI screens.
  canvas.width  = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;

  scale       = Math.max(2, Math.min(10, Math.round(ch / 40)));
  groundY     = Math.floor(ch * 0.83);
  internX     = SW * scale * 2;
  const newBase = groundY - SH * scale;

  if (!jumping) internY = newBase;
  internBaseY = newBase;

  drawFrame();
}

// ─── Input ───────────────────────────────────────────────────────────────────

function onKey(e) {
  // Only fires with the canvas focused (see init). Space, Enter and ArrowUp
  // start, jump or restart; anything else falls through untouched.
  if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'ArrowUp') return;
  if (e.repeat) { e.preventDefault(); return; }
  e.preventDefault();
  act();
}

function act() {
  if      (gameState === 'idle')    startGame();
  else if (gameState === 'running') doJump();
  else if (gameState === 'dead')    startGame();
}

// ─── Game flow ───────────────────────────────────────────────────────────────

function startGame() {
  gameState = 'running';
  score     = 0;
  speed     = 200;
  obstacles = [];
  nextObsIn = 1.8 + Math.random() * 0.6;
  jumping   = false;
  vy        = 0;
  internY   = internBaseY;
  runFrame  = 0;
  runTimer  = 0;
  lastTs    = null;

  setBtn('jump');
  announce('Game started. Press Space, tap the game, or use the jump button to jump.');

  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function doJump() {
  if (!jumping) {
    jumping = true;
    vy      = -80 * scale; // px/s, negative = upward in canvas coords
  }
}

function die() {
  gameState = 'dead';
  jumping   = false;
  setBtn('restart');
  announce(`Game over. Score: ${Math.floor(score)}. Press Space or the restart button to try again.`);
}

// ─── Loop ────────────────────────────────────────────────────────────────────

function loop(ts) {
  if (gameState !== 'running') {
    rafId = null;
    drawFrame();
    return;
  }
  rafId = requestAnimationFrame(loop);
  if (!lastTs) { lastTs = ts; drawFrame(); return; }

  const dt = Math.min((ts - lastTs) / 1000, 0.1); // cap at 100 ms
  lastTs = ts;

  if (gameState === 'running') update(dt);
  drawFrame();
}

// ─── Update ──────────────────────────────────────────────────────────────────

function update(dt) {
  // Honour prefers-reduced-motion: slow obstacles and animation, keep jump feel
  const ms = rmq.matches ? 0.35 : 1.0;

  // Score (100 pts/s) drives difficulty from 0 to 1 over the first minute of play.
  score += dt * 100;
  const d = Math.min(1, score / DIFFICULTY_SCORE);
  speed  = 200 + 360 * d;            // 200 → 560 px/s

  // Run frame animation — slower under reduced motion
  runTimer += dt;
  if (runTimer >= 0.20 / ms) { runTimer = 0; runFrame ^= 1; }

  // Jump physics — gravity unchanged even under reduced motion (keeps it playable)
  if (jumping) {
    vy      += 220 * scale * dt;   // gravity, px/s², scaled with the sprite
    internY += vy * dt;
    if (internY >= internBaseY) {  // landed
      internY = internBaseY;
      vy      = 0;
      jumping = false;
    }
  }

  // Obstacle generation
  nextObsIn -= dt;
  if (nextObsIn <= 0) {
    // Obstacles start small and grow taller and wider with difficulty. The tallest (1.5× sprite)
    // stays under the jump's ~1.8× peak, and the shortest gap (0.9 s) stays longer than the
    // ~0.73 s airtime, so every obstacle can be cleared.
    const h = Math.floor(SH * scale * (0.8 + Math.random() * (0.3 + 0.4 * d)));
    const w = Math.floor(SW * scale * (0.75 + Math.random() * (0.3 + 0.5 * d)));
    obstacles.push({ x: cw + 4, y: groundY - h, w, h });
    nextObsIn = ((1.3 - 0.4 * d) + Math.random() * (2.0 - 1.2 * d)) / ms;
  }

  // Move and prune off-screen obstacles
  const spd = speed * ms;
  for (const ob of obstacles) ob.x -= spd * dt;
  while (obstacles.length && obstacles[0].x + obstacles[0].w < 0) obstacles.shift();

  // Collision — inset hitbox on both intern and obstacle for fair play
  const pad = Math.ceil(scale * 0.9);
  const ix  = internX + pad,       iy  = internY + pad;
  const iw  = SW * scale - pad * 2, ih = SH * scale - pad * 2;

  for (const ob of obstacles) {
    const ox = ob.x + Math.floor(pad / 2), oy = ob.y + Math.floor(pad / 2);
    const ow = ob.w - pad,                 oh = ob.h - Math.floor(pad / 2);
    if (ix + iw > ox && ix < ox + ow && iy + ih > oy && iy < oy + oh) {
      die(); return;
    }
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────

// Round to the device pixel grid so art pixels never blend at fractional ratios.
const snap = (v) => Math.round(v * pr) / pr;

function fillSnapped(x, y, w, h) {
  const x0 = snap(x), y0 = snap(y);
  ctx.fillRect(x0, y0, snap(x + w) - x0, snap(y + h) - y0);
}

function drawSprite(name, x, y) {
  const rows = F[name];
  for (let r = 0; r < SH; r++) {
    for (let c = 0; c < SW; c++) {
      const col = rows[r][c];
      if (!col) continue;
      ctx.fillStyle = col;
      fillSnapped(x + c * scale, y + r * scale, scale, scale);
    }
  }
}

function drawFrame() {
  const W = cw, H = ch;

  // Transparent sky: the mountain scene behind the canvas shows through.
  ctx.clearRect(0, 0, W, H);

  // Ground strip and its top edge
  ctx.fillStyle = GND;
  fillSnapped(0, groundY, W, H - groundY);
  ctx.fillStyle = OVR;
  fillSnapped(0, groundY, W, 1);

  // Obstacles — muted gray-purple blocks with subtle top edge and mid detail
  for (const ob of obstacles) {
    ctx.fillStyle = MUT;
    fillSnapped(ob.x, ob.y, ob.w, ob.h);
    ctx.fillStyle = SUB;
    fillSnapped(ob.x, ob.y, ob.w, 1);                                          // top edge
    ctx.fillStyle = HLH;
    fillSnapped(ob.x + 2, ob.y + Math.floor(ob.h * 0.45), ob.w - 4, 1);       // mid detail
    ctx.fillStyle = HLM;
    fillSnapped(ob.x, ob.y + ob.h - 1, ob.w, 1);                              // bottom edge
  }

  // Intern sprite — select frame based on state
  const name =
    gameState === 'dead' ? 'dead' :
    gameState === 'idle' ? (blinkOn ? 'blink' : 'idle') :
    jumping              ? 'jump' :
    runFrame             ? 'run2' : 'run1';

  drawSprite(name, internX, Math.floor(internY));

  // Score — top-right corner, only while/after playing
  if (gameState !== 'idle') {
    const fs = Math.max(12, scale * 4);
    ctx.font         = `${fs}px "Hack", monospace`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = SUB;
    ctx.fillText(String(Math.floor(score)).padStart(5, '0'), W - scale * 3, scale * 3);
  }

  // State overlay — centred in the open sky above the ground
  const cy = Math.floor(groundY * 0.40);
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  if (gameState === 'idle') {
    ctx.font      = `${Math.max(13, scale * 4)}px "Hack", monospace`;
    ctx.fillStyle = TXT;
    ctx.fillText('click or press play', W / 2, cy);
  } else if (gameState === 'dead') {
    const fs1 = Math.max(14, scale * 5);
    const fs2 = Math.max(12, scale * 4);

    ctx.font      = `${fs1}px "Hack", monospace`;
    ctx.fillStyle = TXT;
    ctx.fillText('game over', W / 2, cy);

    ctx.font      = `${fs2}px "Hack", monospace`;
    ctx.fillStyle = SUB;
    ctx.fillText(`score  ${String(Math.floor(score)).padStart(5, '0')}`, W / 2, cy + fs1 * 1.4);
    ctx.fillText('click or restart to try again', W / 2, cy + fs1 * 1.4 + fs2 * 1.6);
  }
}

// ─── Idle blink ──────────────────────────────────────────────────────────────

function idleTick() {
  if (gameState !== 'idle' || rmq.matches) return;
  blinkOn = true;
  drawFrame();
  setTimeout(() => {
    blinkOn = false;
    if (gameState === 'idle') drawFrame();
  }, 110);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function announce(msg) {
  // Clear then set to reliably trigger aria-live even if text hasn't changed
  statusEl.textContent = '';
  requestAnimationFrame(() => { statusEl.textContent = msg; });
}

function setBtn(label) {
  jumpBtn.textContent = label;
}

// ─── Boot ────────────────────────────────────────────────────────────────────
// Wait for fonts (Hack woff2) before first render so canvas text uses the
// correct typeface from the start, not the fallback.
document.fonts.ready.then(init).catch(init);
