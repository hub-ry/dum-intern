// dum's desktop app: a small floating companion, a conversation panel beside it, a tray menu and
// a global hotkey. Main owns every operating-system capability; the sandboxed pages only send the
// finite requests in protocol.ts, which ipc.ts validates and routes.

import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  type IpcMainInvokeEvent,
  type NativeImage,
  type WebPreferences,
} from "electron";
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as context from "../context.ts";
import * as sprite from "../sprite.ts";
import { HostController } from "./host-client.ts";
import { Captures, MAX_PNG_BYTES, type Capturer } from "./capture.ts";
import { companionSize } from "./companion-layout.ts";
import { DictationHelper } from "./dictation.ts";
import { Router, ownedPage, type Controller, type Native } from "./ipc.ts";
import { RuntimeSetup, runtimeExecutable } from "./runtime-setup.ts";
import { DesktopSettings, placeOnScreen, type Rect } from "./settings.ts";
import type { Settings } from "./protocol.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const INDEX = join(here, "ui", "index.html");
const INDEX_URL = pathToFileURL(INDEX).href;
const PRELOAD = join(here, "preload.cjs");
const MAC = process.platform === "darwin";
const PANEL = { width: 380, height: 560 };
/** Apple's own Privacy & Security › Screen Recording pane. */
const SCREEN_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const SCREEN_DENIED = "Screen Recording is off for dum. Turn it on in System Settings › Privacy & Security › Screen Recording, then reopen dum.";
/** Long edge of a capture: enough to read code, small enough to send. */
const CAPTURE_EDGE = 1568;

// A private profile the person or a test chose, such as a clean smoke-test profile. Absolute only.
const profile = process.env.DUM_DESKTOP_DATA;
app.enableSandbox();
if (profile !== undefined && !isAbsolute(profile)) {
  dialog.showErrorBox("dum can't start", "DUM_DESKTOP_DATA must be an absolute directory path.");
  app.exit(2);
} else {
  if (profile !== undefined) app.setPath("userData", profile);
  if (!app.requestSingleInstanceLock()) app.quit();
  else void app.whenReady().then(start);
}

// Pages can't navigate, open windows, embed webviews or be granted device permissions.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

function preferences(): WebPreferences {
  return {
    preload: PRELOAD,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    devTools: !app.isPackaged,
  };
}

/** Dum's idle portrait at two device pixels per art pixel, for the menu bar. */
function trayIcon(dum: sprite.Sprite): NativeImage {
  const frame = sprite.framesFor(dum, "idle")[0]!;
  const unit = 4;
  const cols = Math.max(...frame.rows.map((r) => r.length));
  const width = cols * unit;
  const height = frame.rows.length * unit;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const hex = dum.palette.get(frame.rows[Math.floor(y / unit)]?.[Math.floor(x / unit)] ?? ".");
      if (!hex) continue;
      const at = (y * width + x) * 4;
      pixels[at] = Number.parseInt(hex.slice(4, 6), 16);
      pixels[at + 1] = Number.parseInt(hex.slice(2, 4), 16);
      pixels[at + 2] = Number.parseInt(hex.slice(0, 2), 16);
      pixels[at + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 2 });
}

