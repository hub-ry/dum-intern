// Drives the real built Electron app through the revamp journey (docs/revamp-design.md §9) with a
// private profile, H, HOME and Claude config, a non-Git fixture and no Git on PATH. No model, account
// or network sign-in. On Linux it runs under Xvfb: xdotool presses the real global shortcuts, types into
// the focused window and answers the native folder picker; a private D-Bus session with a minimal
// StatusNotifierWatcher receives the tray icon. Screenshots and report.json go to DUM_SMOKE_OUTPUT.
//
// Development run (default): the checkout's `dist/` as built. DUM_SMOKE_EXECUTABLE runs a packaged
// binary instead.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
      missing.push('python3 with PyGObject (gi), for the tray watcher');
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
 * Dum's own X windows that are really mapped and viewable, by title: "Dum" is the panel and the bubble,
 * "Dum - command bar" the command bar. Electron's windows carry no _NET_WM_PID, so geometry tells them apart.
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
const X_PANEL = { title: '^Dum$', test: (w) => w.h >= 480 };
const X_BUBBLE = { title: '^Dum$', test: (w) => w.w <= 360 && w.h <= 220 };
const X_COMMAND = { title: '^Dum - command bar$', test: () => true };
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
/** The X window that has keyboard focus. */
async function xfocus() {
  return xdo('getwindowfocus', '-f').catch(() => '');
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

// The tray needs a host. This watcher owns org.kde.StatusNotifierWatcher on the private bus, records
// each item Electron registers and, on "dump", reads its properties and dbusmenu labels back.
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
def labels(node, out):
    _id, props, kids = node
    if "label" in props:
        out.append(props["label"])
    for kid in kids:
        labels(kid, out)
    return out
def dump():
    found = []
    for service, obj in items:
        entry = {"service": service, "path": obj}
        try:
            props = bus.call_sync(service, obj, "org.freedesktop.DBus.Properties", "GetAll", GLib.Variant("(s)", ("org.kde.StatusNotifierItem",)), None, 0, 5000, None).unpack()[0]
            entry["id"] = props.get("Id")
            entry["title"] = props.get("Title")
            entry["status"] = props.get("Status")
            tip = props.get("ToolTip")
            entry["tooltip"] = [tip[2], tip[3]] if tip else None
            pixmaps = props.get("IconPixmap") or []
            entry["iconSizes"] = [[p[0], p[1]] for p in pixmaps]
            entry["iconName"] = props.get("IconName")
            menu = props.get("Menu")
            if menu:
                layout = bus.call_sync(service, menu, "com.canonical.dbusmenu", "GetLayout", GLib.Variant("(iias)", (0, -1, [])), None, 0, 5000, None).unpack()
                entry["menu"] = labels(layout[1], [])
        except Exception as error:
            entry["error"] = str(error)
        found.append(entry)
    say({"event": "dump", "items": found})
def stdin(channel, condition):
    line = sys.stdin.readline()
    if not line:
        loop.quit()
        return False
    if line.strip() == "dump":
        dump()
    if line.strip() == "activate":
        done = 0
        for service, obj in items:
            try:
                bus.call_sync(service, obj, "org.kde.StatusNotifierItem", "Activate", GLib.Variant("(ii)", (0, 0)), None, 0, 5000, None)
                done += 1
            except Exception:
                pass  # an item from an app instance that has quit
        say({"event": "activated", "items": done})
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
  await events.next((l) => l.includes('"ready"'), 'tray watcher');
  return {
    address,
    events,
    async dump() {
      const from = events.seen.length;
      watcher.stdin.write('dump\n');
      return JSON.parse(await events.next((l) => l.includes('"dump"'), 'tray dump', { from, timeout: 30_000 })).items;
    },
    /** A left click on the tray icon, as a StatusNotifier host delivers it. */
    async activate() {
      const from = events.seen.length;
      watcher.stdin.write('activate\n');
      return JSON.parse(await events.next((l) => l.includes('"activated"'), 'tray activate', { from })).items;
    },
  };
}

// -- the main process, seen through Node's inspector ---------------------------------------

/**
 * Counts calls in main's compiled code with conditional breakpoints that never pause: in observer.js,
 * Observer.frame (a frame for the host) and the tick send, with how many ticks saw the screen change; in
 * host-client.js, the host's frame requests and credential requests (every Claude or ChatGPT model call
 * starts with one). Only the inspector the Electron binary already offers is used; the app has no test
 * hook. `evaluate` runs an expression in main, for the harness's own screen activity. Null when this
 * binary doesn't allow --inspect (a fused package).
 */
