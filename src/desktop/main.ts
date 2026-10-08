// Dum's desktop app. Dum lives in the menu bar (Dum's face) and near the mouse: a hotkey command bar,
// a push-to-talk bubble at the cursor while it listens or answers, and a full panel. Main owns every
// operating-system capability, settings and credentials; the sandboxed pages only send the finite
// requests in protocol.ts, which ipc.ts validates and routes. Main makes no model call: the
// supervised utility host does all model work.

import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage,
  type WebPreferences,
} from "electron";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { framesFor, parse, type Sprite } from "../art-parser.ts";
import * as context from "../context.ts";
import { home } from "../skills.ts";
import { LOOK } from "../observe-types.ts";
import { bundledExecutable, claudeSetup } from "../agent/claude-setup.ts";
import { localSetup } from "../agent/local-setup.ts";
import { RELEASED } from "../agent/registry.ts";
import { accessToken, chatgptSetup } from "../agent/siwc.ts";
import { AgentSetup, credentialSource } from "./agent-setup.ts";
import { Captures, MAX_PNG_BYTES, type Capturer } from "./capture.ts";
import { Credentials, safeStorageCipher } from "./credentials.ts";
import { DictationHelper } from "./dictation.ts";
import { Drafts } from "./draft.ts";
import { Focus } from "./focus.ts";
import { HostController } from "./host-client.ts";
import { Router, ownedPage, type Native, type Role } from "./ipc.ts";
import { Observer, type Bitmap } from "./observer.ts";
import { DesktopSettings } from "./settings.ts";
import { BUBBLE_MAX, BUBBLE_TTL, Bubble, COMMAND_SIZE, FocusReturn, PANEL_SIZE, placeBubble, placeCentered, reclamp } from "./surfaces.ts";
import type { BackendId } from "../agent/types.ts";
import type { BubbleView, DesktopPreferences, Panel } from "./protocol.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const INDEX = join(here, "ui", "index.html");
const INDEX_URL = pathToFileURL(INDEX).href;
const PRELOAD = join(here, "preload.cjs");
const BUBBLE_PRELOAD = join(here, "bubble-preload.cjs");
const MAC = process.platform === "darwin";
/** Apple's own Privacy & Security › Screen Recording pane. */
const SCREEN_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const SCREEN_DENIED = "Screen Recording is off for Dum. Turn it on in System Settings › Privacy & Security › Screen Recording, then reopen Dum.";
/** Long edge of a capture the person chose to share: enough to read code, small enough to send. */
const CAPTURE_EDGE = 1568;
/** A host that keeps failing is started again after a growing pause, up to this. */
const RESTART_MAX_MS = 30_000;
/** A host that has run this long has recovered; the next failure starts the pause over. */
const RESTART_HEALTHY_MS = 60_000;

