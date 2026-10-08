// Drives the real built Electron app through the circle journeys (docs/circle-design.md §2-§7, §10
// "tools/desktop-smoke.mjs changes") with a private profile, H, HOME and Claude config, a non-Git
// fixture and no Git on PATH. No model, account, key or network sign-in: the decision and handoff
// steps run the no-backend path. On Linux it runs under Xvfb: xdotool presses, drags and clicks the
// real circle, presses the real global shortcuts, types into the focused window and answers the native
// folder picker; a private D-Bus session with a minimal StatusNotifierWatcher proves no tray icon is
// ever registered. Screenshots and report.json go to DUM_SMOKE_OUTPUT.
//
// Development run (default): the checkout's `dist/` as built. DUM_SMOKE_EXECUTABLE runs a packaged
// binary instead.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';

const run = promisify(execFile);
const linux = process.platform === 'linux';
const repo = resolve(import.meta.dirname, '..');
const output = resolve(process.env.DUM_SMOKE_OUTPUT || join(tmpdir(), 'dum-smoke'));
const packaged = process.env.DUM_SMOKE_EXECUTABLE ? resolve(process.env.DUM_SMOKE_EXECUTABLE) : null;

// -- prerequisites: fail visibly -------------------------------------------------

async function which(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) if (dir && existsSync(join(dir, name))) return join(dir, name);
  return null;
}
const tools = {};
if (linux) {
  const missing = [];
  if (!process.env.DISPLAY) missing.push('an X display (run under `xvfb-run -a`)');
  for (const name of ['xdotool', 'dbus-daemon', 'python3']) if (!(tools[name] = await which(name))) missing.push(name);
  tools.ffmpeg = await which('ffmpeg');
  if (tools.python3) {
    try {
      await run(tools.python3, ['-c', 'import gi; gi.require_version("Gio", "2.0"); from gi.repository import Gio, GLib']);
    } catch {
      missing.push('python3 with PyGObject (gi), for the StatusNotifier watcher that proves there is no tray');
    }
  }
  if (missing.length) {
    console.error(`desktop smoke needs: ${missing.join(', ')}. Install Xvfb, xdotool, dbus and python3-gi, then run \`xvfb-run -a npm run desktop:smoke\`.`);
    process.exit(2);
  }
}
if (!packaged && !existsSync(join(repo, 'dist/desktop/main.js'))) {
  console.error('desktop smoke: dist/desktop/main.js is missing. Run `npm run desktop:build` first.');
  process.exit(2);
}

// -- fixture --------------------------------------------------------------------

// macOS temp folders sit behind a /var symlink, and Dum reports canonical paths.
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'dum-desktop-smoke-')));
const learning = join(fixture, 'learning');
const bin = join(fixture, 'bin');
await Promise.all([mkdir(learning), mkdir(bin), mkdir(output, { recursive: true })]);
await writeFile(join(learning, 'walk.py'), 'def walk(node):\n    if node is None:\n        return []\n    return walk(node.left) + [node.value] + walk(node.right)\n');
await writeFile(join(learning, 'README.md'), '# Trees\n\nPractice code for binary trees.\n');
for (const name of await readdir(output)) if (/\.png$|^report\.json$/.test(name)) await rm(join(output, name));

const checks = [];
const screenshots = {};
const limits = [];
let current = 'setup';
const record = (name, ok, detail = '') => {
  checks.push({ run: current, name, ok, ...(detail ? { detail: String(detail).slice(0, 1200) } : {}) });
  console.error(`${ok ? 'ok' : 'FAIL'} [${current}] ${name}${detail && !ok ? `: ${detail}` : ''}`);
};
const unexercised = (name, why) => {
  checks.push({ run: current, name, ok: null, detail: `not exercised: ${why}` });
  console.error(`skip [${current}] ${name}: ${why}`);
};
/** One check. A failure is recorded and the run goes on, unless the rest depends on it. */
async function step(name, body, { critical = false } = {}) {
  try {
    const detail = await body();
    record(name, true, typeof detail === 'string' ? detail : '');
    return true;
  } catch (error) {
    record(name, false, error?.message ?? error);
    if (critical) throw new Error(`critical check failed: ${name}`);
    return false;
  }
}

// -- screenshots ------------------------------------------------------------------

// The report keeps only evidence a window really painted: its size, distinct colors and how much of it
// differs from its dominant color. Pixels stay in the private output directory.
function paint(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = { 2: 3, 6: 4 }[png[25]];
  assert.ok(png[24] === 8 && channels && png[28] === 0, 'screenshot is an 8-bit non-interlaced RGB(A) PNG');
  const parts = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const data = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const raw = data[y * (stride + 1) + 1 + x];
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y ? rows[(y - 1) * stride + x] : 0;
      const upLeft = y && x >= channels ? rows[(y - 1) * stride + x - channels] : 0;
      const estimate = left + up - upLeft;
      const nearest = Math.min(Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft));
      const paeth = nearest === Math.abs(estimate - left) ? left : nearest === Math.abs(estimate - up) ? up : upLeft;
      rows[y * stride + x] = (raw + [0, left, up, (left + up) >> 1, paeth][filter]) & 255;
    }
  }
  const counts = new Map();
  for (let at = 0; at < rows.length; at += channels) {
    const key = rows.readUIntBE(at, channels);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dominant = [...counts.values()].reduce((most, count) => Math.max(most, count), 0);
  return { width, height, colors: counts.size, differsFromBackground: Number((1 - dominant / (width * height)).toFixed(3)) };
}
/**
 * The window as it shows: the viewport only (a beyond-viewport capture can stall Electron's compositor).
 * A window that was just shown may not have painted yet, so a blank capture is retried for a few seconds.
 */
async function shoot(page, name, options = {}) {
  await delay(400); // let transitions settle so the image shows the window as it stays
  let png;
  let stats;
  for (let attempt = 0; attempt < 8; attempt++) {
    png = await Promise.race([page.screenshot({ captureBeyondViewport: false, ...options }), delay(20_000).then(() => { throw new Error(`screenshot ${name} timed out`); })]);
    stats = paint(png);
    if (stats.colors > 1 && stats.differsFromBackground > 0) break;
    await delay(500);
  }
  await writeFile(join(output, name), png);
  screenshots[name] = { run: current, ...stats };
  assert.ok(stats.colors > 1 && stats.differsFromBackground > 0, `${name} is a blank window`);
}

// -- X11 and D-Bus helpers --------------------------------------------------------------

async function xdo(...args) {
  const { stdout } = await run(tools.xdotool, args, { timeout: 15_000 });
  return stdout.trim();
}
/** Visible X windows owned by `pid` whose title matches (xdotool ORs conditions unless told --all). */
async function xwindows(pid, title) {
  try {
    return (await xdo('search', '--all', '--onlyvisible', '--pid', String(pid), '--name', title)).split('\n').filter(Boolean);
  } catch {
    return []; // xdotool exits 1 when nothing matches
  }
}
async function xwindow(pid, title, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = await xwindows(pid, title);
    if (found.length) return found.at(-1);
    await delay(200);
  }
  throw new Error(`${label}: no visible window titled /${title}/ appeared`);
}
/**
 * Dum's own X windows that are really mapped and viewable, by title. All three surfaces are titled "Dum"
 * and Electron's windows carry no _NET_WM_PID, so geometry tells them apart.
 */
async function xviewable(title) {
  let ids = [];
  try {
    ids = (await xdo('search', '--onlyvisible', '--name', title)).split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const geometry = await xdo('getwindowgeometry', id).catch(() => '');
    const at = geometry.match(/Position: (-?\d+),(-?\d+)/);
    const size = geometry.match(/Geometry: (\d+)x(\d+)/);
    if (at && size) out.push({ id, x: +at[1], y: +at[2], w: +size[1], h: +size[2] });
  }
  return out;
}
// §2: the circle's window is 64×64 DIP; §3: the working window is 640×720, never under 360×480; §7: the bubble is at most 360×220.
const X_CIRCLE = { title: '^Dum$', test: (w) => w.w === 64 && w.h === 64 };
const X_WINDOW = { title: '^Dum$', test: (w) => w.w >= 360 && w.h >= 480 };
const X_BUBBLE = { title: '^Dum$', test: (w) => !(w.w === 64 && w.h === 64) && w.w <= 360 && w.h <= 220 };
/** The window if it is mapped within `timeout`, else null. */
async function xshown(kind, timeout = 8_000) {
  const end = Date.now() + timeout;
  do {
    const hit = (await xviewable(kind.title)).find(kind.test);
    if (hit) return hit;
    await delay(150);
  } while (Date.now() < end);
  return null;
}
async function xgone(kind, timeout = 8_000) {
  const end = Date.now() + timeout;
  do {
    if (!(await xviewable(kind.title)).some(kind.test)) return true;
    await delay(150);
  } while (Date.now() < end);
  return false;
}
/** True when the window stays unmapped for the whole `period`. */
async function xstaysGone(kind, period) {
  const end = Date.now() + period;
  do {
    if ((await xviewable(kind.title)).some(kind.test)) return false;
    await delay(150);
  } while (Date.now() < end);
  return true;
}
/** The X window that has keyboard focus. */
async function xfocus() {
  return xdo('getwindowfocus', '-f').catch(() => '');
}
async function xfocusIs(id, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end && (await xfocus()) !== id) await delay(150);
  return (await xfocus()) === id;
}
/**
 * The whole X screen, as the person would see it: proof the windows are really mapped and stacked, which
 * a page capture can't give. Optional: needs ffmpeg's x11grab.
 */