async function start(): Promise<void> {
  const deny = (_wc: unknown, _permission: string, callback: (granted: boolean) => void) => callback(false);
  session.defaultSession.setPermissionRequestHandler(deny);
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setDevicePermissionHandler(() => false);

  const settings = DesktopSettings.load(app.getPath("userData"));
  const dum = sprite.load(join(here, "..", "art", "intern.txt"));
  const size = companionSize(dum, sprite.load(join(here, "..", "art", "wizard.txt")));
  const workAreas = (): Rect[] => screen.getAllDisplays().map((d) => d.workArea);
  const placeCompanion = (at: { x: number; y: number } | null) => placeOnScreen(at, size, workAreas(), screen.getPrimaryDisplay().workArea);

  const spot = placeCompanion(settings.companion);
  const companion = new BrowserWindow({
    ...size,
    ...spot,
    title: "dum",
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // A non-activating panel on macOS: clicking Dum doesn't pull focus from the IDE.
    ...(MAC ? { type: "panel" } : {}),
    webPreferences: preferences(),
  });
  const panel = new BrowserWindow({
    ...PANEL,
    minWidth: 320,
    minHeight: 420,
    title: "dum",
    show: false,
    fullscreenable: false,
    minimizable: false,
    backgroundColor: "#16141f",
    webPreferences: preferences(),
  });
  const windows = [companion, panel];

  let quitting = false;
  panel.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    panel.hide();
  });
  companion.on("close", (event) => {
    if (!quitting) event.preventDefault();
  });

  const applyWindows = (next: Settings) => {
    for (const w of windows) {
      w.setAlwaysOnTop(next.alwaysOnTop, "floating");
      w.setVisibleOnAllWorkspaces(next.allWorkspaces, { visibleOnFullScreen: next.allWorkspaces });
    }
  };
  applyWindows(settings.settings);

  // Beside the companion, on whichever side has room, fully on its display.
  const besideCompanion = () => {
    const c = companion.getBounds();
    const area = screen.getDisplayMatching(c).workArea;
    const { width, height } = panel.getBounds();
    const left = c.x - width - 12;
    const x = left >= area.x ? left : c.x + c.width + 12;
    return placeOnScreen({ x, y: c.y + c.height - height }, { width, height }, [area], area);
  };
  const showPanel = () => {
    const at = besideCompanion();
    panel.setPosition(at.x, at.y);
    panel.show();
    panel.focus();
  };
  const togglePanel = () => (panel.isVisible() ? panel.hide() : showPanel());

  let saveTimer: NodeJS.Timeout | null = null;
  const moveTo = (target: { x: number; y: number }) => {
    const at = placeCompanion(target);
    companion.setPosition(at.x, at.y);
    if (panel.isVisible()) {
      const p = besideCompanion();
      panel.setPosition(p.x, p.y);
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        settings.move(at);
      } catch {
        // Position is a convenience; a read-only profile keeps working with the default spot.
      }
    }, 400);
  };
  const keepOnScreen = () => moveTo(companion.getBounds());
  screen.on("display-removed", keepOnScreen);
  screen.on("display-metrics-changed", keepOnScreen);

  let tray: Tray | null = null;
  const refreshTray = () => {
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: companion.isVisible() ? "Hide dum" : "Show dum", click: () => { if (companion.isVisible()) { companion.hide(); panel.hide(); } else companion.showInactive(); refreshTray(); } },
      { label: "Conversation", click: () => { if (!companion.isVisible()) companion.showInactive(); togglePanel(); refreshTray(); } },
      { type: "separator" },
      { label: "Quit dum", click: () => app.quit() },
    ]));
  };

  // The hotkey summons: a hidden dum comes back with the panel; an open panel goes away.
  const summon = () => {
    if (panel.isVisible() && panel.isFocused()) panel.hide();
    else {
      if (!companion.isVisible()) companion.showInactive();
      showPanel();
    }
    refreshTray();
  };
  let hotkey = "";
  let hotkeyError = "";
  const register = (accelerator: string): boolean => {
    try {
      return globalShortcut.register(accelerator, summon);
    } catch {
      return false;
    }
  };
  if (register(settings.settings.hotkey)) hotkey = settings.settings.hotkey;
  else hotkeyError = `${settings.settings.hotkey} is already used by another app or the system. Choose another shortcut in Settings.`;

  const capturer: Capturer = {
    async list() {
      const status = MAC ? systemPreferences.getMediaAccessStatus("screen") : "granted";
      if (status === "denied" || status === "restricted") throw new Error(SCREEN_DENIED);
      const own = new Set(windows.map((w) => w.getMediaSourceId()));
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      return sources
        .filter((s) => !own.has(s.id))
        .map((s) => {
          const kind = s.id.startsWith("screen:") ? ("screen" as const) : ("window" as const);
          return { id: s.id, name: s.name.slice(0, 200) || (kind === "screen" ? "Screen" : "Window"), kind };
        });
    },
    async grab(source) {
      // A whole screen shouldn't include dum itself; hide both windows for the one frame.
      const shown = source.kind === "screen" ? windows.filter((w) => w.isVisible()) : [];
      for (const w of shown) w.hide();
      try {
        if (shown.length) await new Promise((resolve) => setTimeout(resolve, 250));
        const sources = await desktopCapturer.getSources({ types: [source.kind], thumbnailSize: { width: CAPTURE_EDGE, height: CAPTURE_EDGE }, fetchWindowIcons: false });
        const hit = sources.find((s) => s.id === source.id);
        if (!hit) return null;
        if (hit.thumbnail.isEmpty()) {
          throw new Error(MAC && systemPreferences.getMediaAccessStatus("screen") !== "granted" ? SCREEN_DENIED : "The system returned an empty image for that source - nothing was captured.");
        }
        let image = hit.thumbnail;
        let png = image.toPNG();
        for (let shrink = 0; png.length > MAX_PNG_BYTES && shrink < 3; shrink++) {
          image = image.resize({ width: Math.round(image.getSize().width * 0.7), quality: "best" });
          png = image.toPNG();
        }
        return png;
      } finally {
        for (const w of shown) {
          if (w === panel) {
            panel.show();
            panel.focus();
          } else w.showInactive();
        }
      }
    },
  };

  let executable: { path: string } | { error: string };
  try {
    executable = { path: runtimeExecutable() };
  } catch (err) {
    executable = { error: (err as Error).message };
  }
  // Allow wizard.screenDecision() calls from main by exposing the bundled claude executable
  if ('path' in executable) process.env.DUM_CLAUDE_BIN = executable.path;

  let pending = false;
  let router: Router | null = null;
  const broadcast = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      if (!router) return;
      const snapshot = router.snapshot();
      for (const w of windows) if (!w.isDestroyed()) w.webContents.send("dum:snapshot", snapshot);
    });
  };
  const changed = () => {
    router?.changed();
    broadcast();
  };

  // Without the bundled runtime there is nothing to run projects with, and no PATH lookup instead.
  const missing = "error" in executable ? executable.error : "";
  const refuse = (): never => {
    throw new Error(`${missing}. Download a complete build of dum.`);
  };
  const controller: Controller = "path" in executable
    ? new HostController(changed, { executable: executable.path, capturer })
    : {
        state: null, inputToken: "", canAttach: false, tree: null, wizardStatus: "wizard is unavailable without the bundled runtime",
        setWizardAdvice: async () => {},
        choose: async () => refuse(), send: async () => refuse(),
        command: refuse, panel: refuse, interrupt: refuse,
        close: async () => {},
      };
  const runtime = new RuntimeSetup(executable, broadcast);
  const captures = new Captures(capturer);
  const dictation = new DictationHelper({
    platform: process.platform,
    arch: process.arch,
    systemVersion: process.getSystemVersion(),
    resourcesPath: () => process.resourcesPath,
    spawnOpen: (path) => new Promise<void>((resolve, reject) => {
      execFile("/usr/bin/open", [path], { timeout: 10_000 }, (error) => error ? reject(error) : resolve());
    }),
  });

  const native: Native = {
    async chooseDirectory() {
      const options = { title: "Choose a project folder", buttonLabel: "Open project", properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
      const picked = panel.isVisible() ? await dialog.showOpenDialog(panel, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? null : picked.filePaths[0] ?? null;
    },
    async openPath(path) {
      const failed = await shell.openPath(path);
      if (failed) throw new Error(`Couldn't open it: ${failed}`);
    },
    openExternal: (url) => shell.openExternal(url),
    async openScreenSettings() {
      if (!MAC) throw new Error("Screen sharing permission is managed by your desktop on this system.");
      await shell.openExternal(SCREEN_SETTINGS);
    },
    screenPermission: () => (MAC ? systemPreferences.getMediaAccessStatus("screen") : "not-required"),
    applySettings(next, previous) {
      if (next.launchAtLogin !== previous.launchAtLogin && !MAC && process.platform !== "win32") {
        throw new Error("Open at login isn't available on this system.");
      }
      if (next.hotkey !== hotkey) {
        if (hotkey) globalShortcut.unregister(hotkey);
        if (!register(next.hotkey)) {
          if (hotkey) register(hotkey);
          throw new Error(`${next.hotkey} is already used by another app or the system - choose a different shortcut`);
        }
        hotkey = next.hotkey;
        hotkeyError = "";
      }
      applyWindows(next);
      if (next.launchAtLogin !== previous.launchAtLogin) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    },
    hotkeyError: () => hotkeyError,
    togglePanel: () => { togglePanel(); refreshTray(); },
    hidePanel: () => { panel.hide(); refreshTray(); },
    moveCompanion(dx, dy) {
      const b = companion.getBounds();
      moveTo({ x: b.x + dx, y: b.y + dy });
    },
    quit: () => setImmediate(() => app.quit()),
  };

  router = new Router({
    controller,
    captures,
    settings,
    runtime,
    native,
    dictation,
    personal: (enabled) => context.read(enabled ? undefined : "off"),
    platform: process.platform,
    version: app.getVersion(),
  });

  // Requests are honored only from the top frame of dum's own two windows, showing dum's own page.
  const owners = new Set(windows.map((w) => w.webContents.id));
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame;
    const top = event.sender.mainFrame;
    return !!frame && owners.has(event.sender.id) && frame.processId === top.processId && frame.routingId === top.routingId && ownedPage(frame.url, INDEX_URL);
  };
  ipcMain.handle("dum:request", (event, raw: unknown) => (trusted(event) ? router!.handle(raw) : { ok: false, error: "request refused" }));

  Menu.setApplicationMenu(MAC ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);
  tray = new Tray(trayIcon(dum));
  tray.setToolTip("dum");
  if (!MAC) tray.on("click", () => { togglePanel(); refreshTray(); });
  refreshTray();

  companion.once("ready-to-show", () => companion.showInactive());
  await Promise.all([
    companion.loadFile(INDEX, { query: { view: "companion" } }),
    panel.loadFile(INDEX, { query: { view: "panel" } }),
  ]);
  if (settings.warning) void dialog.showMessageBox({ type: "warning", message: "dum's settings were reset", detail: settings.warning });
  void runtime.check();
  broadcast();

  app.on("second-instance", summon);
  app.on("activate", summon);

  let closing: Promise<void> | null = null;
  app.on("before-quit", (event) => {
    if (closing === null) {
      quitting = true;
      event.preventDefault();
      captures.discard();
      runtime.cancel();
      globalShortcut.unregisterAll();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 7_000).unref());
      closing = Promise.race([controller.close().catch(() => {}), timeout]).then(() => app.quit());
    }
  });
}