// A private profile the person or a test chose, such as a clean smoke-test profile. Absolute only.
const profile = process.env.DUM_DESKTOP_DATA;
app.enableSandbox();
if (profile !== undefined && !isAbsolute(profile)) {
  dialog.showErrorBox("Dum can't start", "DUM_DESKTOP_DATA must be an absolute directory path.");
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

function preferences(preload: string): WebPreferences {
  return {
    preload,
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

/** Dum's idle face for the menu bar: four device pixels per art pixel, drawn at 2x. */
function trayIcon(dum: Sprite): NativeImage {
  const frame = framesFor(dum, "idle")[0]!;
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
  // A menu bar app: no Dock icon, no app switcher entry.
  if (MAC) app.dock?.hide();

  const userData = app.getPath("userData");
  const settings = DesktopSettings.load(userData);
  const credentials = new Credentials(join(userData, "credentials.json"), safeStorageCipher(safeStorage));
  const claudeExecutable = bundledExecutable();
  const released = new Set((Object.keys(RELEASED) as BackendId[]).filter((id) => RELEASED[id]));
  const agent = new AgentSetup([claudeSetup({ executable: claudeExecutable, credentials }), chatgptSetup({ credentials }), localSetup()], released);
  const dum = parse(readFileSync(join(here, "..", "art", "intern.txt"), "utf8"));

  // -- windows ----------------------------------------------------------------

  const panel = new BrowserWindow({
    ...PANEL_SIZE,
    minWidth: 360,
    minHeight: 480,
    title: "Dum",
    show: false,
    fullscreenable: false,
    minimizable: false,
    backgroundColor: "#16141f",
    webPreferences: preferences(PRELOAD),
  });
  const command = new BrowserWindow({
    ...COMMAND_SIZE,
    title: "Ask Dum",
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: "#16141f",
    // A floating panel over whatever app or full-screen Space they're in.
    ...(MAC ? { type: "panel" } : {}),
    webPreferences: preferences(PRELOAD),
  });
  command.setAlwaysOnTop(true, "floating");
  command.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  const bubbleWindow = new BrowserWindow({
    ...BUBBLE_MAX,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    fullscreenable: false,
    ...(MAC ? { type: "panel" } : {}),
    webPreferences: preferences(BUBBLE_PRELOAD),
  });
  // Click-through pixels: no buttons, no hit regions, nothing to type into.
  bubbleWindow.setIgnoreMouseEvents(true);
  bubbleWindow.setAlwaysOnTop(true, "screen-saver");
  bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  const roles = new Map<number, Role>([[panel.webContents.id, "panel"], [command.webContents.id, "command"], [bubbleWindow.webContents.id, "bubble"]]);
  const windows = [panel, command, bubbleWindow];

  let quitting = false;
  for (const w of windows) {
    w.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      w.hide();
    });
  }

  const cursorArea = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  let panelPlaced = false;
  const showPanel = () => {
    if (!panelPlaced) {
      panel.setBounds(placeCentered(cursorArea(), PANEL_SIZE));
      panelPlaced = true;
    }
    panel.show();
    panel.focus();
  };

  const focus = new Focus({ platform: process.platform, resourcesPath: process.resourcesPath });
  const focusReturn = new FocusReturn(focus);
  const showCommand = async () => {
    await focusReturn.summon(panel.isVisible() && panel.isFocused());
    command.setBounds(placeCentered(cursorArea(), COMMAND_SIZE));
    command.show();
    command.focus();
  };
  const dismissCommand = async () => {
    if (!command.isVisible()) return;
    command.hide();
    const back = await focusReturn.dismiss();
    if (back === "panel") panel.focus();
    // No captured app to go back to: stepping out of the way hands focus to whatever was before.
    else if (!back && MAC && !panel.isVisible()) app.hide();
  };
  // Summon activates the command bar; summoning it while it has focus dismisses it.
  const summon = () => void (command.isVisible() && command.isFocused() ? dismissCommand() : showCommand());

  const keepOnScreen = () => {
    const areas = screen.getAllDisplays().map((d) => d.workArea);
    for (const w of windows) if (w.isVisible()) w.setBounds(reclamp(w.getBounds(), areas));
  };
  screen.on("display-removed", keepOnScreen);
  screen.on("display-metrics-changed", keepOnScreen);

  const bubble = new Bubble({
    publish(view: BubbleView | null, fresh: boolean) {
      if (bubbleWindow.isDestroyed()) return;
      if (!view) {
        bubbleWindow.webContents.send("dum:bubble", { kind: "voice", lines: [], expiresAt: 0 } satisfies BubbleView);
        bubbleWindow.hide();
        return;
      }
      // The anchor is sampled once per interaction; the bubble never follows the mouse.
      if (fresh || !bubbleWindow.isVisible()) {
        const at = screen.getCursorScreenPoint();
        bubbleWindow.setBounds(placeBubble(at, screen.getDisplayNearestPoint(at).workArea));
      }
      bubbleWindow.webContents.send("dum:bubble", view);
      if (!bubbleWindow.isVisible()) bubbleWindow.showInactive();
    },
  });

  // -- host, capture, voice, look -----------------------------------------------

  let router: Router | null = null;
  let tray: Tray | null = null;
  let pending = false;
  const broadcast = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      if (!router) return;
      const snapshot = router.snapshot();
      for (const w of [panel, command]) if (!w.isDestroyed()) w.webContents.send("dum:snapshot", snapshot);
      refreshTray();
    });
  };

  let restartTimer: NodeJS.Timeout | null = null;
  let restartDelay = 1_000;
  let startedAt = 0;
  let hostProblem = "";
  const personal = () => context.read(settings.get().personalContext ? undefined : "off");
  const startHost = async () => {
    try {
      await host.start(personal(), settings.get());
      startedAt = Date.now();
      hostProblem = "";
      if (host.view?.registry.activeZoneId === null) showPanel();
    } catch (err) {
      hostProblem = `Dum's teaching host didn't start: ${(err as Error).message}`;
      scheduleRestart();
    }
    broadcast();
  };
  /** After a crash HostController doesn't restart itself; main starts it over into fresh history. */
  const scheduleRestart = () => {
    if (quitting || restartTimer) return;
    if (startedAt && Date.now() - startedAt > RESTART_HEALTHY_MS) restartDelay = 1_000;
    const delay = restartDelay;
    restartDelay = Math.min(RESTART_MAX_MS, restartDelay * 2);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void startHost();
    }, delay);
  };

  const host: HostController = new HostController(() => {
    router?.changed();
    if (!host.running && host.failure) {
      hostProblem = host.failure;
      scheduleRestart();
    }
    broadcast();
  }, {
    home: home(),
    claudeExecutable,
    credential: credentialSource(credentials, accessToken),
    frame: (checkId) => observer.frame(checkId),
  });

  const screenGranted = () => !MAC || systemPreferences.getMediaAccessStatus("screen") === "granted";
  /** The display under the cursor, as a desktopCapturer screen source, `width` wide. */
  const cursorScreen = async (width: number) => {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const height = Math.max(1, Math.round((width * display.size.height) / Math.max(1, display.size.width)));
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height }, fetchWindowIcons: false });
    const hit = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
    return hit && !hit.thumbnail.isEmpty() ? hit.thumbnail : null;
  };

  let asleep = false;
  const observer = new Observer({
    zone: () => {
      const view = host.view;
      return view?.zoneEpoch && view.activeZone ? { zoneId: view.activeZone.id, epoch: view.zoneEpoch } : null;
    },
    blocked: () => (asleep ? "asleep or locked"
      : router?.recording ? "listening"
      : BrowserWindow.getFocusedWindow() !== null ? "a Dum window is in front"
      : host.running ? null : "the host isn't running"),
    frontmost: () => focus.frontmost(),
    async thumbnail(): Promise<Bitmap | null> {
      if (!screenGranted()) return null;
      const image = await cursorScreen(LOOK.thumbWidth);
      if (!image) return null;
      const { width, height } = image.getSize();
      return { width, height, data: image.toBitmap() };
    },
    async capture() {
      if (!screenGranted()) return null;
      return (await cursorScreen(LOOK.frameWidth))?.toPNG() ?? null;
    },
    send(tick) {
      // A tick for an epoch that's over is dropped here, never sent.
      const view = host.view;
      if (view?.zoneEpoch === tick.epoch && view.activeZone?.id === tick.zoneId) host.observeTick(tick);
    },
    look: settings.get().look,
  });

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
      // A whole screen shouldn't include Dum; hide its windows for the one frame, then bring them back without taking focus.
      const shown = source.kind === "screen" ? windows.filter((w) => w.isVisible()) : [];
      for (const w of shown) w.hide();
      try {
        if (shown.length) await sleep(250);
        const sources = await desktopCapturer.getSources({ types: [source.kind], thumbnailSize: { width: CAPTURE_EDGE, height: CAPTURE_EDGE }, fetchWindowIcons: false });
        const hit = sources.find((s) => s.id === source.id);
        if (!hit) return null;
        if (hit.thumbnail.isEmpty()) {
          throw new Error(screenGranted() ? "The system returned an empty image for that source - nothing was captured." : SCREEN_DENIED);
        }
        let image = hit.thumbnail;
        let png = image.toPNG();
        for (let shrink = 0; png.length > MAX_PNG_BYTES && shrink < 3; shrink++) {
          image = image.resize({ width: Math.round(image.getSize().width * 0.7), quality: "best" });
          png = image.toPNG();
        }
        return png;
      } finally {
        for (const w of shown) w.showInactive();
      }
    },
  };

  const dictation = new DictationHelper({
    platform: process.platform,
    arch: process.arch,
    systemVersion: process.getSystemVersion(),
    resourcesPath: process.resourcesPath,
  });

  // -- shortcuts ----------------------------------------------------------------

  const sendDraft = () => {
    void router?.sendDraft().catch((err: unknown) => bubble.timed("reply", [(err as Error).message.slice(0, 300)], BUBBLE_TTL.error));
  };
  const registered: Record<"hotkey" | "sendDraftHotkey", string> = { hotkey: "", sendDraftHotkey: "" };
  const actions: Record<"hotkey" | "sendDraftHotkey", () => void> = { hotkey: summon, sendDraftHotkey: sendDraft };
  let hotkeyError = "";
  const register = (accelerator: string, run: () => void): boolean => {
    try {
      return globalShortcut.register(accelerator, run);
    } catch {
      return false;
    }
  };
  for (const key of ["hotkey", "sendDraftHotkey"] as const) {
    const wanted = settings.get()[key];
    if (register(wanted, actions[key])) registered[key] = wanted;
    else hotkeyError = `${hotkeyError}${hotkeyError ? " " : ""}${wanted} is already used by another app or the system. Choose another shortcut in Settings.`;
  }

  const native: Native = {
    async choosePath(kind, purpose) {
      const options = {
        title: purpose === "follow" ? "Choose a folder for Dum to follow in this zone" : kind === "folder" ? "Share a folder with this request" : "Share a file with this request",
        buttonLabel: purpose === "follow" ? "Follow" : "Share",
        properties: [kind === "folder" ? "openDirectory" : "openFile"] as ("openDirectory" | "openFile")[],
      };
      const parent = BrowserWindow.getFocusedWindow();
      const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? null : picked.filePaths[0] ?? null;
    },
    async confirm(message, detail, yes) {
      const options = { type: "question" as const, message, detail, buttons: [yes, "Cancel"], defaultId: 1, cancelId: 1, noLink: true };
      const parent = BrowserWindow.getFocusedWindow();
      const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return answer.response === 0;
    },
    async openPath(path) {
      const failed = await shell.openPath(path);
      if (failed) throw new Error(`Couldn't open it: ${failed}`);
    },
    async openExternal(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Dum only opens web pages");
      await shell.openExternal(parsed.href);
    },
    async openScreenSettings() {
      if (!MAC) throw new Error("Screen sharing permission is managed by your desktop on this system.");
      await shell.openExternal(SCREEN_SETTINGS);
    },
    screenPermission: () => (MAC ? systemPreferences.getMediaAccessStatus("screen") : "not-required"),
    apply(next: DesktopPreferences, previous: DesktopPreferences) {
      if (next.launchAtLogin !== previous.launchAtLogin && !MAC && process.platform !== "win32") {
        throw new Error("Open at login isn't available on this system.");
      }
      const changed = (["hotkey", "sendDraftHotkey"] as const).filter((key) => next[key] !== registered[key]);
      for (const key of changed) if (registered[key]) globalShortcut.unregister(registered[key]);
      const done: typeof changed = [];
      for (const key of changed) {
        if (!register(next[key], actions[key])) {
          // Roll every changed shortcut back to what was registered before.
          for (const k of done) globalShortcut.unregister(next[k]);
          for (const k of changed) if (registered[k]) register(registered[k], actions[k]);
          throw new Error(`${next[key]} is already used by another app or the system - choose a different shortcut`);
        }
        done.push(key);
      }
      for (const key of changed) registered[key] = next[key];
      if (changed.length) hotkeyError = "";
      if (next.launchAtLogin !== previous.launchAtLogin) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    },
    hotkeyError: () => hotkeyError,
    async showSurface(surface) {
      if (surface === "panel") showPanel();
      else await showCommand();
    },
    openPane(pane) {
      showPanel();
      void panel.webContents.loadFile(INDEX, { query: { view: "panel" }, hash: pane });
    },
    async dismissSurface(surface) {
      if (surface === "command") await dismissCommand();
      else panel.hide();
    },
    quit: () => setImmediate(() => app.quit()),
  };

  /** Saved model ids the live catalog no longer lists move to the names it does list, or the user is asked to choose again. */
  const reconcileModels = async () => {
    const said = await agent.reconcile({
      models: (b, l) => host.agentModels(b, l),
      settings,
      send: (choice) => host.agentSelect(choice),
    }).catch((err: unknown) => (err as Error).message);
    broadcast();
    if (said) void dialog.showMessageBox({ type: "warning", message: "Dum updated your settings", detail: said });
  };

  const captures = new Captures(capturer);
  router = new Router({
    host,
    captures,
    drafts: new Drafts(),
    settings,
    agent,
    native,
    dictation,
    observer,
    bubble,
    restart: startHost,
    keySaved: () => void reconcileModels(),
    changed: broadcast,
    platform: process.platform,
    version: app.getVersion(),
  });
  dictation.onEvent((event) => router!.voiceEvent(event));

  // Requests are honored only from the top frame of Dum's own panel and command bar, showing Dum's own page.
  const trusted = (event: IpcMainInvokeEvent): Role | null => {
    const frame = event.senderFrame;
    const top = event.sender.mainFrame;
    const role = roles.get(event.sender.id);
    if (!role || !frame || frame.processId !== top.processId || frame.routingId !== top.routingId || !ownedPage(frame.url, INDEX_URL)) return null;
    return role;
  };
  ipcMain.handle("dum:request", (event, raw: unknown) => {
    const role = trusted(event);
    return role ? router!.handle(raw, role) : { ok: false, error: "request refused" };
  });

  // -- tray -----------------------------------------------------------------------

  /** Tray items go through the same router as the windows' requests. */
  const fromTray = (raw: unknown) => void router!.handle(raw, "tray");
  function refreshTray(): void {
    if (!tray || !router) return;
    const snapshot = router.snapshot();
    const zone = snapshot.activeZone;
    const where = zone ? zone.breadcrumb.map((b) => b.name).join(" › ") : snapshot.zones.activeZoneId === null ? "No zone yet" : "Opening a zone…";
    tray.setToolTip(`Dum · ${where}`);
    const zones = snapshot.zones.zones.filter((z) => z.deletedAt === null).slice(0, 40);
    const listening = snapshot.voice.phase === "recording" || snapshot.voice.phase === "transcribing";
    const template: MenuItemConstructorOptions[] = [
      { label: where, enabled: false },
      ...(hostProblem ? [{ label: hostProblem.slice(0, 120), enabled: false }] : []),
      { type: "separator" },
      { label: "Ask Dum…", accelerator: registered.hotkey || undefined, click: () => void showCommand() },
      {
        label: "Open Panel",
        submenu: [
          { label: "Panel", click: showPanel },
          { type: "separator" },
          ...([["zones", "Zones"], ["history", "History"], ["tree", "Skills"], ["settings", "Settings"]] as [Panel, string][])
            .map(([pane, label]) => ({ label, click: () => fromTray({ type: "panel", panel: pane }) })),
        ],
      },
      {
        label: "Switch Zone",
        enabled: zones.length > 0,
        submenu: zones.map((z) => ({
          label: z.name,
          type: "radio" as const,
          checked: z.id === snapshot.zones.activeZoneId,
          click: () => fromTray({ type: "zone-enter", id: z.id, expectedRevision: snapshot.zones.revision }),
        })),
      },
      { type: "separator" },
      listening && snapshot.voice.recordingId
        ? { label: "Stop Voice", click: () => fromTray({ type: "voice-stop", recordingId: snapshot.voice.recordingId }) }
        : { label: "Start Voice", enabled: dictation.status().available && snapshot.binding !== null, click: () => fromTray({ type: "voice-start", binding: snapshot.binding }) },
      { label: "Send Draft", enabled: snapshot.binding?.zoneId != null && snapshot.draft.text.trim() !== "", click: sendDraft },
      { label: snapshot.look.paused ? "Resume the Look" : "Pause the Look", click: () => fromTray({ type: "look-pause", paused: !snapshot.look.paused }) },
      { type: "separator" },
      { label: "Quit Dum", click: () => app.quit() },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  Menu.setApplicationMenu(MAC ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);
  tray = new Tray(trayIcon(dum));
  tray.setToolTip("Dum");
  if (!MAC) tray.on("click", showPanel);

  // -- sleep and lock -------------------------------------------------------------

  const away = () => {
    asleep = true;
    router?.stopVoice();
    bubble.dismiss();
  };
  const back = () => { asleep = false; };
  powerMonitor.on("suspend", away);
  powerMonitor.on("lock-screen", away);
  powerMonitor.on("resume", back);
  powerMonitor.on("unlock-screen", back);

  await Promise.all([
    panel.loadFile(INDEX, { query: { view: "panel" } }),
    command.loadFile(INDEX, { query: { view: "command" } }),
    bubbleWindow.loadFile(INDEX, { query: { view: "bubble" } }),
  ]);
  if (settings.warning) void dialog.showMessageBox({ type: "warning", message: "Dum updated your settings", detail: settings.warning });
  const checked = agent.check().finally(broadcast);
  if (dictation.status().available) void dictation.configure(settings.get().voiceHotkey).catch(() => undefined).finally(broadcast);
  // First run asks for Screen Recording once, so the look can see the screen (it's on by default).
  if (MAC && settings.get().look.screen && systemPreferences.getMediaAccessStatus("screen") === "not-determined") {
    void desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined);
  }
  await startHost();
  void checked.then(reconcileModels);

  app.on("second-instance", showPanel);
  app.on("activate", showPanel);

  let closing: Promise<void> | null = null;
  app.on("before-quit", (event) => {
    if (closing === null) {
      quitting = true;
      event.preventDefault();
      clearTimeout(restartTimer ?? undefined);
      observer.close();
      captures.discard();
      agent.cancel();
      bubble.dismiss();
      globalShortcut.unregisterAll();
      const timeout = sleep(7_000, undefined, { ref: false });
      const shutdown = Promise.allSettled([host.close(), dictation.close(), focus.close()]).then(() => undefined);
      closing = Promise.race([shutdown, timeout]).then(() => app.quit());
    }
  });
}