async function xscreen(name) {
  if (!tools.ffmpeg) {
    if (!limits.includes('no ffmpeg: X screen captures skipped')) limits.push('no ffmpeg: X screen captures skipped');
    return;
  }
  const [width, height] = (await xdo('getdisplaygeometry')).split(/\s+/);
  const file = join(output, name);
  await run(tools.ffmpeg, ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', `${width}x${height}`, '-i', process.env.DISPLAY, '-frames:v', '1', file], { timeout: 20_000 });
  const stats = paint(await readFile(file));
  screenshots[name] = { run: current, ...stats };
  assert.ok(stats.colors > 1 && stats.differsFromBackground > 0, `${name} is a blank screen`);
}
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const near = (a, b, slack = 1) => Math.abs(a - b) <= slack;

// A StatusNotifier host, so a tray icon would have somewhere to register. This watcher owns
// org.kde.StatusNotifierWatcher on the private bus and reports each item an app registers; Dum has
// no tray, so the list must stay empty.
const TRAY_WATCHER = String.raw`
import json, sys
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib
XML = """<node><interface name="org.kde.StatusNotifierWatcher">
<method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
<method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
<property name="RegisteredStatusNotifierItems" type="as" access="read"/>
<property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
<property name="ProtocolVersion" type="i" access="read"/>
<signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
<signal name="StatusNotifierHostRegistered"/>
</interface></node>"""
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
items = []
def say(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()
def method(conn, sender, path, iface, name, params, invocation):
    if name == "RegisterStatusNotifierItem":
        arg = params.unpack()[0]
        service, obj = (sender, arg) if arg.startswith("/") else (arg, "/StatusNotifierItem")
        items.append((service, obj))
        conn.emit_signal(None, "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher", "StatusNotifierItemRegistered", GLib.Variant("(s)", (service + obj,)))
        say({"event": "registered", "service": service, "path": obj})
    invocation.return_value(None)
def prop(conn, sender, path, iface, name):
    if name == "RegisteredStatusNotifierItems":
        return GLib.Variant("as", [s + o for s, o in items])
    if name == "IsStatusNotifierHostRegistered":
        return GLib.Variant("b", True)
    return GLib.Variant("i", 0)
bus.register_object("/StatusNotifierWatcher", Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], method, prop, None)
def stdin(channel, condition):
    line = sys.stdin.readline()
    if not line:
        loop.quit()
        return False
    if line.strip() == "dump":
        say({"event": "dump", "items": [{"service": s, "path": o} for s, o in items]})
    return True
def owned(conn, name):
    say({"event": "ready"})
Gio.bus_own_name_on_connection(bus, "org.kde.StatusNotifierWatcher", Gio.BusNameOwnerFlags.NONE, owned, None)
GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, stdin)
loop = GLib.MainLoop()
loop.run()
`;

/** Lines from a child's stdout; `next` finds the first matching line at or after index `from`. */
function lines(stream) {
  const waiters = new Set();
  const seen = [];
  let buffered = '';
  stream.on('data', (bytes) => {
    buffered += bytes.toString();
    for (let at = buffered.indexOf('\n'); at !== -1; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      seen.push(line);
      for (const w of [...waiters]) if (seen.length - 1 >= w.from && w.test(line)) { waiters.delete(w); w.resolve(line); }
    }
  });
  return {
    seen,
    next(test, label, { from = 0, timeout = 15_000 } = {}) {
      const old = seen.slice(from).find(test);
      if (old !== undefined) return Promise.resolve(old);
      const { promise, resolve: done, reject } = Promise.withResolvers();
      const waiter = { test, from, resolve: done };
      waiters.add(waiter);
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`${label} did not arrive`)); }, timeout);
      return promise.finally(() => clearTimeout(timer));
    },
  };
}

const services = [];
async function privateBus() {
  const daemon = spawn(tools['dbus-daemon'], ['--session', '--nofork', '--nopidfile', '--print-address=1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  services.push(daemon);
  const out = lines(daemon.stdout);
  const address = (await out.next((l) => l.startsWith('unix:'), 'private D-Bus address')).trim();
  const script = join(fixture, 'tray-watcher.py');
  await writeFile(script, TRAY_WATCHER);
  const watcher = spawn(tools.python3, [script], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address } });
  services.push(watcher);
  const events = lines(watcher.stdout);
  await events.next((l) => l.includes('"ready"'), 'StatusNotifier watcher');
  return {
    address,
    events,
    async dump() {
      const from = events.seen.length;
      watcher.stdin.write('dump\n');
      return JSON.parse(await events.next((l) => l.includes('"dump"'), 'watcher dump', { from, timeout: 30_000 })).items;
    },
  };
}

// -- the main process, seen through Node's inspector ---------------------------------------

/**
 * Counts calls in main's compiled code with conditional breakpoints that never pause: in observer.js,
 * Observer.frame (a frame for the host) and the tick send, with how many ticks saw the screen change; in
 * host-client.js, the host's frame requests and credential requests (every Claude or ChatGPT model call
 * starts with one). Only the inspector the Electron binary already offers is used; the app has no test
 * hook. `evaluate` runs an expression in main, for counting its windows and for the harness's own screen
 * activity. Null when this binary doesn't allow --inspect (a fused package).
 */
async function counters(endpoint, desktopDir) {
  if (!endpoint) return null;
  const observer = (await readFile(join(desktopDir, 'observer.js'), 'utf8')).split('\n');
  const client = (await readFile(join(desktopDir, 'host-client.js'), 'utf8')).split('\n');
  const frameAt = observer.findIndex((l) => /^\s*async frame\(\)\s*\{/.test(l));
  const sendAt = observer.findIndex((l) => /this\.o\.send\(\{/.test(l));
  assert.ok(frameAt > 0 && sendAt > 0, 'observer.js has Observer.frame and the tick send');
  const frameRequestAt = client.findIndex((l) => /case "frame-request":/.test(l));
  const credentialAt = client.findIndex((l) => /case "credential-request":/.test(l));
  assert.ok(frameRequestAt > 0 && credentialAt > 0, 'host-client.js handles frame and credential requests');
  const socket = new WebSocket(endpoint);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error('main inspector refused the connection')); });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const settle = pending.get(message.id);
    if (!settle) return;
    pending.delete(message.id);
    message.error ? settle.fail(new Error(message.error.message)) : settle.done(message.result);
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    pending.set(++id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Debugger.enable');
  const zero = '{ frames: 0, ticks: 0, changed: 0, frameRequests: 0, credentialRequests: 0 }';
  const tally = `(globalThis.__dumSmoke ??= ${zero})`;
  const counter = (name) => `(${tally}.${name}++, false)`;
  const at = async (url, lineNumber, condition) => (await send('Debugger.setBreakpointByUrl', { urlRegex: url, lineNumber, condition })).locations.length > 0;
  const resolved = await Promise.all([
    at('observer\\.js$', frameAt + 1, counter('frames')),
    // `screen` is the tick's local: null, or the changed-cell count against the previous tick.
    at('observer\\.js$', sendAt, `(${tally}.ticks++, screen && screen.changedCells > 0 && ${tally}.changed++, false)`),
    at('host-client\\.js$', frameRequestAt + 1, counter('frameRequests')),
    at('host-client\\.js$', credentialAt + 1, counter('credentialRequests')),
  ]);
  assert.ok(resolved.every(Boolean), 'breakpoints resolved in the loaded observer.js and host-client.js');
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  return {
    read: async () => JSON.parse(await evaluate(`JSON.stringify(globalThis.__dumSmoke ?? ${zero})`)),
    evaluate,
    /** Detaches from main's inspector; Node holds an exiting process open while a session is attached. */
    close: () => new Promise((done) => {
      if (socket.readyState === WebSocket.CLOSED) return done();
      socket.addEventListener('close', () => done(), { once: true });
      socket.close();
      setTimeout(done, 3_000);
    }),
  };
}

// -- launching ------------------------------------------------------------------------------

let active = null;
let bus = null;

/** A private profile, H, HOME and Claude config per install; reused by a relaunch. */
async function install(name) {
  const root = join(fixture, name);
  const dirs = { profile: join(root, 'profile'), h: join(root, 'h'), home: join(root, 'home'), claude: join(root, 'claude'), config: join(root, 'config') };
  await Promise.all(Object.values(dirs).map((d) => mkdir(d, { recursive: true })));
  return dirs;
}

const VIEWS = ['window', 'circle', 'bubble'];

async function launch(dirs, appDir) {
  const env = {
    ...process.env,
    HOME: dirs.home,
    DUM_DESKTOP_DATA: dirs.profile,
    DUM_HOME: dirs.h,
    DUM_CONTEXT: 'off',
    CLAUDE_CONFIG_DIR: dirs.claude,
    XDG_CONFIG_HOME: dirs.config,
    // An empty private directory: no Git, Node, npm or global Claude for the app to lean on.
    PATH: bin,
    NO_AT_BRIDGE: '1',
  };
  for (const key of Object.keys(env)) if (/(?:API_KEY|TOKEN|PASSWORD|SECRET)|^(?:ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|VERTEX_|ANTIGRAVITY_|CLAUDE_CODE_|OLLAMA_)/i.test(key)) delete env[key];
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) delete env[key];
  if (bus) env.DBUS_SESSION_BUS_ADDRESS = bus.address;
  const executable = packaged ?? (await import('electron')).default;
  // A packaged app has Node's inspector fused off; the checkout's main process is counted through it.
  const args = packaged
    ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0']
    : [appDir, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--inspect=127.0.0.1:0'];
  // Only this isolated Linux harness disables the SUID sandbox a checkout usually lacks; renderers stay sandboxed.
  if (linux) args.push('--no-sandbox');
  const child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = Promise.withResolvers();
  let inspector = null;
  let diagnostic = '';
  child.stderr.on('data', (bytes) => {
    diagnostic = (diagnostic + bytes.toString()).slice(-64 * 1024);
    inspector ??= diagnostic.match(/Debugger listening on (ws:\/\/\S+)/)?.[1] ?? null;
    const found = diagnostic.match(/DevTools listening on (ws:\/\/\S+)/);
    if (found) endpoint.resolve(found[1]);
  });
  child.once('error', endpoint.reject);
  const exit = Promise.withResolvers();
  child.once('exit', (code, signal) => {
    exit.resolve({ code, signal });
    endpoint.reject(new Error(`desktop exited before startup (${code ?? signal}): ${diagnostic.slice(-2000)}`));
  });
  const deadline = setTimeout(() => endpoint.reject(new Error('desktop did not expose its debugging endpoint')), 30_000);
  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: await endpoint.promise, defaultViewport: null });
    const page = async (view) => {
      const target = await browser.waitForTarget((t) => t.url().includes(`view=${view}`), { timeout: 30_000 });
      return target.page();
    };
    const [win, circle, bubble] = await Promise.all(VIEWS.map(page));
    await win.waitForFunction(() => typeof window.dum?.invoke === 'function');
    await circle.waitForSelector('button.circle');
    const appDist = packaged ? null : join(appDir, 'dist/desktop');
    let count = null;
    if (appDist && inspector) {
      try {
        count = await counters(inspector, appDist);
      } catch (error) {
        limits.push(`main inspector unavailable: ${error.message}`);
      }
    }
    return { child, browser, win, circle, bubble, count, exit: exit.promise, diagnostic: () => diagnostic };
  } catch (error) {
    child.kill();
    await exit.promise;
    browser?.disconnect();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function invoke(request) {
  return active.win.evaluate((r) => window.dum.invoke(r), request);
}
async function snapshot() {
  const reply = await invoke({ type: 'snapshot' });
  assert.equal(reply.ok, true, reply.error);
  return reply.snapshot;
}
async function until(predicate, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await snapshot();
    if (predicate(last)) return last;
    await delay(150);
  }
  throw new Error(`${label} did not arrive (zones ${last?.zones.zones.length}, active ${last?.activeZone?.breadcrumb.map((b) => b.name).join(' › ') ?? 'none'}, direction ${last?.direction?.status ?? 'none'}/${last?.direction?.attempt?.phase ?? '-'}, look ${last?.look.status}/${last?.look.reason})`);
}
async function focused(page, label, timeout = 10_000) {
  await page.waitForFunction(() => document.hasFocus(), { timeout }).catch(() => { throw new Error(`${label} never got keyboard focus`); });
}
/** Clicks the first button inside `scope` whose visible text is `text`. */
async function press(page, scope, text) {
  const hit = await page.evaluate((s, t) => {
    const button = [...document.querySelectorAll(`${s} button`)].find((b) => b.innerText.trim() === t && !b.disabled && b.offsetParent !== null);
    button?.click();
    return !!button;
  }, scope, text);
  assert.ok(hit, `no visible enabled "${text}" button in ${scope}`);
}
async function stop() {
  if (!active) return;
  const instance = active;
  active = null;
  await instance.count?.close();
  await instance.win.evaluate(() => window.dum.invoke({ type: 'quit' })).catch(() => {});
  const abort = new AbortController();
  try {
    const result = await Promise.race([instance.exit, delay(15_000, undefined, { signal: abort.signal }).then(() => {
      const tail = instance.diagnostic().split('\n').filter((l) => l && !/dbus|DevTools listening|Debugger listening|learn\/getting-started/.test(l)).slice(-12).join('\n');
      instance.child.kill();
      throw new Error(`desktop did not quit within 15 s of Quit; its last stderr:\n${tail}`);
    })]);
    assert.equal(result.code, 0, `desktop exit: ${result.code ?? result.signal}`);
  } finally {
    abort.abort();
    instance.browser.disconnect();
  }
}
/** The working window on screen and focused, the way the hotkey would leave it. */
async function openWindow() {
  await invoke({ type: 'show-surface', surface: 'window' });
  await focused(active.win, 'working window');
  if (linux) assert.ok(await xshown(X_WINDOW), 'the working window X window was not mapped');
}
const credentialCalls = async () => (active.count ? (await active.count.read()).credentialRequests : 0);