async function counters(endpoint, desktopDir) {
  if (!endpoint) return null;
  const observer = (await readFile(join(desktopDir, 'observer.js'), 'utf8')).split('\n');
  const client = (await readFile(join(desktopDir, 'host-client.js'), 'utf8')).split('\n');
  const frameAt = observer.findIndex((l) => /^\s*async frame\(checkId\)\s*\{/.test(l));
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
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  return {
    read: async () => JSON.parse(await evaluate(`JSON.stringify(globalThis.__dumSmoke ?? ${zero})`)),
    evaluate,
    close: () => socket.close(),
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
    const [panel, command, bubble] = await Promise.all([page('panel'), page('command'), page('bubble')]);
    await panel.waitForFunction(() => typeof window.dum?.invoke === 'function');
    const appDist = packaged ? null : join(appDir, 'dist/desktop');
    let count = null;
    if (appDist && inspector) {
      try {
        count = await counters(inspector, appDist);
      } catch (error) {
        limits.push(`main inspector unavailable: ${error.message}`);
      }
    }
    return { child, browser, panel, command, bubble, count, exit: exit.promise, diagnostic: () => diagnostic };
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
  return active.panel.evaluate((r) => window.dum.invoke(r), request);
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
  throw new Error(`${label} did not arrive (zones ${last?.zones.zones.length}, active ${last?.activeZone?.breadcrumb.map((b) => b.name).join(' › ') ?? 'none'}, look "${last?.look.status}")`);
}
async function visible(page, label, want = true, timeout = 10_000) {
  await page.waitForFunction((v) => (document.visibilityState === 'visible') === v, { timeout }, want).catch(() => {
    throw new Error(`${label} ${want ? 'never became visible' : 'stayed visible'}`);
  });
}
async function focused(page, label, timeout = 10_000) {
  await page.waitForFunction(() => document.hasFocus(), { timeout }).catch(() => { throw new Error(`${label} never got keyboard focus`); });
}
async function stop() {
  if (!active) return;
  const instance = active;
  active = null;
  instance.count?.close();
  await instance.panel.evaluate(() => window.dum.invoke({ type: 'quit' })).catch(() => {});
  const abort = new AbortController();
  try {
    const result = await Promise.race([instance.exit, delay(15_000, undefined, { signal: abort.signal }).then(() => { instance.child.kill(); throw new Error('desktop did not quit cleanly'); })]);
    assert.equal(result.code, 0, `desktop exit: ${result.code ?? result.signal}`);
  } finally {
    abort.abort();
    instance.browser.disconnect();
  }
}

// -- journey pieces -----------------------------------------------------------------------

const GOAL = 'I want to get comfortable with recursion and data structures in Python';
const CHILD = { name: 'Data Structures', goal: 'Binary trees and their traversals', language: 'python' };
const DRAFT = 'how do I walk a tree without recursion';
const LOOK_BLOCKED = 'paused while dum is busy or waiting on you';
const LOOK_CALLS = ['taking a look', "the last look didn't work - it tries again on the next change"];

async function firstRun(dirs) {
  const { panel } = active;
  await step('fresh profile: no zones, no backend chosen, screen look on by default', async () => {
    const s = await snapshot();
    assert.equal(s.zones.zones.length, 0);
    assert.equal(s.zones.activeZoneId, null);
    assert.equal(s.settings.agent, null);
    assert.equal(s.agent.chosen, null);
    assert.deepEqual(s.settings.look, { apps: true, screen: true });
    assert.deepEqual(s.agent.backends.find((b) => b.id === 'claude')?.methods, ['anthropic-key'], 'Claude takes only an Anthropic API key');
    return `backends ${s.agent.backends.map((b) => `${b.id}[${b.methods.join('|')}]`).join(', ')}`;
  }, { critical: true });
  if (linux) {
    // Electron reports a show:false window as "visible" to its page, so the X server is the witness.
    const shown = await step('first launch puts the panel on screen by itself (X window mapped)', async () => {
      const hit = await xshown(X_PANEL, 10_000);
      assert.ok(hit, 'the panel X window was never mapped within 10 s of a fresh launch; nothing is on screen until the tray icon is clicked');
      return `${hit.w}x${hit.h} at ${hit.x},${hit.y}`;
    });
    if (!shown) {
      await step('clicking the tray icon opens the panel', async () => {
        assert.equal(await bus.activate(), 1, 'one tray item to click');
        const hit = await xshown(X_PANEL, 10_000);
        assert.ok(hit, 'the panel X window was not mapped after the tray click');
        await xscreen(`${current}-screen-first-run.png`);
      }, { critical: true });
    }
  }
  await step('the panel asks what you are trying to learn, focused for typing', async () => {
    await visible(panel, 'panel');
    await panel.waitForSelector('.first-run:not([hidden]) h1');
    assert.equal(await panel.$eval('.first-run h1', (el) => el.textContent), 'What are you trying to learn?');
    await panel.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'What are you trying to learn?', { timeout: 10_000 });
    if (linux) {
      const window = await xshown(X_PANEL);
      assert.equal(await xfocus(), window?.id, 'the panel has X keyboard focus');
    }
    await shoot(panel, `${current}-first-run.png`);
  }, { critical: true });
  await step('typing the goal and Return creates and enters the root zone, without a model', async () => {
    await panel.keyboard.type(GOAL);
    await panel.keyboard.press('Enter');
    const s = await until((v) => v.activeZone && v.zones.zones.length === 1, 'root zone');
    assert.equal(s.activeZone.goal, GOAL);
    assert.equal(s.activeZone.breadcrumb.length, 1);
    assert.equal(s.settings.agent, null);
    const stored = JSON.parse(await readFile(join(dirs.h, 'zones.json'), 'utf8'));
    assert.equal(stored.activeZoneId, s.activeZone.id);
    assert.equal(stored.zones[0].goal, GOAL);
    await panel.waitForSelector('.first-run[hidden]');
    await shoot(panel, `${current}-root-zone.png`);
    return `zone ${s.activeZone.breadcrumb[0].name}`;
  }, { critical: true });
}

async function zones() {
  const { panel } = active;
  let root;
  let child;
  await step('keyboard: tab list arrows to Zones and opens it', async () => {
    await panel.focus('#tab-chat');
    await panel.keyboard.press('ArrowRight');
    assert.equal(await panel.evaluate(() => document.activeElement?.id), 'tab-zones');
    await panel.keyboard.press('Enter');
    await panel.waitForFunction(() => document.querySelector('#pane-title')?.textContent === 'Zones' && !document.querySelector('#pane').hidden);
  }, { critical: true });
  await step('keyboard: a nested zone is created inside the root from the Zones tree', async () => {
    root = (await snapshot()).activeZone;
    await panel.keyboard.press('Tab'); // New zone
    await panel.keyboard.press('Tab'); // the tree item
    assert.equal(await panel.evaluate(() => document.activeElement?.getAttribute('role')), 'treeitem');
    await panel.keyboard.press('Tab'); // New zone inside (Enter is disabled on the current zone)
    assert.match(await panel.evaluate(() => document.activeElement?.textContent ?? ''), /New zone inside/);
    await panel.keyboard.press('Enter');
    await panel.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Name');
    await panel.keyboard.type(CHILD.name);
    await panel.keyboard.press('Tab');
    await panel.keyboard.type(CHILD.goal);
    await panel.keyboard.press('Tab');
    await panel.keyboard.type(CHILD.language);
    await panel.keyboard.press('Enter');
    const s = await until((v) => v.zones.zones.length === 2 && v.activeZone?.breadcrumb.length === 2, 'nested zone entered');
    child = s.activeZone;
    assert.deepEqual(child.breadcrumb.map((b) => b.name), [root.breadcrumb[0].name, CHILD.name]);
    assert.equal(child.goal, CHILD.goal);
    assert.equal(child.language, CHILD.language);
    assert.deepEqual(child.ancestorGoals.map((g) => g.goal), [GOAL]);
    await panel.waitForFunction((name) => document.querySelector('.crumb-text')?.textContent?.endsWith(name), {}, CHILD.name);
    return `breadcrumb ${child.breadcrumb.map((b) => b.name).join(' › ')}`;
  }, { critical: true });
  await step('keyboard: arrows move, Left/Right collapse and expand, Enter enters zones', async () => {
    const selected = () => panel.evaluate(() => document.activeElement?.closest('[role=treeitem]')?.querySelector('.zone-name')?.textContent);
    await panel.waitForSelector('[role=treeitem][tabindex="0"]');
    await panel.focus('[role=treeitem][tabindex="0"]');
    const start = await selected();
    if (start !== root.breadcrumb[0].name) await panel.keyboard.press('ArrowUp');
    assert.equal(await selected(), root.breadcrumb[0].name);
    await panel.keyboard.press('ArrowDown');
    assert.equal(await selected(), CHILD.name);
    assert.equal(await panel.$eval('[role=treeitem][aria-selected=true]', (el) => el.getAttribute('aria-level')), '2');
    await panel.keyboard.press('ArrowLeft'); // to the parent
    assert.equal(await selected(), root.breadcrumb[0].name);
    await panel.keyboard.press('ArrowLeft'); // collapse it
    assert.equal(await panel.$$eval('[role=treeitem]', (els) => els.length), 1);
    assert.equal(await panel.$eval('[role=treeitem]', (el) => el.getAttribute('aria-expanded')), 'false');
    await panel.keyboard.press('ArrowRight'); // expand
    assert.equal(await panel.$$eval('[role=treeitem]', (els) => els.length), 2);
    await panel.keyboard.press('Enter');
    await until((v) => v.activeZone?.id === root.id, 'root entered with Enter');
    await panel.focus('[role=treeitem][tabindex="0"]');
    await panel.keyboard.press('ArrowDown');
    await panel.keyboard.press('Enter');
    await until((v) => v.activeZone?.id === child.id, 'child entered with Enter');
  });
  await step('keyboard: F2 renames the nested zone without changing its id', async () => {
    await panel.focus('[role=treeitem][tabindex="0"]');
    if ((await panel.evaluate(() => document.activeElement?.querySelector('.zone-name')?.textContent)) !== CHILD.name) await panel.keyboard.press('ArrowDown');
    await panel.keyboard.press('F2');
    await panel.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Name');
    // No select-all chord: Ctrl+A selects all only off macOS (on macOS it moves to the line start).
    // Like a Finder rename, F2 must already have selected the whole name, so typing replaces it.
    const field = await panel.evaluate(() => ({ value: document.activeElement.value, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }));
    assert.deepEqual(field, { value: CHILD.name, start: 0, end: CHILD.name.length }, 'F2 selects the whole name');
    await panel.keyboard.type('Trees');
    await panel.keyboard.press('Enter');
    const s = await until((v) => v.activeZone?.breadcrumb.at(-1)?.name === 'Trees', 'renamed zone');
    assert.equal(s.activeZone.id, child.id);
    assert.equal(s.zones.zones.length, 2);
    CHILD.name = 'Trees';
    await shoot(panel, `${current}-zones-nested.png`);
  });
}

/** An Electron accelerator as xdotool key names: CommandOrControl+Shift+D → ctrl+shift+d. */
function xkeys(accelerator) {
  const names = { CommandOrControl: 'ctrl', CmdOrCtrl: 'ctrl', Control: 'ctrl', Ctrl: 'ctrl', Shift: 'shift', Alt: 'alt', Option: 'alt', Super: 'super', Return: 'Return', Enter: 'Return', Space: 'space' };
  return accelerator.split('+').map((part) => names[part] ?? part.toLowerCase()).join('+');
}

/** The real global shortcut, typed through X; Esc gives focus back to the panel. */
async function commandBar() {
  const { panel, command } = active;
  if (!linux) {
    unexercised('hotkey → command bar → typing → Esc', 'needs XTest (xdotool) on an X display');
    return;
  }
  const keys = xkeys((await snapshot()).settings.hotkey);
  await step(`hotkey (${keys}) opens the focused command bar; typing goes into it`, async () => {
    const panelWindow = await xshown(X_PANEL);
    assert.ok(panelWindow, 'the panel is on screen before the hotkey');
    await panel.evaluate(() => document.querySelector('#tab-chat')?.click());
    await xdo('windowfocus', '--sync', panelWindow.id);
    await xdo('key', '--clearmodifiers', keys);
    const window = await xshown(X_COMMAND);
    assert.ok(window, 'the command bar X window was not mapped');
    await visible(command, 'command bar');
    await focused(command, 'command bar');
    assert.equal(await xfocus(), window.id, 'the command bar has X keyboard focus');
    await command.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message to Dum');
    await xdo('type', '--delay', '20', DRAFT);
    await command.waitForFunction((t) => document.activeElement?.value === t, { timeout: 10_000 }, DRAFT);
    await shoot(command, `${current}-command-typed.png`);
    await xscreen(`${current}-screen-command.png`);
    return `command bar ${window.w}x${window.h} at ${window.x},${window.y}`;
  });
  await step('Esc hides the command bar, keeps the draft and gives focus back to the panel', async () => {
    await xdo('key', 'Escape');
    assert.ok(await xgone(X_COMMAND), 'the command bar X window stayed mapped');
    const panelWindow = await xshown(X_PANEL);
    const end = Date.now() + 5_000;
    while (Date.now() < end && (await xfocus()) !== panelWindow?.id) await delay(150);
    assert.equal(await xfocus(), panelWindow?.id, 'X keyboard focus went back to the panel');
    await focused(panel, 'panel after Esc');
    const s = await until((v) => v.draft.text === DRAFT, 'draft kept in main');
    assert.equal(s.state.transcript.some((e) => e.kind === 'user'), false, 'nothing was sent');
  });
  await step('the hotkey again reopens the command bar with the same draft; Esc closes it', async () => {
    await xdo('key', '--clearmodifiers', keys);
    assert.ok(await xshown(X_COMMAND), 'the command bar X window was not mapped');
    await command.waitForFunction((t) => document.querySelector('textarea')?.value === t, { timeout: 10_000 }, DRAFT);
    await shoot(command, `${current}-command-reopened.png`);
    await xdo('key', 'Escape');
    assert.ok(await xgone(X_COMMAND), 'the command bar X window stayed mapped');
  });
}

async function whoPowersDum() {
  const { panel } = active;
  await step('"Who powers Dum?" appears at the first model-backed request; nothing is sent', async () => {
    const before = await snapshot();
    // The Zones steps leave the Zones pane open over the conversation; a message is typed there.
    // (On Linux the command bar steps already brought the conversation back.)
    await panel.focus('#tab-chat');
    await panel.keyboard.press('Enter');
    await panel.waitForFunction(() => !document.querySelector('.chat')?.hidden && document.activeElement?.matches('textarea.composer-input'), { timeout: 10_000 });
    if (before.draft.text !== DRAFT) await panel.keyboard.type(DRAFT);
    await panel.waitForFunction((t) => document.querySelector('textarea.composer-input')?.value === t, { timeout: 10_000 }, DRAFT);
    await panel.keyboard.press('Enter');
    await panel.waitForSelector('.agent-setup:not([hidden]) h2', { timeout: 10_000 });
    assert.equal(await panel.$eval('.agent-setup h2', (el) => el.textContent), 'Who powers Dum?');
    assert.match(await panel.$eval('.agent-note', (el) => (el.hidden ? '' : el.textContent)), /Choose who powers Dum first/);
    const s = await snapshot();
    assert.equal(s.agent.chosen, null);
    assert.equal(s.draft.text, DRAFT, 'the message stays in the draft');
    assert.equal(s.state.transcript.some((e) => e.kind === 'user'), false, 'nothing was sent');
    await shoot(panel, `${current}-agent-setup.png`);
    // Local servers sit at fixed 127.0.0.1 ports that no profile setting isolates; say so when one answered.
    const ready = s.agent.backends.filter((b) => b.ready !== null && b.id !== 'claude');
    if (ready.length) limits.push(`[${current}] a local model server on this machine answered (${ready.map((b) => `${b.label}: ${b.message}`).join('; ')}); the sheet listed it and read its model list, nothing was chosen, so no model was called`);
    return `rows: ${s.agent.backends.map((b) => `${b.id} ${b.ready ? 'ready' : 'not set up'}`).join(', ')}`;
  });
  await step('Claude offers only the API-key field', async () => {
    const radio = '.agent-setup input[name="backend-setup"][value="claude"]';
    await panel.waitForSelector(radio, { timeout: 15_000 });
    await panel.focus(radio);
    await panel.keyboard.press('Space');
    await panel.waitForFunction((r) => document.querySelector(r)?.checked, {}, radio);
    const methods = await panel.$$eval('.agent-setup .methods input[type=radio]', (els) => els.map((el) => el.value));
    const text = await panel.$eval('.agent-setup', (el) => el.innerText);
    assert.deepEqual(methods, [], 'one method: no method choice is offered');
    assert.doesNotMatch(text, /Sign in with Claude|subscription/i);
    await panel.waitForSelector('.agent-setup input[aria-label="Anthropic API key"]', { timeout: 10_000 });
    await shoot(panel, `${current}-agent-claude.png`);
    return 'anthropic-key only';
  });
  await step('main refuses the removed Claude subscription login as an unknown method', async () => {
    // The login method Dum removed; the renderer protocol no longer parses it.
    const r = await invoke({ type: 'agent-login', backend: 'claude', method: 'claude-subscription' });
    assert.equal(r.ok, false, 'the removed sign-in was accepted');
    assert.match(r.error, /doesn't accept \(method\)/);
    return r.error;
  });
}

async function lookAndFollow(dirs) {
  const { panel, count } = active;
  await step('Settings › Look: screen look is on; a settings save persists agent: null', async () => {
    await panel.evaluate(() => document.querySelector('#tab-settings')?.click());
    await panel.waitForFunction(() => document.querySelector('#pane-title')?.textContent === 'Settings');
    const boxes = await panel.$$eval('[aria-labelledby=look-title] input[type=checkbox]', (els) => els.map((el) => el.checked));
    assert.deepEqual(boxes, [true, true], 'apps and screen boxes');
    // Turn app look off and on through the visible box; each is a real settings write.
    const apps = '[aria-labelledby=look-title] label.check:nth-of-type(1) input';
    await panel.click(apps);
    await until((v) => v.settings.look.apps === false, 'apps look off');
    await panel.click(apps);
    const s = await until((v) => v.settings.look.apps === true, 'apps look on');
    const stored = JSON.parse(await readFile(join(dirs.profile, 'settings.json'), 'utf8'));
    assert.equal(stored.settings.agent, null);
    assert.deepEqual(stored.settings.look, { apps: true, screen: true });
    assert.equal(s.settings.look.screen, true);
    return `look status "${s.look.status}", screen permission ${s.look.screenPermission}`;
  });
  if (!linux) {
    unexercised('followed folder via the native folder picker', 'needs XTest (xdotool) for the native picker');
    return;
  }
  let follow;
  await step('Follow a folder… opens the native picker; the chosen non-Git folder is followed', async () => {
    assert.equal(existsSync(join(learning, '.git')), false);
    await panel.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Follow a folder'))?.click());
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
    follow = s.follows[0];
    assert.equal(follow.label, 'learning');
    assert.equal(follow.files, 2, 'walk.py and README.md');
    return `${follow.label}: ${follow.files} files`;
  });
  if (!follow) return;
  const statuses = new Set();
  let sampling = true;
  const sampler = (async () => {
    while (sampling && active) {
      try { statuses.add((await snapshot()).look.status); } catch { /* the run is ending */ }
      await delay(250);
    }
  })();
  // The look stops while a Dum window is in front, so it runs here with every Dum window hidden.
  let flicker = false;
  await step('with no Dum window in front, the look ticks', async () => {
    await invoke({ type: 'dismiss-surface', surface: 'panel' });
    assert.ok(await xgone(X_PANEL), 'the panel X window stayed mapped');
    assert.ok(await xgone(X_COMMAND), 'the command bar X window stayed mapped');
    if (!count) {
      limits.push('look ticks, frame requests and credential requests not counted: main inspector unavailable');
      return 'panel hidden';
    }
    const before = (await count.read()).ticks;
    const end = Date.now() + 15_000;
    while (Date.now() < end && (await count.read()).ticks === before) await delay(500);
    assert.ok((await count.read()).ticks > before, 'no look tick arrived with every Dum window hidden');
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
  let after;
  await step('saving a file in the followed folder produces a host FileSignal (new file listed by the host scan)', async () => {
    await writeFile(join(learning, 'walk.py'), `${await readFile(join(learning, 'walk.py'), 'utf8')}\n# iterative next\n`);
    await writeFile(join(learning, 'queue.py'), 'from collections import deque\nqueue = deque()\n');
    // The host lists followed folders every few ticks; asking for the skill tree makes it send fresh state.
    const end = Date.now() + 45_000;
    let s;
    while (Date.now() < end) {
      await invoke({ type: 'panel', panel: 'tree' });
      s = await snapshot();
      if (s.follows[0]?.files === 3) break;
      await delay(1_000);
    }
    assert.equal(s?.follows[0]?.files, 3, `host still lists ${s?.follows[0]?.files} files`);
    after = s;
    return 'queue.py appeared in the host follow list';
  });
  await step('no backend: while the look ticks and the screen changes, it requests no frame and makes no model call', async () => {
    const start = count ? await count.read() : null;
    await delay(12_000);
    const s = await snapshot();
    const seen = [...statuses];
    assert.equal(s.agent.chosen, null);
    assert.ok(!seen.some((v) => LOOK_CALLS.includes(v)), `look statuses showed a model call: ${seen.join(' | ')}`);
    assert.equal(s.state.transcript.some((e) => e.kind === 'quip'), false, 'no Wizard aside');
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
  await step('the look status shows the followed-folder FileSignal and that advice needs a backend', async () => {
    const seen = [...statuses];
    assert.ok(after, 'no FileSignal was observed');
    const noticed = seen.filter((v) => /\b[1-9]\d* changed files? noticed\b/.test(v) && /advice needs a backend/.test(v));
    assert.ok(noticed.length > 0, `look status never told of the saved files: ${seen.map((v) => `"${v}"`).join(', ')}`);
    assert.ok(!seen.includes(LOOK_BLOCKED), 'with no backend and nothing running, the look never claimed to be paused');
    return noticed.at(-1);
  });
  sampling = false;
  await sampler;
  if (flicker) await count.evaluate('globalThis.__dumSmokeFlicker()');
  await invoke({ type: 'show-surface', surface: 'panel' });
  await visible(panel, 'panel');
  await step('Settings › Look shows the look status and the followed folder', async () => {
    await panel.evaluate(() => document.querySelector('#tab-settings')?.click());
    await panel.waitForFunction(() => document.querySelector('#pane-title')?.textContent === 'Settings');
    await panel.waitForFunction(() => /learning/.test(document.querySelector('.follows')?.textContent ?? ''));
    const text = await panel.$eval('[aria-labelledby=look-title]', (el) => el.innerText);
    const status = (await snapshot()).look.status;
    assert.ok(text.includes(status), 'the status line is drawn');
    await panel.evaluate(() => document.querySelector('#look-title')?.scrollIntoView());
    await shoot(panel, `${current}-look-status.png`);
    return `"${status}"`;
  });
  await step('Settings › Web tree: link, sync, new link and unlink are there; Sync now before a link says so', async () => {
    const labels = await panel.$$eval('[aria-labelledby=web-title] button', (bs) => bs.map((b) => b.textContent.trim()));
    for (const label of ['Link', 'Sync now', 'New link', 'Unlink']) assert.ok(labels.includes(label), `no ${label} button: ${labels.join(', ')}`);
    assert.ok(await panel.$('[aria-labelledby=web-title] input[aria-label=Server]'), 'no Server field');
    await panel.focus('[aria-labelledby=web-title] input[aria-label=Server]');
    await panel.keyboard.press('Tab');
    await panel.keyboard.press('Tab');
    assert.equal(await panel.evaluate(() => document.activeElement?.textContent?.trim()), 'Sync now', 'Sync now is reached by Tab');
    await panel.keyboard.press('Enter');
    await panel.waitForFunction(() => /not linked - link a web tree in Settings first/.test(document.querySelector('.errors')?.textContent ?? ''), { timeout: 10_000 });
    await panel.evaluate(() => document.querySelector('#web-title')?.scrollIntoView());
    await shoot(panel, `${current}-web-tree.png`);
    return 'refused: not linked';
  });
}

async function tray() {
  if (!linux) {
    unexercised('tray icon and menu', 'read over a private D-Bus StatusNotifier watcher on Linux only');
    return;
  }
  await step('the tray icon exists, names the zone and offers the menu', async () => {
    const zone = (await snapshot()).activeZone.breadcrumb.map((b) => b.name).join(' › ');
    let items = [];
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      items = (await bus.dump()).filter((i) => !i.error && i.menu?.includes('Quit Dum'));
      if (items.some((i) => JSON.stringify(i.tooltip ?? i.title).includes(zone))) break;
      await delay(500);
    }
    assert.equal(items.length, 1, `registered tray items: ${JSON.stringify(await bus.dump())}`);
    const [item] = items;
    assert.ok(JSON.stringify([item.tooltip, item.title]).includes(`Dum · ${zone}`), `tooltip ${JSON.stringify(item.tooltip)}`);
    for (const label of ['Ask Dum…', 'Open Panel', 'Switch Zone', 'Pause the Look', 'Quit Dum']) assert.ok(item.menu.includes(label), `menu lacks ${label}: ${item.menu.join(', ')}`);
    assert.ok(item.iconSizes.length > 0 || item.iconName, 'the item has an icon');
    return `tooltip ${JSON.stringify(item.tooltip)}; menu ${item.menu.filter(Boolean).join(' / ')}`;
  });
}

/** The send-draft shortcut with no backend: main shows the refusal in the cursor bubble. */
async function bubble() {
  const { panel, bubble: page } = active;
  await step('the bubble page is read-only: no request bridge', async () => {
    const api = await page.evaluate(() => ({ dum: typeof window.dum, bubble: typeof window.dumBubble, invoke: typeof window.dumBubble?.invoke }));
    assert.deepEqual(api, { dum: 'undefined', bubble: 'object', invoke: 'undefined' });
  });
  if (!linux) {
    unexercised('bubble shows at the cursor and is click-through', 'needs XTest (xdotool)');
    return;
  }
  const send = xkeys((await snapshot()).settings.sendDraftHotkey);
  let bubbleWindow;
  let panelWindow;
  await step(`the Send-draft shortcut (${send}) with no backend shows the cursor bubble, keeps focus and sends nothing`, async () => {
    await panel.evaluate(() => document.querySelector('#tab-chat')?.click());
    panelWindow = await xshown(X_PANEL);
    assert.ok(panelWindow, 'the panel is on screen');
    await xdo('windowfocus', '--sync', panelWindow.id);
    // The bubble opens below-right of the cursor; with the cursor in the panel's upper left it lands on the panel.
    await xdo('mousemove', String(panelWindow.x + 30), String(panelWindow.y + 150));
    await xdo('key', '--clearmodifiers', send);
    bubbleWindow = await xshown(X_BUBBLE);
    assert.ok(bubbleWindow, 'the bubble X window was not mapped');
    await page.waitForSelector('.bubble:not([hidden]) .bubble-text', { timeout: 10_000 });
    const text = await page.$eval('.bubble', (el) => el.innerText);
    assert.ok(text.trim(), 'the bubble has text');
    assert.equal(await xfocus(), panelWindow.id, 'X keyboard focus stayed on the panel');
    assert.equal(await page.evaluate(() => document.hasFocus()), false, 'the bubble page never has focus');
    const now = await snapshot();
    assert.equal(now.state.transcript.some((e) => e.kind === 'user'), false, 'nothing was sent');
    // The page capture is the evidence: Xvfb has no compositing manager, so the transparent window is mapped
    // and takes no clicks, but its pixels don't appear in an X screen grab.
    await shoot(page, `${current}-bubble.png`, { omitBackground: true });
    if (!limits.some((l) => l.startsWith('Xvfb has no compositing'))) limits.push('Xvfb has no compositing manager: the transparent bubble window is mapped and click-through, but its pixels are shown from the page capture, not an X screen grab');
    return `"${text.trim().replace(/\s+/g, ' ')}", ${bubbleWindow.w}x${bubbleWindow.h} at ${bubbleWindow.x},${bubbleWindow.y}`;
  });
  if (!bubbleWindow) return;
  await step('the bubble is click-through: a real click on it lands on the panel underneath', async () => {
    const install = () => {
      window.__smokeClicks = [];
      const swallow = (e) => { window.__smokeClicks.push({ type: e.type, x: e.screenX, y: e.screenY }); e.preventDefault(); e.stopImmediatePropagation(); };
      for (const type of ['mousedown', 'mouseup', 'click']) window.addEventListener(type, swallow, { capture: true });
    };
    await panel.evaluate(install);
    await page.evaluate(install);
    const b = bubbleWindow;
    const p = panelWindow;
    const x = Math.max(b.x, p.x) + 12;
    const y = Math.max(b.y, p.y) + 12;
    assert.ok(x < b.x + b.w && x < p.x + p.w && y < b.y + b.h && y < p.y + p.h, 'bubble and panel overlap');
    await xdo('mousemove', String(x), String(y));
    await xdo('click', '1');
    await delay(500);
    const onPanel = await panel.evaluate(() => window.__smokeClicks);
    const onBubble = await page.evaluate(() => window.__smokeClicks);
    assert.equal(onBubble.length, 0, `the bubble caught ${JSON.stringify(onBubble)}`);
    assert.ok(onPanel.some((c) => c.type === 'mousedown'), `the panel saw ${JSON.stringify(onPanel)}`);
    assert.ok(await xshown(X_BUBBLE, 0), 'the bubble was still on screen during the click');
    return `click at ${x},${y} reached the panel`;
  });
  await step('the bubble expires on its own', async () => {
    await page.waitForSelector('.bubble[hidden]', { timeout: 15_000 });
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
  await step('sandboxed renderers: no Node in the panel, command bar or bubble', async () => {
    for (const page of [active.panel, active.command, active.bubble]) {
      assert.deepEqual(await page.evaluate(() => ({ process: typeof process, require: typeof require })), { process: 'undefined', require: 'undefined' });
    }
  });
  await firstRun(dirs);
  await zones();
  await commandBar();
  await whoPowersDum();
  await lookAndFollow(dirs);
  await tray();
  await bubble();
  const before = await snapshot();
  await stop();

  current = `${current}-relaunch`;
  active = await launch(dirs, repo);
  await step('relaunch restores the zone, follows and settings, with a fresh epoch and still no backend', async () => {
    const s = await until((v) => v.activeZone, 'restored zone');
    assert.equal(s.activeZone.id, before.activeZone.id);
    assert.deepEqual(s.activeZone.breadcrumb.map((b) => b.name), before.activeZone.breadcrumb.map((b) => b.name));
    assert.notEqual(s.zoneEpoch, before.zoneEpoch);
    assert.notEqual(s.binding.inputToken, before.binding.inputToken);
    assert.equal(s.settings.agent, null);
    assert.equal(s.settings.look.screen, true);
    assert.equal(s.follows.length, before.follows.length);
    assert.equal(s.shares.length, 0);
    await invoke({ type: 'show-surface', surface: 'panel' });
    await visible(active.panel, 'panel');
    await shoot(active.panel, `${current}-panel.png`);
  });
  await stop();
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
  if (!linux) limits.push('XTest, the private D-Bus tray watcher and native-dialog automation are Linux-only; those checks are marked not exercised');
  limits.push('This run does not establish macOS Screen Recording, full-screen Spaces, focus return to another app, push-to-talk voice or login items.');
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
