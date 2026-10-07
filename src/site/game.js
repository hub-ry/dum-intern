// game.js — dum intern endless runner
// Rose Pine Moon palette, sprite data from src/art/intern.txt

// Palette: rose pine moon
const BG  = '#232136'; // base
const OVR = '#393552'; // overlay / ground
const MUT = '#6e6a86'; // muted   / obstacle body
const SUB = '#908caa'; // subtle  / game-over heading
const HLH = '#56526e'; // highlight high
const HLM = '#44415a'; // highlight med / obstacle detail

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

// DOM refs (set during init)
let canvas, ctx, statusEl, jumpBtn;

// Layout (recalculated on resize)
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
  drawPortrait();

  resize();
  new ResizeObserver(resize).observe(canvas);

  canvas.addEventListener('click', act);
  jumpBtn.addEventListener('click', act);
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) lastTs = null; // drop accumulated delta on tab resume
  });

  rmq.addEventListener('change', drawFrame);
  setInterval(idleTick, 2900);
  drawFrame();
}

function resize() {
  const r = canvas.getBoundingClientRect();
  canvas.width  = Math.max(Math.floor(r.width),  200);
  canvas.height = Math.max(Math.floor(r.height), 160);

  scale       = Math.max(4, Math.min(10, Math.floor(canvas.height / 85)));
  groundY     = Math.floor(canvas.height * 0.83);
  internX     = SW * scale * 2;
  const newBase = groundY - SH * scale;

  if (!jumping) internY = newBase;
  internBaseY = newBase;

  drawFrame();
}

// ─── Input ───────────────────────────────────────────────────────────────────

function onKey(e) {
  if (e.code !== 'Space') return;
  const el  = document.activeElement;
  const tag = el ? el.tagName : '';
  // Let links and form controls keep their default Space behaviour
  if (tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // Jump button handles its own Space/Enter via click event
  if (el === jumpBtn) return;
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
  announce('Game started. Space or tap to jump.');

  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function doJump() {
  if (!jumping) {
    jumping = true;
    vy      = -800; // px/s, negative = upward in canvas coords
  }
}

function die() {
  gameState = 'dead';
  jumping   = false;
  setBtn('restart');
  announce(`Game over. Score: ${Math.floor(score)}. Press space to try again.`);
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

  // Score (100 pts/s at full speed) and progressive speed increase
  score += dt * 100;
  speed  = Math.min(520, 200 + Math.floor(score / 65) * 14);

  // Run frame animation — slower under reduced motion
  runTimer += dt;
  if (runTimer >= 0.20 / ms) { runTimer = 0; runFrame ^= 1; }

  // Jump physics — gravity unchanged even under reduced motion (keeps it playable)
  if (jumping) {
    vy      += 2200 * dt;          // gravity, px/s²
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
    // Height: 1× – 1.5× sprite (peak jump ~145 px, max obstacle ~120 px at scale 10)
    const h = Math.floor(SH * scale * (1 + Math.random() * 0.5));
    const w = Math.floor(SW * scale * (0.75 + Math.random() * 0.45));
    obstacles.push({ x: canvas.width + 4, y: groundY - h, w, h });
    nextObsIn = (1.2 + Math.random() * 2.0) / ms;
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

function drawSprite(name, x, y) {
  const rows = F[name];
  for (let r = 0; r < SH; r++) {
    for (let c = 0; c < SW; c++) {
      const col = rows[r][c];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x + c * scale, y + r * scale, scale, scale);
    }
  }
}

function drawPortrait() {
  const portrait = document.getElementById('hero-dum');
  if (!portrait) return;
  const pixel = 8;
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  portrait.width = SW * pixel * dpr;
  portrait.height = SH * pixel * dpr;
  const portraitCtx = portrait.getContext('2d');
  portraitCtx.scale(dpr, dpr);
  for (let r = 0; r < SH; r++) {
    for (let c = 0; c < SW; c++) {
      const color = F.idle[r][c];
      if (!color) continue;
      portraitCtx.fillStyle = color;
      portraitCtx.fillRect(c * pixel, r * pixel, pixel, pixel);
    }
  }
}

function drawFrame() {
  const W = canvas.width, H = canvas.height;

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Ground line
  ctx.fillStyle = OVR;
  ctx.fillRect(0, groundY, W, 1);

  // Obstacles — muted gray-purple blocks with subtle top edge and mid detail
  for (const ob of obstacles) {
    ctx.fillStyle = MUT;
    ctx.fillRect(ob.x, ob.y, ob.w, ob.h);
    ctx.fillStyle = SUB;
    ctx.fillRect(ob.x, ob.y, ob.w, 1);                                          // top edge
    ctx.fillStyle = HLH;
    ctx.fillRect(ob.x + 2, ob.y + Math.floor(ob.h * 0.45), ob.w - 4, 1);       // mid detail
    ctx.fillStyle = HLM;
    ctx.fillRect(ob.x, ob.y + ob.h - 1, ob.w, 1);                              // bottom edge
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
    const fs = Math.max(10, Math.floor(scale * 1.5));
    ctx.font         = `${fs}px "Hack", monospace`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = MUT;
    ctx.fillText(String(Math.floor(score)).padStart(5, '0'), W - scale * 2, scale * 2);
  }

  // State overlay — centred in the open sky above the ground
  const cy = Math.floor(groundY * 0.40);
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  if (gameState === 'idle') {
    const fs = Math.max(10, Math.floor(scale * 1.4));
    ctx.font      = `${fs}px "Hack", monospace`;
    ctx.fillStyle = MUT;
    ctx.fillText(
      rmq.matches ? 'press space to play  ·  motion reduced' : 'press space to start',
      W / 2, cy
    );
  } else if (gameState === 'dead') {
    const fs1 = Math.max(11, Math.floor(scale * 1.6));
    const fs2 = Math.max(10, Math.floor(scale * 1.3));

    ctx.font      = `${fs1}px "Hack", monospace`;
    ctx.fillStyle = SUB;
    ctx.fillText('game over', W / 2, cy);

    ctx.font      = `${fs2}px "Hack", monospace`;
    ctx.fillStyle = MUT;
    ctx.fillText(`score  ${String(Math.floor(score)).padStart(5, '0')}`, W / 2, cy + fs1 * 1.7);
    ctx.fillText('press space to try again', W / 2, cy + fs1 * 1.7 + fs2 * 1.9);
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