// -- journey pieces -----------------------------------------------------------------------

const GOAL = 'I want to get comfortable with recursion and data structures in Python';
const CHILD = { name: 'Trees', goal: 'Binary trees and their traversals', language: 'python' };
const DRAFT = 'how do I walk a tree without recursion';
const OUTCOME = 'An iterative in-order walk for walk.py';
const DEBUG_QUESTION = 'Which look model is running?';
/** The circle's place, as the spec puts it: 8 DIP in from the right edge, 35% down the usable range. */
function defaultCircleAt(area) {
  return { x: area.x + area.w - 8 - 64, y: Math.round(area.y + 8 + 0.35 * (area.h - 16 - 64)) };
}
let screenArea = null;
let circleAfterDrag = null;

async function surfaces() {
  await step('exactly three renderer pages: the working window, the circle and the bubble; no panel or command bar', async () => {
    const urls = active.browser.targets().filter((t) => t.type() === 'page').map((t) => new URL(t.url()).searchParams.get('view'));
    assert.deepEqual([...urls].sort(), [...VIEWS].sort(), `pages: ${urls.join(', ')}`);
    return urls.join(', ');
  }, { critical: true });
  await step('sandboxed renderers: no Node in the window, circle or bubble', async () => {
    for (const page of [active.win, active.circle, active.bubble]) {
      assert.deepEqual(await page.evaluate(() => ({ process: typeof process, require: typeof require })), { process: 'undefined', require: 'undefined' });
    }
  });
  await step('each surface has only its own bridge, and the circle cannot ask for the window\'s data', async () => {
    const circleApi = await active.circle.evaluate(() => ({ dum: typeof window.dum, circle: typeof window.dumCircle?.invoke, bubble: typeof window.dumBubble }));
    assert.deepEqual(circleApi, { dum: 'undefined', circle: 'function', bubble: 'undefined' });
    const refused = await active.circle.evaluate(() => window.dumCircle.invoke({ type: 'snapshot' }));
    assert.equal(refused.ok, false, 'the circle got a snapshot');
    const view = await active.circle.evaluate(() => window.dumCircle.invoke({ type: 'circle-view' }));
    assert.equal(view.ok, true, view.error);
    assert.deepEqual(Object.keys(view.view).sort(), ['open', 'paused', 'reason', 'state'], 'the circle sees only its face');
    const bubbleApi = await active.bubble.evaluate(() => ({ dum: typeof window.dum, circle: typeof window.dumCircle, bubble: typeof window.dumBubble, invoke: typeof window.dumBubble?.invoke }));
    assert.deepEqual(bubbleApi, { dum: 'undefined', circle: 'undefined', bubble: 'object', invoke: 'undefined' });
    return `circle face ${view.view.state}/${view.view.reason}`;
  });
  await step('main owns exactly three BrowserWindows', async () => {
    if (!active.count) return void limits.push('BrowserWindow count not read: main inspector unavailable');
    const windows = await active.count.evaluate(`require('electron').BrowserWindow.getAllWindows().map((w) => { const b = w.getBounds(); return b.width + 'x' + b.height; })`);
    assert.equal(windows.length, 3, `windows: ${windows.join(', ')}`);
    return windows.join(', ');
  });
  if (!linux) {
    unexercised('one circle on screen at its default place', 'needs an X display');
    return;
  }
  await step('one circle X window, 64×64, at the default place: 8 DIP from the right edge, 35% down', async () => {
    const [w, h] = (await xdo('getdisplaygeometry')).split(/\s+/).map(Number);
    screenArea = { x: 0, y: 0, w, h };
    const circle = await xshown(X_CIRCLE, 10_000);
    assert.ok(circle, 'no 64×64 Dum window was mapped');
    const circles = (await xviewable('^Dum$')).filter(X_CIRCLE.test);
    assert.equal(circles.length, 1, `circles: ${JSON.stringify(circles)}`);
    const want = defaultCircleAt(screenArea);
    assert.ok(near(circle.x, want.x) && near(circle.y, want.y), `circle at ${circle.x},${circle.y}; the default is ${want.x},${want.y}`);
    assert.equal((await xviewable('^Dum - command bar$')).length, 0, 'a command bar window is mapped');
    return `circle at ${circle.x},${circle.y} on a ${w}×${h} screen`;
  });
  await step('the circle shows Dum\'s face on a dark disk, labeled as a button', async () => {
    const face = await active.circle.evaluate(() => {
      const b = document.querySelector('button.circle');
      return { label: b.getAttribute('aria-label'), canvas: !!b.querySelector('canvas[aria-hidden="true"], canvas'), text: b.innerText.replace('!', '').trim() };
    });
    assert.match(face.label, /^Dum — .+\. (Open|Hide) Dum$/);
    assert.ok(face.canvas, 'no face canvas');
    assert.equal(face.text, '', 'the circle shows no text');
    await shoot(active.circle, `${current}-circle.png`, { omitBackground: true });
    return face.label;
  });
}

async function firstRun(dirs) {
  const { win } = active;
  await step('fresh profile: no zones, no backend chosen, screen look on by default', async () => {
    const s = await snapshot();
    assert.equal(s.zones.zones.length, 0);
    assert.equal(s.zones.activeZoneId, null);
    assert.equal(s.settings.agent, null);
    assert.equal(s.agent.chosen, null);
    assert.deepEqual(s.settings.look, { apps: true, screen: true });
    assert.deepEqual(s.agent.backends.find((b) => b.id === 'claude')?.methods, ['anthropic-key'], 'Claude takes only an Anthropic API key');
    // Local servers sit at fixed 127.0.0.1 ports that no profile setting isolates; say so when one answered.
    const ready = s.agent.backends.filter((b) => b.ready !== null && b.id !== 'claude');
    if (ready.length) limits.push(`[${current}] a local model server on this machine answered (${ready.map((b) => `${b.label}: ${b.message}`).join('; ')}); Agent setup listed it and read its model list, nothing was chosen, so no model was called`);
    return `backends ${s.agent.backends.map((b) => `${b.id}[${b.methods.join('|')}]`).join(', ')}`;
  }, { critical: true });
  if (linux) {
    await step('first launch opens the one working window by itself, beside the circle', async () => {
      const window = await xshown(X_WINDOW, 10_000);
      assert.ok(window, 'the working window was never mapped within 10 s of a fresh launch');
      assert.equal((await xviewable('^Dum$')).filter(X_WINDOW.test).length, 1, 'one working window');
      const circle = await xshown(X_CIRCLE, 0);
      assert.ok(circle, 'the circle is still on screen');
      assert.ok(!overlap(window, circle), 'the window covers the circle');
      const gap = window.x >= circle.x ? window.x - (circle.x + circle.w) : circle.x - (window.x + window.w);
      assert.equal(gap, 12, `the window is ${gap} DIP from the circle, not 12`);
      const centered = near(window.y + window.h / 2, circle.y + circle.h / 2) || window.y === screenArea.y + 8 || window.y + window.h === screenArea.y + screenArea.h - 8;
      assert.ok(centered, `window ${window.y}+${window.h} isn't centered on the circle at ${circle.y}+${circle.h}`);
      await xscreen(`${current}-screen-first-run.png`);
      return `${window.w}×${window.h} at ${window.x},${window.y}, ${window.x < circle.x ? 'left' : 'right'} of the circle`;
    }, { critical: true });
  }
  await step('the window asks what you are trying to learn, focused for typing', async () => {
    await win.waitForSelector('.first-run:not([hidden]) h1');
    assert.equal(await win.$eval('.first-run h1', (el) => el.textContent), 'What are you trying to learn?');
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'What are you trying to learn?', { timeout: 10_000 });
    if (linux) assert.ok(await xfocusIs((await xshown(X_WINDOW)).id), 'the working window has X keyboard focus');
  }, { critical: true });
  await step('the window is Zones → Current context → Chat, top to bottom, in tab order', async () => {
    const sections = await win.evaluate(() => [...document.querySelectorAll('.window > section')].map((s) => ({
      name: s.getAttribute('aria-label') ?? document.getElementById(s.getAttribute('aria-labelledby') ?? '')?.textContent ?? '',
      top: s.getBoundingClientRect().top,
      height: s.getBoundingClientRect().height,
    })));
    assert.deepEqual(sections.map((s) => s.name), ['Zones', 'Current context', 'Chat']);
    assert.ok(sections.every((s, i) => s.height > 0 && (i === 0 || s.top >= sections[i - 1].top + sections[i - 1].height - 1)), `positions: ${JSON.stringify(sections)}`);
    const chatHead = await win.$$eval('.chat-head button, .chat-head select', (els) => els.map((e) => e.getAttribute('aria-label') ?? e.innerText.trim()));
    assert.ok(chatHead.includes('Mode') && chatHead.some((t) => /Skills \/ Records/.test(t)) && chatHead.includes('Move circle'), `chat header: ${chatHead.join(', ')}`);
    await shoot(win, `${current}-window-first-run.png`);
    return sections.map((s) => `${s.name}@${Math.round(s.top)}`).join(' → ');
  });
  await step('the goal and Return create the root zone and start goal alignment on it; with no model the host keeps it waiting', async () => {
    const calls = await credentialCalls();
    await win.keyboard.type(GOAL);
    await win.keyboard.press('Enter');
    const s = await until((v) => v.activeZone && v.zones.zones.length === 1, 'root zone');
    assert.equal(s.activeZone.goal, GOAL);
    assert.equal(s.settings.agent, null);
    const stored = JSON.parse(await readFile(join(dirs.h, 'zones.json'), 'utf8'));
    assert.equal(stored.activeZoneId, s.activeZone.id);
    assert.equal(stored.zones[0].goal, GOAL, 'the goal is saved locally');
    // The window asks the host to start alignment right after the create; the host's own answer is the record.
    const end = Date.now() + 10_000;
    let read;
    do {
      read = await invoke({ type: 'alignment-read', zoneId: s.activeZone.id });
      assert.equal(read.ok, true, read.error);
      if (read.direction.status !== 'aligning') break;
      await delay(200);
    } while (Date.now() < end);
    assert.equal(read.direction.zoneId, s.activeZone.id, 'the alignment is the new zone\'s own');
    assert.equal(read.direction.status, 'needs-backend', `alignment ${read.direction.status}/${read.direction.attempt?.phase}`);
    assert.equal(read.direction.attempt?.phase, 'needs-backend');
    assert.equal(read.direction.current, null, 'no direction was agreed without you');
    assert.equal(await credentialCalls(), calls, 'a model was asked for');
    return `zone ${s.activeZone.breadcrumb[0].name}, host alignment ${read.direction.status}`;
  }, { critical: true });
  await step('the window\'s snapshot learns that alignment waits for a model', async () => {
    const s = await until((v) => v.direction?.status === 'needs-backend', 'needs-backend in the snapshot', 10_000);
    assert.equal(s.direction.zoneId, s.activeZone.id);
  });
  await step('Chat shows the goal alignment card: your goal, waiting for a model, nothing invented', async () => {
    await win.waitForSelector('.decisions .card.alignment', { timeout: 10_000 });
    await shoot(win, `${current}-alignment.png`);
    const card = await win.$eval('.decisions .card.alignment', (el) => ({ label: el.getAttribute('aria-label'), text: el.innerText, buttons: [...el.querySelectorAll('button')].map((b) => b.innerText.trim()) }));
    const context = await win.$eval('.context', (el) => el.innerText);
    assert.equal(card.label, 'Goal alignment');
    assert.ok(card.text.includes(GOAL), 'the card names the goal');
    assert.ok(context.includes(`Your goal: ${GOAL}`), 'Current context shows the goal');
    assert.equal(await win.$$eval('.decisions .options .option', (els) => els.length), 0, 'options appeared with no model');
    assert.match(card.text, /Alignment waits for a model\. Your goal is saved/, `the card shows: ${card.text.replace(/\s+/g, ' ')} [${card.buttons.join(' / ')}]`);
    assert.deepEqual(card.buttons, ['Who powers Dum?', 'Not now']);
    assert.match(context, /Alignment waits for a model/);
    return card.buttons.join(' / ');
  });
}

/** A zone made inside the root without entering it: its alignment is labeled with that zone and touches nothing in the active one. */
async function otherZone() {
  const { win } = active;
  await step('a zone created inside the root without entering it gets its own labeled alignment; the active zone stays', async () => {
    const before = await snapshot();
    await press(win, '.zones-head', 'Manage');
    await win.waitForSelector('.zone-tree-box.managing [role=treeitem]');
    await win.click('[role=treeitem]');
    await press(win, '.zone-tools', 'Inside');
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Name');
    await win.keyboard.type(CHILD.name);
    await win.focus('.zone-form textarea[aria-label=Goal]');
    await win.keyboard.type(CHILD.goal);
    await win.focus('.zone-form input[aria-label=Language]');
    await win.keyboard.type(CHILD.language);
    await win.evaluate(() => {
      const enter = [...document.querySelectorAll('.zone-form label.check')].find((l) => l.innerText.includes('Enter it now'))?.querySelector('input');
      if (enter?.checked) enter.click();
    });
    await press(win, '.zone-form', 'Create');
    const s = await until((v) => v.zones.zones.length === 2, 'the zone inside');
    const child = s.zones.zones.find((z) => z.id !== before.activeZone.id);
    assert.equal(child.parentId, before.activeZone.id);
    assert.equal(child.goal, CHILD.goal);
    assert.equal(s.activeZone.id, before.activeZone.id, 'the zone you were in stays active');
    assert.equal(s.binding.inputToken, before.binding.inputToken, 'the active zone\'s binding is unchanged');
    assert.equal(s.direction.zoneId, before.activeZone.id, 'the active zone\'s alignment is still its own');
    const label = `Goal alignment for ${before.activeZone.breadcrumb[0].name} › ${CHILD.name}`;
    await win.waitForFunction((l) => [...document.querySelectorAll('.decisions .card.alignment')].some((c) => c.getAttribute('aria-label') === l && !/reading your goal/.test(c.innerText)), { timeout: 10_000 }, label);
    const text = await win.$eval(`.decisions .card.alignment[aria-label="${label}"]`, (el) => el.innerText);
    assert.match(text, /not the zone you're in/);
    assert.ok(text.includes(CHILD.goal), 'the card names that zone\'s goal');
    await win.evaluate(() => document.querySelector('.decisions')?.scrollIntoView());
    await shoot(win, `${current}-other-zone-alignment.png`);
    await win.keyboard.press('Escape'); // closes Manage, not the window
    await win.waitForSelector('.zone-tree-box:not(.managing)');
    assert.equal((await snapshot()).window.visible, true, 'Esc hid the window instead of closing Manage');
    return label;
  });
}

async function noTray() {
  if (!linux) {
    unexercised('no tray icon', 'read over a private D-Bus StatusNotifier watcher on Linux only');
    return;
  }
  await step('no tray: nothing registers with the StatusNotifier host', async () => {
    await delay(2_000);
    const items = await bus.dump();
    assert.deepEqual(items, [], `registered: ${JSON.stringify(items)}`);
    assert.equal(bus.events.seen.filter((l) => l.includes('"registered"')).length, 0);
    return 'zero items';
  });
}

/** Real pointer input on the circle through XTest: the round hit region, click, hold and drag. */
async function circleGestures(dirs) {
  const { circle: page, count } = active;
  if (!linux) {
    unexercised('circle click, hold and drag', 'needs XTest (xdotool) on an X display');
    return;
  }
  const presses = () => page.evaluate(() => window.__smokePresses.splice(0));
  await page.evaluate(() => {
    window.__smokePresses = [];
    window.addEventListener('pointerdown', (e) => window.__smokePresses.push({ x: e.clientX, y: e.clientY }), { capture: true });
  });
  await step('Esc hides only the working window; the circle stays', async () => {
    const window = await xshown(X_WINDOW);
    await xdo('windowfocus', '--sync', window.id);
    await active.win.focus('textarea.composer-input');
    await xdo('key', 'Escape');
    assert.ok(await xgone(X_WINDOW), 'the working window stayed mapped');
    assert.ok(await xshown(X_CIRCLE, 0), 'the circle went with it');
    assert.equal((await snapshot()).window.visible, false);
  }, { critical: true });
  if (!count) {
    unexercised('circle click, hold and drag', 'needs main\'s inspector for the desk window that lets Electron track the pointer under Xvfb');
    return;
  }
  // Under Xvfb, Electron's screen.getCursorScreenPoint() only follows the pointer while one of its own
  // windows has X focus or is under the pointer; on a desktop there is always an app under the circle.
  // This transparent, unfocusable full-screen window stands in for that app, below the circle, and
  // records the clicks that reach it. The harness creates it through main's inspector; Dum has no hook.
  const deskClicks = async () => JSON.parse(await count.evaluate('globalThis.__dumSmokeDesk.webContents.executeJavaScript("JSON.stringify(window.clicks.splice(0))")'));
  await step('a transparent desk window under the circle stands in for the app the person is in', async () => {
    await count.evaluate(`(async () => {
      const { BrowserWindow, screen } = require('electron');
      const desk = new BrowserWindow({ ...screen.getPrimaryDisplay().bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true } });
      await desk.loadURL('data:text/html,' + encodeURIComponent('<title>smoke desk</title><body style="margin:0;background:transparent"><script>window.clicks=[];addEventListener("mousedown",(e)=>clicks.push([e.screenX,e.screenY]))</script>'));
      desk.showInactive();
      globalThis.__dumSmokeDesk = desk;
    })()`);
    // Xvfb has no window manager to keep the floating circle above a newer window (Electron's moveTop
    // asks the window manager), so the harness raises the circle itself, as a window manager would.
    await xdo('windowraise', (await xshown(X_CIRCLE, 0)).id);
    limits.push('Under Xvfb, Electron only tracks the pointer over or while focusing one of its own windows, and there is no window manager: the circle steps ran over a harness-made transparent desk window (created through main\'s inspector) with the circle raised by XRaiseWindow. The round hit region\'s timing and click-through on macOS are not shown here.');
    await xdo('mousemove', '20', '20');
    await delay(300);
    const cursor = await count.evaluate(`JSON.stringify(require('electron').screen.getCursorScreenPoint())`);
    assert.deepEqual(JSON.parse(cursor), { x: 20, y: 20 }, 'Electron still does not see the pointer');
    await xdo('click', '1');
    await delay(300);
    assert.deepEqual(await deskClicks(), [[20, 20]], 'the desk did not get a plain click');
  }, { critical: true });
  let at = await xshown(X_CIRCLE);
  await step('the transparent corner of the circle window passes clicks through to the app under it and opens nothing', async () => {
    await presses();
    await xdo('mousemove', String(at.x + 2), String(at.y + 2));
    await delay(250); // the 16 ms hit-region timer lets go of the pointer outside the disk
    await xdo('click', '1');
    await delay(500);
    assert.deepEqual(await presses(), [], 'the circle page saw a press in its corner');
    assert.deepEqual(await deskClicks(), [[at.x + 2, at.y + 2]], 'the click did not reach the app under the corner');
    assert.ok(await xstaysGone(X_WINDOW, 1_500), 'a corner click opened the working window');
    return `click at ${at.x + 2},${at.y + 2} reached the window underneath`;
  });
  await step('a short click on the disk opens the working window beside the circle, focused on the composer', async () => {
    await xdo('mousemove', String(at.x + 32), String(at.y + 32));
    await delay(250);
    await xdo('click', '1');
    const window = await xshown(X_WINDOW);
    assert.equal((await presses()).length, 1, 'the press did not reach the circle');
    assert.deepEqual(await deskClicks(), [], 'the disk let the click through');
    assert.ok(window, 'the click did not open the working window');
    assert.ok(await xfocusIs(window.id), 'the working window has X keyboard focus');
    await active.win.waitForFunction(() => document.activeElement?.matches('textarea.composer-input'), { timeout: 5_000 });
    assert.ok(!overlap(window, at), 'the window covers the circle');
    const s = await snapshot();
    assert.equal(s.window.visible, true);
    return `${window.w}×${window.h} at ${window.x},${window.y}`;
  });
  /** Electron's own idea of which Dum window has focus, by size. */
  const electronFocus = () => count.evaluate(`require('electron').BrowserWindow.getAllWindows().filter((w) => w.isFocused()).map((w) => w.getBounds().width + 'x' + w.getBounds().height).join(',') || 'none'`);
  /** A check's starting point, not part of what it checks: the working window closed. */
  const closeWindow = async () => {
    if (!(await xgone(X_WINDOW, 0))) await invoke({ type: 'dismiss-surface', surface: 'window' });
    assert.ok(await xgone(X_WINDOW), 'the working window could not be closed before this check');
  };
  await step('clicking the circle while the window has focus hides it', async () => {
    const window = await xshown(X_WINDOW, 0);
    assert.ok(window && (await xfocusIs(window.id)), 'the window was not open and focused');
    await delay(300); // past §2's 250 ms toggle debounce: this is a second click, not a double click
    const before = await electronFocus();
    await xdo('mousedown', '1');
    await delay(150);
    const during = { x: (await xfocus()) === window.id ? 'window' : await xfocus(), electron: await electronFocus() };
    await xdo('mouseup', '1');
    assert.equal((await presses()).length, 1, 'the press did not reach the circle');
    assert.ok(await xgone(X_WINDOW), `the window stayed open (Electron focus before the press: ${before}; during it: X ${during.x}, Electron ${during.electron})`);
  });
  await step('a long stationary hold on the circle does nothing', async () => {
    await closeWindow();
    await xdo('mousedown', '1');
    await delay(900);
    await xdo('mouseup', '1');
    assert.equal((await presses()).length, 1, 'the press did not reach the circle');
    assert.ok(await xstaysGone(X_WINDOW, 1_500), 'a hold opened the window');
    const now = await xshown(X_CIRCLE, 0);
    assert.ok(now && now.x === at.x && now.y === at.y, 'a hold moved the circle');
  });
  await closeWindow().catch(() => {});
  const before = await count.read();
  await step('a real drag moves the circle with the pointer, opens nothing and saves its place once', async () => {
    const dx = -240;
    const dy = 160;
    await xdo('mousemove', String(at.x + 32), String(at.y + 32));
    await delay(250);
    await xdo('mousedown', '1');
    for (let i = 1; i <= 20; i++) {
      await xdo('mousemove', String(at.x + 32 + Math.round((dx * i) / 20)), String(at.y + 32 + Math.round((dy * i) / 20)));
      await delay(30);
    }
    await delay(200);
    await xdo('mouseup', '1');
    await delay(500);
    const moved = await xshown(X_CIRCLE, 0);
    assert.ok(moved, 'the circle disappeared');
    assert.ok(near(moved.x, at.x + dx, 2) && near(moved.y, at.y + dy, 2), `circle at ${moved.x},${moved.y}; dragged to ${at.x + dx},${at.y + dy}`);
    assert.ok(await xstaysGone(X_WINDOW, 1_500), 'the drag opened the window');
    const stored = JSON.parse(await readFile(join(dirs.profile, 'settings.json'), 'utf8'));
    assert.equal(stored.version, 3);
    assert.equal(stored.circle.placements.length, 1, `placements: ${JSON.stringify(stored.circle.placements)}`);
    const [placement] = stored.circle.placements;
    assert.equal(placement.displayId, stored.circle.lastChosenDisplayId);
    const u = (moved.x - (screenArea.x + 8)) / (screenArea.w - 16 - 64);
    const v = (moved.y - (screenArea.y + 8)) / (screenArea.h - 16 - 64);
    assert.ok(near(placement.u, u, 0.01) && near(placement.v, v, 0.01), `saved u,v ${placement.u},${placement.v}; on screen ${u.toFixed(3)},${v.toFixed(3)}`);
    assert.equal(stored.settings.agent, null, 'the drag left preferences alone');
    circleAfterDrag = moved;
    at = moved;
    await shoot(page, `${current}-circle-dragged.png`, { omitBackground: true });
    return `moved to ${moved.x},${moved.y}; saved u=${placement.u.toFixed(3)} v=${placement.v.toFixed(3)} on display ${placement.displayId}`;
  });
  await step('the circle animating and dragged over an unchanged screen: no look tick sees a change', async () => {
    const end = Date.now() + 15_000;
    while (Date.now() < end && (await count.read()).ticks < before.ticks + 3) await delay(500);
    const n = await count.read();
    assert.ok(n.ticks >= before.ticks + 3, `only ${n.ticks - before.ticks} look ticks arrived`);
    assert.equal(n.changed, before.changed, `${n.changed - before.changed} ticks saw Dum's own circle as a screen change`);
    assert.equal(n.frameRequests, before.frameRequests);
    return `${n.ticks - before.ticks} ticks, ${n.changed - before.changed} with changes`;
  });
  await step('after the drag a click opens the window beside the circle\'s new place', async () => {
    await closeWindow();
    await xdo('mousemove', String(at.x + 32), String(at.y + 32));
    await delay(250);
    await xdo('click', '1');
    const window = await xshown(X_WINDOW);
    assert.ok(window, 'the window did not open');
    assert.ok(!overlap(window, at), 'the window covers the circle');
    const gap = window.x >= at.x ? window.x - (at.x + at.w) : at.x - (window.x + window.w);
    assert.equal(gap, 12, `the window is ${gap} DIP from the circle`);
    await xdo('windowraise', window.id); // a window manager raises a window that shows
    await xscreen(`${current}-screen-window.png`);
    await invoke({ type: 'dismiss-surface', surface: 'window' });
    assert.ok(await xgone(X_WINDOW));
    return `${window.x < at.x ? 'left' : 'right'} of the circle`;
  });
  await closeWindow().catch(() => {});
  await count.evaluate('globalThis.__dumSmokeDesk.destroy()');
}

/** An Electron accelerator as xdotool key names: CommandOrControl+Shift+D → ctrl+shift+d. */
function xkeys(accelerator) {
  const names = { CommandOrControl: 'ctrl', CmdOrCtrl: 'ctrl', Control: 'ctrl', Ctrl: 'ctrl', Shift: 'shift', Alt: 'alt', Option: 'alt', Super: 'super', Return: 'Return', Enter: 'Return', Space: 'space' };
  return accelerator.split('+').map((part) => names[part] ?? part.toLowerCase()).join('+');
}

/** The real global shortcut, typed through X, and Esc. */
async function keyboard() {
  const { win } = active;
  if (!linux) {
    unexercised('hotkey → window → typing → Esc', 'needs XTest (xdotool) on an X display');
    await openWindow();
    return;
  }
  const keys = xkeys((await snapshot()).settings.hotkey);
  await step(`with no Dum window in front, the hotkey (${keys}) opens the window with the composer focused; typing goes into it`, async () => {
    assert.ok(await xgone(X_WINDOW, 0), 'the window was already open');
    await xdo('key', '--clearmodifiers', keys);
    const window = await xshown(X_WINDOW);
    assert.ok(window, 'the working window was not mapped');
    await focused(win, 'working window');
    assert.ok(await xfocusIs(window.id), 'the working window has X keyboard focus');
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message to Dum');
    await xdo('type', '--delay', '20', DRAFT);
    await win.waitForFunction((t) => document.activeElement?.value === t, { timeout: 10_000 }, DRAFT);
    return `window ${window.w}×${window.h} at ${window.x},${window.y}`;
  });
  await step('Esc hides the working window, keeps the draft and sends nothing; the circle stays', async () => {
    await xdo('key', 'Escape');
    assert.ok(await xgone(X_WINDOW), 'the working window stayed mapped');
    assert.ok(await xshown(X_CIRCLE, 0), 'the circle went too');
    const s = await until((v) => v.draft.text === DRAFT, 'draft kept in main');
    assert.equal(s.state.transcript.some((e) => e.kind === 'user'), false, 'nothing was sent');
    assert.equal(s.state.busy, false, 'nothing is running');
  });
  await step('the hotkey reopens the same window with the same draft', async () => {
    await xdo('key', '--clearmodifiers', keys);
    const window = await xshown(X_WINDOW);
    assert.ok(window, 'the working window was not mapped');
    assert.ok(await xfocusIs(window.id), 'the working window has X keyboard focus');
    await win.waitForFunction((t) => document.querySelector('textarea.composer-input')?.value === t, { timeout: 10_000 }, DRAFT);
    await shoot(win, `${current}-window-reopened.png`);
  });
  await step('Esc closes an inner chooser first and leaves the window open', async () => {
    await press(win, '.composer', 'Share');
    await win.waitForSelector('.chooser-box:not([hidden]) [role=group]');
    await xdo('key', 'Escape');
    await win.waitForSelector('.chooser-box[hidden]', { timeout: 5_000 });
    assert.ok(await xshown(X_WINDOW, 0), 'the window closed with the chooser');
  });
  await step('the hotkey while the window has focus hides it', async () => {
    const window = await xshown(X_WINDOW);
    assert.ok(await xfocusIs(window.id), 'the window lost focus');
    await xdo('key', '--clearmodifiers', keys);
    assert.ok(await xgone(X_WINDOW), 'the focused hotkey left the window open');
    assert.equal((await snapshot()).draft.text, DRAFT);
  });
  await xdo('key', '--clearmodifiers', keys);
  assert.ok(await xshown(X_WINDOW), 'the hotkey did not reopen the window');
  await focused(win, 'working window');
}

/** No backend: Help me decide and the handoff never make up options or a handoff, and nothing is sent. */
async function decisions(dirs) {
  const { win } = active;
  await step('Help me decide with no backend opens Agent setup; no card, no handoff, nothing sent', async () => {
    const calls = await credentialCalls();
    await press(win, '.decisions .outcome-bar', 'Help me decide');
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'The outcome you need next');
    await win.evaluate(() => { document.activeElement.value = ''; });
    await win.keyboard.type(OUTCOME);
    await win.keyboard.press('Enter');
    await win.waitForSelector('.agent-setup:not([hidden]) h2', { timeout: 10_000 });
    assert.equal(await win.$eval('.agent-setup h2', (el) => el.textContent), 'Who powers Dum?');
    const s = await snapshot();
    assert.equal(s.agent.chosen, null);
    assert.equal(s.decision, null, 'a decision card appeared with no model');
    assert.equal(s.handoff, null, 'a handoff appeared with no model');
    assert.equal(s.draft.text, DRAFT, 'the draft changed');
    assert.equal(s.state.transcript.some((e) => e.kind === 'user'), false, 'something was sent');
    assert.equal(await win.$$eval('.decisions .card.decision, .decisions .card.handoff', (els) => els.length), 0);
    assert.equal(await credentialCalls(), calls, 'a model was asked for');
    await shoot(win, `${current}-agent-setup.png`);
    return `rows: ${s.agent.backends.map((b) => `${b.id} ${b.ready ? 'ready' : 'not set up'}`).join(', ')}`;
  });
  await step('the host refuses decision help with no backend, says why, and makes no card', async () => {
    const s = await snapshot();
    const r = await invoke({ type: 'decision-help', binding: s.binding, outcome: OUTCOME });
    assert.equal(r.ok, false, 'decision help answered without a model');
    assert.match(r.error, /decision help is unavailable: choose who powers Dum/);
    const after = await snapshot();
    assert.equal(after.decision, null);
    assert.equal(after.handoff, null);
    return r.error;
  });
  await step('no handoff can be chosen or run without a card, and nothing was written', async () => {
    const s = await snapshot();
    // Well-formed ids for a card and handoff that don't exist, so the host's own rule answers, not the schema.
    const select = await invoke({ type: 'handoff-select', binding: s.binding, decisionId: randomUUID(), revision: 0, optionId: randomUUID() });
    assert.equal(select.ok, false, 'a handoff was chosen from no card');
    assert.doesNotMatch(select.error, /doesn't accept/, 'the request shape was refused, not the missing card');
    const runIt = await invoke({ type: 'handoff-run', binding: s.binding, handoffId: randomUUID(), revision: 0, draftRevision: s.draft.revision });
    assert.equal(runIt.ok, false, 'a handoff ran from nothing');
    assert.doesNotMatch(runIt.error, /doesn't accept/, 'the request shape was refused, not the missing handoff');
    const after = await snapshot();
    assert.equal(after.handoff, null);
    assert.equal(after.draft.text, DRAFT, 'the refused Do this consumed the draft');
    assert.equal(after.changes.length, 0);
    assert.ok(!existsSync(join(dirs.h, 'handoffs')) || (await readdir(join(dirs.h, 'handoffs'), { recursive: true })).every((f) => !f.endsWith('.json')), 'a handoff record was written');
    return `${select.error} / ${runIt.error}`;
  });
  await step('Claude offers only the API-key field', async () => {
    const radio = '.agent-setup input[name="backend-setup"][value="claude"]';
    await win.waitForSelector(radio, { timeout: 15_000 });
    await win.focus(radio);
    await win.keyboard.press('Space');
    await win.waitForFunction((r) => document.querySelector(r)?.checked, {}, radio);
    const methods = await win.$$eval('.agent-setup .methods input[type=radio]', (els) => els.map((el) => el.value));
    const text = await win.$eval('.agent-setup', (el) => el.innerText);
    assert.deepEqual(methods, [], 'one method: no method choice is offered');
    assert.doesNotMatch(text, /Sign in with Claude|subscription/i);
    await win.waitForSelector('.agent-setup input[aria-label="Anthropic API key"]', { timeout: 10_000 });
    await shoot(win, `${current}-agent-claude.png`);
    return 'anthropic-key only';
  });
  await step('main refuses the removed Claude subscription login as an unknown method', async () => {
    const r = await invoke({ type: 'agent-login', backend: 'claude', method: 'claude-subscription' });
    assert.equal(r.ok, false, 'the removed sign-in was accepted');
    assert.match(r.error, /doesn't accept \(method\)/);
    return r.error;
  });
}

/** Settings is a sheet in Chat with exactly §5's list. */
async function settings() {
  const { win } = active;
  await step('Settings opens inside Chat with Zones and Current context still above it', async () => {
    await win.click('.zones-head button[aria-label="Settings"]');
    await win.waitForFunction(() => document.querySelector('#aux-title')?.textContent === 'Settings' && !document.querySelector('.aux').hidden);
    const layout = await win.evaluate(() => ({
      inChat: !!document.querySelector('.chat .chat-region .aux.sheet .settings'),
      zones: document.querySelector('.zones-section').offsetParent !== null,
      context: document.querySelector('.context').offsetParent !== null,
      chatHidden: document.querySelector('.chat-main').hidden,
      focus: document.activeElement?.id,
    }));
    assert.deepEqual(layout, { inChat: true, zones: true, context: true, chatHidden: true, focus: 'aux-title' });
  }, { critical: true });
  await step('Settings holds exactly: Agent, Look, Shortcuts, Open at login, Use personal context, Set up voice, Debug chat, version and Quit', async () => {
    const rows = await win.$eval('.aux .settings', (el) => [...el.children].map((c) => {
      if (c.tagName === 'DETAILS') return `disclosure ${c.querySelector('summary').innerText.trim()}`;
      if (c.classList.contains('settings-foot')) return `footer ${c.innerText.trim().replace(/\s+/g, ' ')}`;
      const check = c.querySelector(':scope > label.check span');
      if (check) return `switch ${check.innerText.trim()}`;
      return `button ${c.querySelector(':scope > button').innerText.trim()}`;
    }));
    const s = await snapshot();
    assert.deepEqual(rows, [
      'disclosure Agent',
      'disclosure Look',
      'disclosure Shortcuts',
      'switch Open at login',
      'switch Use personal context',
      'button Set up voice',
      'disclosure Debug chat',
      `footer Dum ${s.version} · ${s.platform} Quit Dum`,
    ]);
    return rows.join(' | ');
  });
  await step('every control outside Agent and Debug chat is a §5 control; no theme, topmost, workspace, mode, follow or web tree', async () => {
    const controls = await win.$eval('.aux .settings', (el) => {
      const outside = (c) => !c.closest('.agent-sheet') && !c.closest('.debug');
      return [...el.querySelectorAll('button, input, select, textarea')].filter(outside).map((c) => {
        // textContent: a collapsed disclosure renders no innerText.
        if (c.tagName === 'BUTTON') return `button ${c.textContent.trim()}`;
        const label = c.getAttribute('aria-label') ?? c.closest('label')?.textContent.trim();
        return `${c.tagName === 'INPUT' ? c.type : c.tagName.toLowerCase()} ${label}`;
      });
    });
    assert.deepEqual(controls, [
      'checkbox Apps: notice when you switch apps',
      'checkbox Screen: notice screen changes and send the look model one fresh frame per changed tick',
      'button Open Screen Recording settings',
      'text Open Dum',
      'text Hold to talk',
      'text Send the draft',
      'checkbox Open at login',
      'checkbox Use personal context',
      'button Set up voice',
      'button Quit Dum',
    ]);
    const text = await win.$eval('.aux .settings', (el) => el.textContent);
    assert.doesNotMatch(text, /theme|always on top|all workspaces|Follow a folder|Web tree|Sync now|Mode: /i);
    return `${controls.length} controls`;
  });
  await step('disclosures start collapsed except the needed recovery (no agent chosen opens Agent)', async () => {
    const open = await win.$$eval('.aux .settings > details', (els) => els.map((d) => `${d.querySelector('summary').innerText.trim()}:${d.open}`));
    assert.deepEqual(open, ['Agent:true', 'Look:false', 'Shortcuts:false', 'Debug chat:false']);
  });
  await step('Look explains the 3-second look with its status and permission; Shortcuts shows the three defaults', async () => {
    await win.evaluate(() => { for (const d of document.querySelectorAll('.aux .settings > details')) if (/Look|Shortcuts/.test(d.querySelector('summary').innerText)) d.open = true; });
    const look = await win.$eval('.aux .settings > details:nth-of-type(2)', (el) => el.innerText);
    assert.match(look, /Every 3 seconds/);
    assert.match(look, /Looking is on\./);
    assert.match(look, process.platform === 'darwin' ? /Screen Recording: / : /Screen Recording: no permission needed on this system\./);
    const keys = await win.$$eval('.aux .settings input.hotkey', (els) => els.map((e) => `${e.getAttribute('aria-label')}=${e.value}`));
    const want = process.platform === 'darwin'
      ? ['Open Dum=⌘⇧D', 'Hold to talk=⌃⌥Space', 'Send the draft=⌘⇧↩']
      : ['Open Dum=Ctrl + Shift + D', 'Hold to talk=Control + Option + Space', 'Send the draft=Ctrl + Shift + Return'];
    assert.deepEqual(keys, want, `shortcuts: ${keys.join(', ')}`);
    await win.evaluate(() => document.querySelector('.aux .settings > details:nth-of-type(2)')?.scrollIntoView());
    await shoot(win, `${current}-settings-look-shortcuts.png`);
    // The whole list at once: every disclosure collapsed for the picture, then Agent as it was.
    await win.evaluate(() => { for (const d of document.querySelectorAll('.aux .settings > details')) d.open = false; });
    await win.evaluate(() => document.querySelector('.aux .settings')?.scrollIntoView());
    await shoot(win, `${current}-settings.png`);
    await win.evaluate(() => document.querySelector('.aux .settings .settings-foot')?.scrollIntoView());
    await shoot(win, `${current}-settings-end.png`);
    await win.evaluate(() => { document.querySelector('.aux .settings > details:nth-of-type(1)').open = true; });
    return keys.join(', ');
  });
  await step('moved controls live where §5 puts them: Mode in Chat, Pause in Current context, follow in Context, web tree in Skills', async () => {
    const where = await win.evaluate(() => ({
      mode: !!document.querySelector('.chat-head select[aria-label=Mode]'),
      pause: [...document.querySelectorAll('.context .section-head button')].some((b) => /Pause looking|Resume looking/.test(b.getAttribute('aria-label') ?? '')),
    }));
    assert.deepEqual(where, { mode: true, pause: true });
    await press(win, '.aux-head', '‹ Back');
    await win.waitForFunction(() => document.querySelector('.aux').hidden);
    await press(win, '.chat-head', 'Skills / Records');
    await press(win, '.chat-head .menu-list', 'Skills');
    await win.waitForFunction(() => document.querySelector('#aux-title')?.textContent === 'Skills');
    const web = await win.$$eval('.aux .web-tree button', (bs) => bs.map((b) => b.textContent.trim()));
    for (const label of ['Link', 'Sync now', 'New link', 'Unlink']) assert.ok(web.includes(label), `Skills › Web tree lacks ${label}: ${web.join(', ')}`);
    await press(win, '.aux-head', '‹ Back');
    await press(win, '.context', 'Context / followed folders');
    await win.waitForFunction(() => /Records/.test(document.querySelector('#aux-title')?.textContent ?? ''));
    assert.ok(await win.evaluate(() => [...document.querySelectorAll('.aux button')].some((b) => b.innerText.includes('Follow a folder'))), 'Context has no Follow a folder');
    await press(win, '.aux-head', '‹ Back');
    return 'mode, pause, web tree and follow found';
  });
}

/** Settings → Debug chat with no agent: its own draft, needs-backend, nothing sent. */
async function debugChat() {
  const { win } = active;
  await win.click('.zones-head button[aria-label="Settings"]');
  await win.waitForFunction(() => document.querySelector('#aux-title')?.textContent === 'Settings');
  const debugBox = '.aux .settings > details:nth-of-type(4)';
  const chipText = () => win.$eval(`${debugBox} .debug [role=status]`, (el) => el.textContent.trim());
  await step('Debug chat opens its own session and stays ready while the window keeps updating', async () => {
    await win.click(`${debugBox} > summary`);
    await win.waitForSelector(`${debugBox} textarea[aria-label="Question about Dum"]`, { visible: true });
    await win.waitForFunction((b) => document.querySelector(`${b} .debug [role=status]`)?.textContent.trim() === 'ready', { timeout: 5_000 }, debugBox).catch(() => {});
    assert.equal(await chipText(), 'ready', 'the debug chat never showed ready');
    // Look ticks and other host changes redraw the window every few seconds.
    await delay(7_000);
    const s = await snapshot();
    assert.equal(await chipText(), 'ready', `after a few seconds the debug chat shows "${await chipText()}" (snapshot debug: ${JSON.stringify(s.debug)})`);
    return 'ready';
  });
  let uiSent = false;
  await step('typing a debug question and Return with no agent shows needs-backend in the debug chat', async () => {
    const calls = await credentialCalls();
    await win.focus(`${debugBox} textarea`);
    await win.keyboard.type(DEBUG_QUESTION);
    const sendEnabled = await win.$eval(`${debugBox} .debug button[type=submit]`, (b) => !b.disabled);
    await win.keyboard.press('Enter');
    const s = await until((v) => v.debug?.state === 'needs-backend', `needs-backend (Send was ${sendEnabled ? 'enabled' : 'disabled'}, the chip said "${await chipText()}")`, 5_000);
    uiSent = true;
    assert.deepEqual(s.debug.entries, [], 'the question was recorded or answered');
    assert.equal(s.draft.text, DRAFT, 'the zone draft changed');
    assert.equal(s.state.transcript.some((e) => e.kind === 'user'), false, 'the question went to the zone chat');
    assert.equal(await credentialCalls(), calls, 'a model was asked for');
  });
  await step('the host answers a debug send with no agent with needs-backend, records nothing and calls no model', async () => {
    const calls = await credentialCalls();
    const opened = await invoke({ type: 'debug-open' });
    assert.equal(opened.ok, true, opened.error);
    if (opened.debug.state === 'idle') {
      const sent = await invoke({ type: 'debug-send', binding: opened.debug.binding, text: DEBUG_QUESTION });
      assert.equal(sent.ok, true, sent.error);
    }
    const s = await until((v) => v.debug?.state === 'needs-backend', 'needs-backend in the snapshot', 5_000);
    assert.deepEqual(s.debug.entries, []);
    assert.equal(s.draft.text, DRAFT, 'the zone draft changed');
    assert.equal(await credentialCalls(), calls, 'a model was asked for');
    await win.waitForFunction((b) => /needs a model/.test(document.querySelector(`${b} .debug [role=status]`)?.textContent ?? ''), { timeout: 5_000 }, debugBox);
    const notice = await win.$eval(`${debugBox} .debug .notice`, (el) => (el.hidden ? '' : el.innerText));
    assert.match(notice, /The debug chat uses Dum's model\. Set one up; your question stays here\./);
    await win.evaluate((b) => document.querySelector(b)?.scrollIntoView(), debugBox);
    await shoot(win, `${current}-debug-chat.png`);
    return notice.replace(/\s+/g, ' ');
  });
  if (uiSent) {
    await step('the debug question stays in the debug draft after needs-backend (§6: setup preserves the debug draft)', async () => {
      const draft = await win.$eval(`${debugBox} textarea`, (el) => el.value);
      assert.equal(draft, DEBUG_QUESTION, `the debug draft is ${JSON.stringify(draft)}`);
    });
  } else {
    unexercised('the debug question stays in the debug draft after needs-backend', 'the debug chat\'s own Send never reached the host');
  }
  await step('Set up Agent from the debug chat opens Settings › Agent', async () => {
    await press(win, `${debugBox} .debug .notice`, 'Set up Agent');
    const open = await win.$eval('.aux .settings > details:nth-of-type(1)', (d) => d.open);
    assert.equal(open, true);
  });
  await step('Esc in Settings closes Settings back to Chat, even with a Chat form left open under it', async () => {
    const formBefore = await win.$$eval('.decisions .card-form', (els) => els.length);
    await win.focus('#aux-title');
    await win.keyboard.press('Escape');
    await delay(300);
    const after = await win.evaluate(() => ({ aux: !document.querySelector('.aux').hidden, form: document.querySelectorAll('.decisions .card-form').length }));
    if (after.aux) {
      // Leave Settings for the steps that follow, whatever the first Esc did.
      await win.keyboard.press('Escape');
      await win.waitForFunction(() => document.querySelector('.aux').hidden, { timeout: 5_000 }).catch(() => {});
    }
    assert.equal((await snapshot()).window.visible, true, 'Esc hid the window instead of closing Settings');
    assert.equal(after.aux, false, `the first Esc left Settings open${formBefore && !after.form ? ' and closed the "Your outcome" form hidden in Chat under it instead' : ''}`);
  });
}

/** Follow a folder from Current context, then the look with no backend. */
async function lookAndFollow(dirs) {
  const { win, count } = active;
  if (!linux) {
    unexercised('followed folder via the native folder picker', 'needs XTest (xdotool) for the native picker');
    return;
  }
  let follow;
  await step('Current context › Context › Follow a folder… opens the native picker; the chosen non-Git folder is followed', async () => {
    assert.equal(existsSync(join(learning, '.git')), false);
    await press(win, '.context', 'Context / followed folders');
    await win.waitForFunction(() => /Records/.test(document.querySelector('#aux-title')?.textContent ?? ''));
    await press(win, '.aux', 'Follow a folder…');
    const picker = 'Choose a folder for Dum to follow';
    const dialog = await xwindow(active.child.pid, picker, 'folder picker');
    await xdo('windowfocus', '--sync', dialog);
    await xdo('key', '--clearmodifiers', 'ctrl+l');
    await delay(300);
    await xdo('type', '--delay', '10', learning);
    await delay(500);
    // Alt+O is the picker's accept button ("_Open"); Return in its location field doesn't accept the folder here.
    await xdo('key', '--clearmodifiers', 'alt+o');
    const s = await until((v) => v.follows.length === 1, 'followed folder', 10_000);
    const end = Date.now() + 5_000;
    while (Date.now() < end && (await xwindows(active.child.pid, picker)).length) await delay(150);
    assert.equal((await xwindows(active.child.pid, picker)).length, 0, 'the picker closed');
    assert.ok(await xshown(X_WINDOW, 0), 'the picker hid the working window');
    follow = s.follows[0];
    assert.equal(follow.label, 'learning');
    assert.equal(follow.files, 2, 'walk.py and README.md');
    await press(win, '.aux-head', '‹ Back');
    return `${follow.label}: ${follow.files} files`;
  });
  const statuses = new Set();
  let sampling = true;
  const sampler = (async () => {
    while (sampling && active) {
      try {
        const look = (await snapshot()).look;
        statuses.add(`${look.status}/${look.reason ?? '-'}`);
      } catch { /* the run is ending */ }
      await delay(250);
    }
  })();
  // The look stops while a Dum window is in front, so it runs here with only the circle showing.
  let flicker = false;
  await step('with only the circle showing, the look ticks', async () => {
    await invoke({ type: 'dismiss-surface', surface: 'window' });
    assert.ok(await xgone(X_WINDOW), 'the working window stayed mapped');
    if (!count) {
      limits.push('look ticks, frame requests and credential requests not counted: main inspector unavailable');
      return 'window hidden';
    }
    const before = (await count.read()).ticks;
    const end = Date.now() + 15_000;
    while (Date.now() < end && (await count.read()).ticks === before) await delay(500);
    assert.ok((await count.read()).ticks > before, 'no look tick arrived with the window hidden');
    // The harness's own screen activity: an unfocusable, inactive window over the display under the
    // cursor that alternates black and white, so the look's ticks see the screen change.
    try {
      flicker = await count.evaluate(`(() => {
        const { BrowserWindow, screen } = require('electron');
        const bounds = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
        const w = new BrowserWindow({ ...bounds, show: false, frame: false, focusable: false, skipTaskbar: true, backgroundColor: '#000000' });
        let on = false;
        const t = setInterval(() => { on = !on; w.setBackgroundColor(on ? '#ffffff' : '#000000'); }, 1000);
        w.showInactive();
        globalThis.__dumSmokeFlicker = () => { clearInterval(t); w.destroy(); };
        return true;
      })()`);
    } catch (error) {
      limits.push(`screen activity not produced (${error.message}): the look's changed-screen path was not exercised`);
    }
    return `ticks flowing; screen activity ${flicker ? 'on' : 'off'}`;
  });
  await step('saving files in the followed folder reaches the host scan', async () => {
    await writeFile(join(learning, 'walk.py'), `${await readFile(join(learning, 'walk.py'), 'utf8')}\n# iterative next\n`);
    await writeFile(join(learning, 'queue.py'), 'from collections import deque\nqueue = deque()\n');
    const end = Date.now() + 45_000;
    let s;
    while (Date.now() < end) {
      await invoke({ type: 'view', view: 'tree' });
      s = await snapshot();
      if (s.follows[0]?.files === 3) break;
      await delay(1_000);
    }
    assert.equal(s?.follows[0]?.files, 3, `host still lists ${s?.follows[0]?.files} files`);
    return 'queue.py appeared in the host follow list';
  });
  await step('no backend: while the look ticks and the screen and files change, it requests no frame and makes no model call', async () => {
    const start = count ? await count.read() : null;
    await delay(12_000);
    const s = await snapshot();
    const seen = [...statuses];
    assert.equal(s.agent.chosen, null);
    assert.equal(s.look.status, 'no-backend', `look status ${s.look.status}/${s.look.reason}`);
    assert.ok(!seen.some((v) => v.startsWith('checking')), `the look claimed a model call: ${seen.join(' | ')}`);
    assert.equal(s.state.transcript.some((e) => e.kind === 'quip'), false, 'an unprompted Wizard aside appeared');
    assert.equal(s.decision, null, 'an unsolicited decision card appeared');
    assert.equal(existsSync(join(dirs.claude, 'projects')), false, 'no Claude session was written');
    if (!count) return `statuses: ${seen.join(' | ')}`;
    const n = await count.read();
    assert.ok(n.ticks > start.ticks, 'the look ticked');
    if (flicker) assert.ok(n.changed > start.changed, 'no tick saw the screen change');
    else if (n.changed === 0) limits.push('no look tick saw the screen change: the no-backend check ran on unchanged frames only');
    assert.equal(n.frameRequests, 0, `the host asked main for ${n.frameRequests} frames`);
    assert.equal(n.frames, 0, `${n.frames} frames were produced for the host`);
    assert.equal(n.credentialRequests, 0, `the host asked main for ${n.credentialRequests} credentials (a model call)`);
    return `${n.ticks} look ticks (${n.changed} with screen changes), ${n.frameRequests} frame requests, ${n.frames} frames, ${n.credentialRequests} credential requests; statuses: ${seen.join(' | ')}`;
  });
  sampling = false;
  await sampler;
  if (flicker) await count.evaluate('globalThis.__dumSmokeFlicker()');
  await step('Current context shows the look status: no backend, and Pause', async () => {
    await openWindow();
    const s = await snapshot();
    await win.waitForFunction(() => /^no backend/.test(document.querySelector('.context .look-state')?.textContent ?? ''), { timeout: 10_000 });
    const label = await win.$eval('.context .look-state', (el) => el.textContent);
    assert.equal(await win.$eval('.context .section-head button[aria-label="Pause looking"]', (b) => b.innerText.trim()), 'Pause');
    await press(win, '.context .section-head', 'Details');
    const details = await win.$eval('.context .look-details', (el) => el.innerText);
    assert.match(details, /Status\s+no backend/);
    await shoot(win, `${current}-look-status.png`);
    await press(win, '.context .section-head', 'Details');
    return `"${label}" (${s.look.status}/${s.look.reason})`;
  });
}

/** The bubble and the circle together: the send-draft shortcut with no backend speaks in the bubble. */
async function bubble() {
  const { win, bubble: page } = active;
  if (!linux) {
    unexercised('bubble shows at the cursor, beside the circle, and is click-through', 'needs XTest (xdotool)');
    return;
  }
  const send = xkeys((await snapshot()).settings.sendDraftHotkey);
  let bubbleWindow;
  let window;
  await step(`the Send-draft shortcut (${send}) with no backend shows the cursor bubble; the circle stays, focus stays, nothing is sent`, async () => {
    window = await xshown(X_WINDOW);
    assert.ok(window, 'the working window is on screen');
    await xdo('windowfocus', '--sync', window.id);
    // The bubble opens below-right of the cursor; with the cursor in the window's upper left it lands on the window.
    await xdo('mousemove', String(window.x + 30), String(window.y + 150));
    await xdo('key', '--clearmodifiers', send);
    bubbleWindow = await xshown(X_BUBBLE);
    assert.ok(bubbleWindow, 'the bubble X window was not mapped');
    await page.waitForSelector('.bubble:not([hidden]) .bubble-text', { timeout: 10_000 });
    const text = await page.$eval('.bubble', (el) => el.innerText);
    assert.ok(text.trim(), 'the bubble has text');
    assert.doesNotMatch(text, /command bar/i);
    assert.ok(await xshown(X_CIRCLE, 0), 'the circle went away while the bubble showed');
    assert.equal(await xfocus(), window.id, 'X keyboard focus stayed on the working window');
    assert.equal(await page.evaluate(() => document.hasFocus()), false, 'the bubble page never has focus');
    const now = await snapshot();
    assert.equal(now.state.transcript.some((e) => e.kind === 'user'), false, 'nothing was sent');
    assert.equal(now.draft.text, DRAFT, 'the draft stays');
    // The page capture is the evidence: Xvfb has no compositing manager, so the transparent window is mapped
    // and takes no clicks, but its pixels don't appear in an X screen grab.
    await shoot(page, `${current}-bubble.png`, { omitBackground: true });
    if (!limits.some((l) => l.startsWith('Xvfb has no compositing'))) limits.push('Xvfb has no compositing manager: the transparent bubble window is mapped and click-through, but its pixels are shown from its page capture, not an X screen grab');
    return `"${text.trim().replace(/\s+/g, ' ')}", ${bubbleWindow.w}×${bubbleWindow.h} at ${bubbleWindow.x},${bubbleWindow.y}`;
  });
  if (!bubbleWindow) return;
  await step('the bubble is click-through: a real click on it lands on the working window underneath', async () => {
    const install = () => {
      window.__smokeClicks = [];
      const swallow = (e) => { window.__smokeClicks.push({ type: e.type, x: e.screenX, y: e.screenY }); e.preventDefault(); e.stopImmediatePropagation(); };
      for (const type of ['mousedown', 'mouseup', 'click']) window.addEventListener(type, swallow, { capture: true });
    };
    await win.evaluate(install);
    await page.evaluate(install);
    const b = bubbleWindow;
    const p = window;
    const x = Math.max(b.x, p.x) + 12;
    const y = Math.max(b.y, p.y) + 12;
    assert.ok(x < b.x + b.w && x < p.x + p.w && y < b.y + b.h && y < p.y + p.h, 'bubble and window overlap');
    await xdo('mousemove', String(x), String(y));
    await xdo('click', '1');
    await delay(500);
    const onWindow = await win.evaluate(() => window.__smokeClicks);
    const onBubble = await page.evaluate(() => window.__smokeClicks);
    assert.equal(onBubble.length, 0, `the bubble caught ${JSON.stringify(onBubble)}`);
    assert.ok(onWindow.some((c) => c.type === 'mousedown'), `the window saw ${JSON.stringify(onWindow)}`);
    assert.ok(await xshown(X_BUBBLE, 0), 'the bubble was still on screen during the click');
    await win.evaluate(() => { window.__smokeClicks = null; });
    return `click at ${x},${y} reached the window`;
  });
  await step('the bubble expires on its own', async () => {
    await page.waitForSelector('.bubble[hidden]', { timeout: 15_000 });
    assert.ok(await xgone(X_BUBBLE), 'the bubble X window stayed mapped');
  });
  await step('with the cursor beside the circle, the bubble steps off the circle', async () => {
    const circle = await xshown(X_CIRCLE, 0);
    assert.ok(circle, 'no circle');
    await xdo('windowfocus', '--sync', window.id);
    // Below-right of a cursor just up-left of the circle would cover it.
    await xdo('mousemove', String(circle.x - 10), String(circle.y - 10));
    await xdo('key', '--clearmodifiers', send);
    const shown = await xshown(X_BUBBLE);
    assert.ok(shown, 'the bubble X window was not mapped');
    assert.ok(!overlap(shown, circle), `bubble ${JSON.stringify(shown)} covers circle ${JSON.stringify(circle)}`);
    assert.ok(await xshown(X_CIRCLE, 0), 'the circle went away');
    await page.waitForSelector('.bubble[hidden]', { timeout: 15_000 });
    return `bubble at ${shown.x},${shown.y}; circle at ${circle.x},${circle.y}`;
  });
}

// -- the runs ----------------------------------------------------------------------------------

let version = '';
let diagnostic = '';
try {
  if (linux) bus = await privateBus();
  current = packaged ? 'packaged' : 'checkout';
  const dirs = await install(current);
  active = await launch(dirs, repo);
  version = (await snapshot()).version;
  await step('no Git: a non-Git fixture and an app PATH without git', async () => {
    assert.equal(existsSync(join(bin, 'git')), false);
    assert.equal(existsSync(join(fixture, '.git')) || existsSync(join(learning, '.git')), false);
    const s = await snapshot();
    assert.ok(!JSON.stringify(s.agent.backends).toLowerCase().includes('git '), 'no backend status mentions Git');
    return `PATH=${bin} (empty)`;
  });
  await surfaces();
  await firstRun(dirs);
  await otherZone();
  await noTray();
  await circleGestures(dirs);
  await keyboard();
  await decisions(dirs);
  await settings();
  await debugChat();
  await lookAndFollow(dirs);
  await bubble();
  const before = await snapshot();
  await step('Quit Dum exits cleanly with code 0', () => stop());

  current = `${current}-relaunch`;
  active = await launch(dirs, repo);
  await step('relaunch restores the zone, follows and settings, with a fresh epoch and still no backend', async () => {
    const s = await until((v) => v.activeZone, 'restored zone');
    assert.equal(s.activeZone.id, before.activeZone.id);
    assert.deepEqual(s.activeZone.breadcrumb.map((b) => b.name), before.activeZone.breadcrumb.map((b) => b.name));
    assert.equal(s.zones.zones.length, before.zones.zones.length);
    assert.notEqual(s.zoneEpoch, before.zoneEpoch);
    assert.notEqual(s.binding.inputToken, before.binding.inputToken);
    assert.equal(s.settings.agent, null);
    assert.equal(s.settings.look.screen, true);
    assert.equal(s.follows.length, before.follows.length);
    assert.equal(s.shares.length, 0);
    assert.equal(s.direction?.zoneId, s.activeZone.id);
    assert.equal(s.direction?.current, null, 'a direction appeared without you');
  });
  if (linux) {
    await step('relaunch: one circle, back where it was dragged; the window stays closed (not a first run)', async () => {
      const circle = await xshown(X_CIRCLE, 10_000);
      assert.ok(circle, 'no circle after relaunch');
      assert.equal((await xviewable('^Dum$')).filter(X_CIRCLE.test).length, 1);
      assert.ok(circleAfterDrag, 'the drag step did not run');
      assert.ok(near(circle.x, circleAfterDrag.x) && near(circle.y, circleAfterDrag.y), `circle at ${circle.x},${circle.y}; it was dragged to ${circleAfterDrag.x},${circleAfterDrag.y}`);
      assert.ok(await xstaysGone(X_WINDOW, 3_000), 'the working window opened by itself');
      assert.deepEqual(await bus.dump(), [], 'a tray item registered');
      return `circle at ${circle.x},${circle.y}`;
    });
  }
  await step('relaunch: the window opens at the restored zone', async () => {
    await openWindow();
    await active.win.waitForFunction(() => document.querySelector('.first-run')?.hidden === true);
    await shoot(active.win, `${current}-window.png`);
  });
  await step('Quit Dum exits cleanly with code 0', () => stop());
} catch (error) {
  record('run', false, error?.stack ?? error);
} finally {
  if (active) {
    diagnostic = active.diagnostic().slice(-4000);
    active.child.kill();
    // A run that failed mid-way still has to report: an app that ignores SIGTERM is killed.
    const exited = await Promise.race([active.exit.then(() => true), delay(15_000).then(() => false)]);
    if (!exited) {
      limits.push('the desktop ignored SIGTERM at the end of the run and was killed');
      active.child.kill('SIGKILL');
      await active.exit;
    }
    active.browser.disconnect();
    active = null;
  }
  for (const s of services) s.kill();
  if (!linux) limits.push('XTest, the private D-Bus StatusNotifier watcher and native-dialog automation are Linux-only; those checks are marked not exercised');
  limits.push('The decision and handoff steps ran the no-backend path only: no scripted or real model composed alignment options, decision cards or a handoff, and no Do this ran.');
  limits.push('This run does not establish macOS Screen Recording, the round hit region\'s timing on macOS, Spaces or full-screen apps, VoiceOver, focus return to another app, push-to-talk voice or login items.');
  const failed = checks.filter((c) => c.ok === false);
  await writeFile(join(output, 'report.json'), `${JSON.stringify({
    platform: process.platform,
    architecture: process.arch,
    appVersion: version,
    passed: failed.length === 0,
    checks,
    screenshots,
    limits,
    ...(diagnostic ? { diagnostic } : {}),
  }, null, 2)}\n`);
  await rm(fixture, { recursive: true, force: true });
  console.log(failed.length
    ? `Desktop smoke FAILED (${failed.length} of ${checks.length}): ${failed.map((c) => `[${c.run}] ${c.name}`).join('; ')}`
    : `Desktop smoke passed on ${process.platform}-${process.arch}: ${checks.length} checks. Output in ${output}.`);
  process.exitCode = failed.length ? 1 : 0;
}
