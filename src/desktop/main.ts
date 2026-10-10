// Dum's desktop app (docs/circle-design.md §1-§3, §7). One persistent draggable circle with Dum's face
// unfolds into a column of circles (Dum, up to three goals, the skill tree); each opens its own panel
// in the one working window, placed at the circle's corner. A click-through bubble shows voice status
// and one-sentence replies at the cursor, and, as a thought cloud beside the circle, the active goal's
// step and the Wizard jumping in. No Tray, command bar or Dock icon. Main owns every
// operating-system capability, settings, the circle's placement and credentials; the sandboxed pages
// only send the finite requests in protocol.ts, which ipc.ts validates and routes. Main makes no
// model call: the supervised utility host does all model work.

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
  type Display,
  type IpcMainInvokeEvent,
  type WebPreferences,
} from "electron";
import { setTimeout as sleep } from "node:timers/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as context from "../context.ts";
import { home } from "../skills.ts";
import { LOOK } from "../observe-types.ts";
import { bundledExecutable, claudeSetup } from "../agent/claude-setup.ts";
import { RELEASED } from "../agent/registry.ts";
import { accessToken, chatgptSetup } from "../agent/siwc.ts";
import { AgentSetup, credentialSource } from "./agent-setup.ts";
import { Captures, MAX_PNG_BYTES, type Capturer } from "./capture.ts";
import { Credentials, safeStorageCipher, type CredentialKind } from "./credentials.ts";
import { DictationHelper } from "./dictation.ts";
import { Drafts } from "./draft.ts";
import { Focus } from "./focus.ts";
import { HostController } from "./host-client.ts";
import { Router, ownedPage, type Native } from "./ipc.ts";
import { Observer, type Shot } from "./observer.ts";
import { DesktopSettings, withPlacement } from "./settings.ts";
import {
  BUBBLE_MAX, BUBBLE_TTL, Bubble, CIRCLE, COLUMN, CircleGesture, FocusReturn, PANEL_SIZE,
  clampCircle, columnRect, defaultCircle, diskCenter, fromPlacement, insideColumn, insideDisk, nearestDisplay, placeBubble, placePanel,
  placeThought, reclamp, slotAt, toPlacement,
  type DisplayArea, type Rect,
} from "./surfaces.ts";
import type { BackendId } from "../agent/types.ts";
import type { DiagnosticCode, SanitizedMainEvent, ShortcutProblem } from "../diagnostic-types.ts";
import type { BubbleView, CircleDisplays, CircleView, DesktopPreferences, Role } from "./protocol.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const INDEX = join(here, "ui", "index.html");
const INDEX_URL = pathToFileURL(INDEX).href;
const PRELOAD = join(here, "preload.cjs");
const CIRCLE_PRELOAD = join(here, "circle-preload.cjs");
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
const CREDENTIALS: readonly CredentialKind[] = ["anthropic-key", "chatgpt-refresh", "chatgpt-host-id"];
/** Every Dum surface is visible on every Space and over full-screen apps, without turning Dum into a foreground app. */
const ALL_SPACES = { visibleOnFullScreen: true, skipTransformProcessType: true } as const;

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

/** One of main's sanitized facts for the diagnostics ring: codes only, never prose or identifiers. */
function mainEvent(kind: SanitizedMainEvent["kind"], outcome: SanitizedMainEvent["outcome"], reason: DiagnosticCode): SanitizedMainEvent {
  return { kind, role: null, requestId: null, checkId: null, outcome, reason, latencyMs: null, httpStatus: null };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

async function start(): Promise<void> {
  const deny = (_wc: unknown, _permission: string, callback: (granted: boolean) => void) => callback(false);
  session.defaultSession.setPermissionRequestHandler(deny);
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setDevicePermissionHandler(() => false);
  // The circle is the entry point: no Dock icon, no app switcher entry.
  if (MAC) app.dock?.hide();

  const userData = app.getPath("userData");
  const settings = DesktopSettings.load(userData);
  const credentials = new Credentials(join(userData, "credentials.json"), safeStorageCipher(safeStorage));
  const claudeExecutable = bundledExecutable();
  const released = new Set((Object.keys(RELEASED) as BackendId[]).filter((id) => RELEASED[id]));
  const agent = new AgentSetup([claudeSetup({ executable: claudeExecutable, credentials }), chatgptSetup({ credentials })], released);

  // -- windows ----------------------------------------------------------------

  // The circle never takes focus, so the app the person is in stays frontmost through a press.
  const circleWindow = new BrowserWindow({
    width: CIRCLE.window,
    height: CIRCLE.window,
    title: "Dum",
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    // Dum is never the active app while the circle is pressed: the first click must reach the page.
    acceptFirstMouse: true,
    skipTaskbar: true,
    fullscreenable: false,
    ...(MAC ? { type: "panel" } : {}),
    webPreferences: preferences(CIRCLE_PRELOAD),
  });
  // Above the working window, whose corner it sits on.
  circleWindow.setAlwaysOnTop(true, "pop-up-menu");
  circleWindow.setVisibleOnAllWorkspaces(true, ALL_SPACES);
  const work = new BrowserWindow({
    ...PANEL_SIZE.dum,
    title: "Dum",
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
  work.setAlwaysOnTop(true, "floating");
  work.setVisibleOnAllWorkspaces(true, ALL_SPACES);
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
  bubbleWindow.setVisibleOnAllWorkspaces(true, ALL_SPACES);
  const roles = new Map<number, Role>([[circleWindow.webContents.id, "circle"], [work.webContents.id, "window"], [bubbleWindow.webContents.id, "bubble"]]);
  const windows = [circleWindow, work, bubbleWindow];

  let quitting = false;
  for (const w of windows) {
    w.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      // Cmd+W and the like hide the working window the same way Esc does; the others only go with Quit.
      if (w === work) void dismissWindow();
    });
  }

  // -- displays and the circle's place ------------------------------------------

  const readDisplays = (): DisplayArea[] => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({ id: String(d.id), workArea: d.workArea, bounds: d.bounds, primary: d.id === primary }));
  };
  let screens = readDisplays();
  /** Where the circle sits: its display and normalized place there. Null until a display exists. */
  let at: { displayId: string; u: number; v: number } | null = null;
  /** The collapsed circle's rect; the window grows from it into the column. Null until a display exists. */
  let circleRect: Rect | null = null;
  /** The column is out; main decides, the page only animates. */
  let expanded = false;
  /** When the pointer was last over the column, for its idle fold. */
  let overAt = 0;
  /** The fold animation in flight: the window shrinks back to the circle when it ends. */
  let foldTimer: NodeJS.Timeout | null = null;
  /** The step or Wizard cloud showing beside the circle; null while the bubble is at the cursor or hidden. */
  let beside: Extract<BubbleView, { kind: "step" | "wizard" }> | null = null;
  /** A live keyboard Move circle: where it started, to restore on Esc. */
  let positioning: { bounds: Rect; at: { displayId: string; u: number; v: number } } | null = null;
  let asleep = false;
  let locked = false;

  const currentDisplay = (): DisplayArea | null => screens.find((d) => d.id === at?.displayId) ?? null;
  /** How many circles the column holds now. */
  const slotCount = () => router?.circle().slots.length ?? 1;
  /** The circle's window as the column or the one circle, moved only when it changed; a cloud beside it follows. */
  const fitCircle = (): void => {
    const display = currentDisplay();
    if (!circleRect || !display) return;
    const next = expanded ? columnRect(circleRect, display.workArea, slotCount()) : foldTimer ? null : circleRect;
    if (next && !sameRect(circleWindow.getBounds(), next)) circleWindow.setBounds(next);
    if (placeBeside() && beside) bubbleWindow.webContents.send("dum:bubble", beside);
  };
  /** Clamp onto `display`, remember the normalized place in memory, and move only when it changed. */
  const putCircle = (rect: Rect, display: DisplayArea): void => {
    const next = clampCircle(rect, display.workArea);
    at = { displayId: display.id, ...toPlacement(next, display.workArea) };
    circleRect = next;
    fitCircle();
  };
  /** Unfold the column from the circle. */
  const expand = (): void => {
    if (expanded || !circleRect) return;
    clearTimeout(foldTimer ?? undefined);
    foldTimer = null;
    expanded = true;
    overAt = Date.now();
    fitCircle();
    broadcast();
  };
  /** Fold the column into one circle; the window shrinks after the page's animation unless `now`. */
  const collapse = (now = false): void => {
    if (!expanded && !foldTimer) return;
    expanded = false;
    clearTimeout(foldTimer ?? undefined);
    foldTimer = now ? null : setTimeout(() => {
      foldTimer = null;
      fitCircle();
    }, COLUMN.foldMs);
    fitCircle();
    broadcast();
  };
  /** The display's cached user placement, else the default rule applied to that display. */
  const placementOn = (display: DisplayArea): Rect => {
    const saved = settings.circle().placements.find((p) => p.displayId === display.id);
    return saved ? fromPlacement(saved, display.workArea) : defaultCircle(display.workArea);
  };
  /** Launch or first display: the last display the user chose if it's here, else the primary. */
  const restoreCircle = (): boolean => {
    const chosen = settings.circle().lastChosenDisplayId;
    const display = screens.find((d) => d.id === chosen) ?? screens.find((d) => d.primary) ?? screens[0];
    if (!display) return false;
    putCircle(placementOn(display), display);
    return true;
  };
  /** Persist the circle's current place as the user's choice for its display. Placement only, never preferences. */
  const remember = (): void => {
    if (!at) return;
    try {
      settings.setCircle(withPlacement(settings.circle(), { ...at, usedAt: new Date().toISOString() }));
    } catch {
      // The circle stays where it is for this run; the next successful move saves it.
      router?.diagnose([mainEvent("settings", "failed", "io")]);
    }
  };
  const displaysView = (): CircleDisplays => {
    const all = screen.getAllDisplays();
    const label = (d: Display, i: number) => d.label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) || `Display ${i + 1}`;
    return {
      displays: all.slice(0, 16).map((d, i) => ({
        id: String(d.id),
        label: label(d, i),
        primary: d.id === screen.getPrimaryDisplay().id,
        current: String(d.id) === at?.displayId,
      })),
      positioning: positioning !== null,
    };
  };

  // -- the round hit region and gestures ----------------------------------------

  const gesture = new CircleGesture(Date.now);
  /** Whether the press began on the column rather than the one circle: a click there picks, a drag moves nothing. */
  let pressOnColumn = false;
  let ignoring: boolean | null = null;
  const setIgnore = (ignore: boolean) => {
    if (ignore === ignoring) return;
    ignoring = ignore;
    circleWindow.setIgnoreMouseEvents(ignore);
  };
  /**
   * Every frame while the circle shows: pointer outside the disk (or the column's background) passes
   * through to what's under it; during a captured press the circle takes everything and follows a
   * proven drag. The column folds after COLUMN.idleMs without the pointer over it.
   */
  const frame = () => {
    const pointer = screen.getCursorScreenPoint();
    const id = gesture.active;
    if (id) {
      setIgnore(false);
      if (gesture.overdue(id)) return circleCancel(id);
      if (pressOnColumn) return;
      const moved = gesture.move(id, pointer);
      const display = moved && nearestDisplay(pointer, screens);
      if (moved && display) putCircle(moved, display);
      return;
    }
    if (expanded) {
      const over = insideColumn(pointer, circleWindow.getBounds());
      const now = Date.now();
      if (over) overAt = now;
      else if (now - overAt >= COLUMN.idleMs) collapse();
      setIgnore(!over);
      return;
    }
    setIgnore(!circleRect || !insideDisk(pointer, circleRect));
  };
  let frames: NodeJS.Timeout | null = null;
  const showCircle = () => {
    if (asleep || locked || quitting) return;
    if (!at && !restoreCircle()) return;
    if (!circleWindow.isVisible()) circleWindow.showInactive();
    frames ??= setInterval(frame, CIRCLE.frameMs);
  };
  const hideCircle = () => {
    clearInterval(frames ?? undefined);
    frames = null;
    const id = gesture.active;
    if (id) circleCancel(id);
    collapse(true);
    circleWindow.hide();
  };

  function circleCancel(id: string): void {
    const start = gesture.cancel(id);
    if (pressOnColumn) return;
    const display = start && nearestDisplay(diskCenter(start), screens);
    if (start && display) putCircle(start, display);
  }

  // -- the working window -----------------------------------------------------------

  const focus = new Focus({ platform: process.platform, resourcesPath: process.resourcesPath });
  const focusReturn = new FocusReturn(focus);
  /** Native pickers, confirmations and one-frame captures in flight: the blur they cause doesn't hide Dum. */
  let holds = 0;
  const held = async <T>(run: () => Promise<T>): Promise<T> => {
    holds++;
    try {
      return await run();
    } finally {
      holds--;
    }
  };
  /** The current panel at the circle's corner, at that panel's size, on the circle's display; never following the cursor. */
  const anchor = (force = false) => {
    if (!force && !work.isVisible()) return;
    const display = currentDisplay() ?? nearestDisplay(screen.getCursorScreenPoint(), screens);
    if (!display) return;
    const area = display.workArea;
    const disk = circleRect ? diskCenter(circleRect) : { x: area.x + area.width / 2, y: area.y + area.height / 2 };
    const next = placePanel(disk, area, PANEL_SIZE[router?.panel().kind ?? "dum"]);
    if (!sameRect(work.getBounds(), next)) work.setBounds(next);
  };

  // Summons, toggles and dismissals run one at a time, so a slow capture can't reopen after a dismissal.
  let queue: Promise<void> = Promise.resolve();
  const serial = (run: () => Promise<void>): Promise<void> => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  const show = async () => {
    // Capture the external app before Dum activates; with a Dum window already in front there is none.
    if (BrowserWindow.getFocusedWindow() === null) await focusReturn.summon();
    else focusReturn.forget();
    // The window opening folds the column; the panel takes the circle's corner.
    collapse();
    if (!work.isVisible()) anchor(true);
    work.show();
    work.focus();
    if (circleWindow.isVisible()) circleWindow.moveTop();
    broadcast();
  };
  /** Hide; `restore` gives focus back to the captured app, once. Never `app.hide()`, which would hide the circle too. */
  const hide = async (restore: boolean) => {
    if (!work.isVisible()) return;
    work.hide();
    broadcast();
    if (restore) await focusReturn.dismiss();
    else focusReturn.forget();
  };
  const showWindow = () => serial(show);
  const dismissWindow = () => serial(() => hide(true));
  /** The hotkey: focused hides, anything else shows the last panel and focuses. */
  const toggle = (focused: boolean) => serial(() => (focused && work.isVisible() ? hide(true) : show()));
  const summon = () => void toggle(work.isVisible() && work.isFocused());
  /** A click or accessibility press on the one circle: the column folds, an open panel hides, else the column unfolds. */
  const clickCircle = () => serial(async () => {
    if (expanded) collapse();
    else if (work.isVisible()) await hide(true);
    else expand();
  });

  work.on("blur", () => {
    // The step and the Wizard can come back once they've looked away.
    broadcast();
    // Settle first: a blur from the circle, a native picker or a Dum window isn't the person leaving.
    setImmediate(() => {
      if (quitting || holds > 0 || gesture.active || !work.isVisible() || work.isFocused() || BrowserWindow.getFocusedWindow() !== null) return;
      // They chose another app: hide, and don't take them back to the one Dum captured.
      void serial(() => hide(false));
    });
  });

  /** Put the cloud beside the circle with its puffs toward it; whether the puffs changed side. */
  function placeBeside(): boolean {
    const display = currentDisplay();
    if (!beside || !circleRect || !display) return false;
    const { rect, toward } = placeThought(circleRect, display.workArea);
    if (!sameRect(bubbleWindow.getBounds(), rect)) bubbleWindow.setBounds(rect);
    if (beside.toward === toward) return false;
    beside = { ...beside, toward };
    return true;
  }
  const bubble = new Bubble({
    publish(view: BubbleView | null, fresh: boolean) {
      if (bubbleWindow.isDestroyed()) return;
      const wasBeside = beside !== null;
      beside = view?.kind === "step" || view?.kind === "wizard" ? view : null;
      if (!view) {
        bubbleWindow.webContents.send("dum:bubble", { kind: "voice", lines: [], expiresAt: 0 } satisfies BubbleView);
        bubbleWindow.hide();
        return;
      }
      if (beside) {
        placeBeside();
        view = beside;
      }
      // A voice or reply anchor is sampled once per interaction; it never follows the mouse, and steps off the circle.
      else if (fresh || wasBeside || !bubbleWindow.isVisible()) {
        const cursor = screen.getCursorScreenPoint();
        const circle = circleWindow.isVisible() ? circleWindow.getBounds() : null;
        bubbleWindow.setBounds(placeBubble(cursor, screen.getDisplayNearestPoint(cursor).workArea, BUBBLE_MAX, circle));
      }
      bubbleWindow.webContents.send("dum:bubble", view);
      if (!bubbleWindow.isVisible()) bubbleWindow.showInactive();
    },
  });

  // -- display changes ----------------------------------------------------------------

  screen.on("display-removed", (_event, old: Display) => {
    screens = readDisplays();
    router?.diagnose([mainEvent("native", "ok", "display-change")]);
    if (!screens.length) {
      at = null;
      positioning = null;
      hideCircle();
      return;
    }
    // A drag in progress is cancelled back to where it started; the column folds.
    const id = gesture.active;
    const cancelled = id ? gesture.cancel(id) : null;
    const started = pressOnColumn ? null : cancelled;
    collapse(true);
    if (positioning?.at.displayId === String(old.id)) positioning = null;
    const bounds = started ?? circleRect;
    if (bounds && (started || at?.displayId === String(old.id))) {
      // Into the remaining work area nearest the old center; the removed display's saved place and the last choice stay.
      putCircle(bounds, nearestDisplay(diskCenter(bounds), screens)!);
    }
    if (bubbleWindow.isVisible()) bubbleWindow.setBounds(reclamp(bubbleWindow.getBounds(), screens.map((d) => d.workArea)));
    anchor();
  });
  screen.on("display-metrics-changed", (_event, changed: Display) => {
    screens = readDisplays();
    router?.diagnose([mainEvent("native", "ok", "display-change")]);
    const display = screens.find((d) => d.id === String(changed.id));
    // Same normalized place on the resized work area, then clamped; a drag in progress keeps following the pointer.
    if (display && at?.displayId === display.id && !gesture.active) {
      collapse(true);
      putCircle(fromPlacement(at, display.workArea), display);
    }
    if (bubbleWindow.isVisible()) bubbleWindow.setBounds(reclamp(bubbleWindow.getBounds(), screens.map((d) => d.workArea)));
    anchor();
  });
  screen.on("display-added", () => {
    screens = readDisplays();
    router?.diagnose([mainEvent("native", "ok", "display-change")]);
    // Never teleports mid-use; only a circle still waiting for its first display appears.
    if (!at) showCircle();
  });

  // -- host, capture, voice, look -----------------------------------------------

  let router: Router | null = null;
  /**
   * The one deferred publish, coalescing changes within a turn. Quit cancels it: once Quit starts,
   * Electron destroys the windows, and a publish that read them during teardown would throw
   * ("Object has been destroyed") with the JavaScript environment going away, which leaves the
   * main process running after `quit`.
   */
  let publish: NodeJS.Immediate | null = null;
  let circleSent = "";
  const broadcast = () => {
    if (publish || quitting) return;
    publish = setImmediate(() => {
      publish = null;
      if (!router || quitting) return;
      router.windowChanged();
      work.webContents.send("dum:snapshot", router.snapshot());
      const view: CircleView = router.circle();
      const json = JSON.stringify(view);
      if (json !== circleSent) {
        circleSent = json;
        // A goal added or gone while the column is out resizes it.
        fitCircle();
        circleWindow.webContents.send("dum:circle", view);
      }
    });
  };

  work.on("focus", broadcast);

  let restartTimer: NodeJS.Timeout | null = null;
  let restartDelay = 1_000;
  let startedAt = 0;
  let hostProblem = "";
  let firstStart = true;
  const readPersonal = () => context.read(settings.get().personalContext ? undefined : "off");
  let personalCopy = readPersonal();
  const personal = {
    current: () => personalCopy,
    reload: () => (personalCopy = readPersonal()),
  };
  const startHost = async () => {
    try {
      await host.start(personal.reload(), settings.get(), router!.mainStatus());
      startedAt = Date.now();
      hostProblem = "";
      // First run opens the one window at its goal question; a login start otherwise stays at the circle.
      if (firstStart && host.view?.registry.activeZoneId === null) void showWindow();
      firstStart = false;
    } catch (err) {
      hostProblem = `Dum's host didn't start: ${(err as Error).message}`;
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
    frame: () => observer.frame(),
  });

  const screenGranted = () => !MAC || systemPreferences.getMediaAccessStatus("screen") === "granted";
  /** The display under the cursor, as a desktopCapturer screen source `width` wide, with its global bounds. */
  const cursorScreen = async (width: number): Promise<Shot | null> => {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const height = Math.max(1, Math.round((width * display.size.height) / Math.max(1, display.size.width)));
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height }, fetchWindowIcons: false });
    const hit = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
    if (!hit || hit.thumbnail.isEmpty()) return null;
    const size = hit.thumbnail.getSize();
    return { displayId: String(display.id), display: display.bounds, bitmap: { ...size, data: hit.thumbnail.toBitmap() } };
  };

  const observer = new Observer({
    zone: () => {
      const view = host.view;
      return view?.zoneEpoch && view.activeZone ? { zoneId: view.activeZone.id, epoch: view.zoneEpoch } : null;
    },
    blocked: () => (asleep || locked ? "asleep or locked"
      : router?.recording ? "listening"
      : BrowserWindow.getFocusedWindow() !== null ? "a Dum window is in front"
      : host.running ? null : "the host isn't running"),
    frontmost: () => focus.frontmost(),
    thumbnail: async () => (screenGranted() ? cursorScreen(LOOK.thumbWidth) : null),
    capture: async () => (screenGranted() ? cursorScreen(LOOK.frameWidth) : null),
    encode: (f) => nativeImage.createFromBitmap(Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength), { width: f.width, height: f.height }).toPNG(),
    // Dum's own surfaces, wherever they are now: the circle always, the window and bubble while shown.
    own: () => windows.filter((w) => w.isVisible()).map((w) => w.getBounds()),
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
    grab: (source) => held(async () => {
      // A whole screen they chose to share shouldn't include Dum; hide its windows for the one frame, then bring them back without taking focus.
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
    }),
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
  type Key = "hotkey" | "sendDraftHotkey";
  const registered: Record<Key, string> = { hotkey: "", sendDraftHotkey: "" };
  const problems: Record<Key, ShortcutProblem | null> = { hotkey: null, sendDraftHotkey: null };
  const actions: Record<Key, () => void> = { hotkey: summon, sendDraftHotkey: sendDraft };
  let hotkeyError = "";
  /** Null when registered; Electron throws for an accelerator it can't parse and returns false for one already taken. */
  const register = (accelerator: string, run: () => void): ShortcutProblem | null => {
    try {
      return globalShortcut.register(accelerator, run) ? null : "conflict";
    } catch {
      return "invalid";
    }
  };
  const startupConflicts: SanitizedMainEvent[] = [];
  for (const key of ["hotkey", "sendDraftHotkey"] as const) {
    const wanted = settings.get()[key];
    problems[key] = register(wanted, actions[key]);
    if (!problems[key]) registered[key] = wanted;
    else {
      hotkeyError = `${hotkeyError}${hotkeyError ? " " : ""}${wanted} is already used by another app or the system. Choose another shortcut in Settings.`;
      startupConflicts.push(mainEvent("settings", "failed", "shortcut-conflict"));
    }
  }

  const native: Native = {
    choosePath: (kind, purpose) => held(async () => {
      const options = {
        title: purpose === "follow" ? "Choose a folder for Dum to follow for this goal" : kind === "folder" ? "Share a folder with this request" : "Share a file with this request",
        buttonLabel: purpose === "follow" ? "Follow" : "Share",
        properties: [kind === "folder" ? "openDirectory" : "openFile"] as ("openDirectory" | "openFile")[],
      };
      const parent = BrowserWindow.getFocusedWindow();
      const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? null : picked.filePaths[0] ?? null;
    }),
    confirm: (message, detail, yes) => held(async () => {
      const options = { type: "question" as const, message, detail, buttons: [yes, "Cancel"], defaultId: 1, cancelId: 1, noLink: true };
      const parent = BrowserWindow.getFocusedWindow();
      const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return answer.response === 0;
    }),
    async openPath(path) {
      const failed = await shell.openPath(path);
      if (failed) throw new Error(`Couldn't open it: ${failed}`);
    },
    async openExternal(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Dum only opens web pages");
      await shell.openExternal(parsed.href);
    },
    openScreenSettings: () => held(async () => {
      if (!MAC) throw new Error("Screen sharing permission is managed by your desktop on this system.");
      await shell.openExternal(SCREEN_SETTINGS);
    }),
    screenPermission: () => (MAC ? systemPreferences.getMediaAccessStatus("screen") : "not-required"),
    apply(next: DesktopPreferences, previous: DesktopPreferences) {
      if (next.launchAtLogin !== previous.launchAtLogin && !MAC && process.platform !== "win32") {
        throw new Error("Open at login isn't available on this system.");
      }
      const changed = (["hotkey", "sendDraftHotkey"] as const).filter((key) => next[key] !== registered[key]);
      for (const key of changed) if (registered[key]) globalShortcut.unregister(registered[key]);
      const done: typeof changed = [];
      for (const key of changed) {
        if (register(next[key], actions[key])) {
          // Roll every changed shortcut back to what was registered before.
          for (const k of done) globalShortcut.unregister(next[k]);
          for (const k of changed) if (registered[k]) register(registered[k], actions[k]);
          throw new Error(`${next[key]} is already used by another app or the system - choose a different shortcut`);
        }
        done.push(key);
      }
      for (const key of changed) {
        registered[key] = next[key];
        problems[key] = null;
      }
      if (changed.length) hotkeyError = "";
      if (next.launchAtLogin !== previous.launchAtLogin) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    },
    hotkeyError: () => hotkeyError,
    shortcuts: () => ({
      open: problems.hotkey,
      voice: dictation.status().available ? null : "unavailable",
      sendDraft: problems.sendDraftHotkey,
    }),
    showWindow,
    dismissWindow,
    windowVisible: () => work.isVisible(),
    windowFocused: () => work.isFocused(),
    placePanel: () => anchor(),
    circleExpanded: () => expanded,
    circleCollapse: () => collapse(),
    circleBegin() {
      setIgnore(false);
      const pointer = screen.getCursorScreenPoint();
      pressOnColumn = expanded;
      if (!expanded) return gesture.begin(pointer, circleRect ?? circleWindow.getBounds());
      overAt = Date.now();
      const column = circleWindow.getBounds();
      return gesture.begin(pointer, column, insideColumn(pointer, column));
    },
    async circleEnd(gestureId) {
      const pointer = screen.getCursorScreenPoint();
      if (pressOnColumn) {
        // A click on a disk picks that circle, resolved from main's own sample; anything else does nothing.
        if (gesture.end(gestureId, pointer) !== "toggle" || !expanded) return;
        const slots = router!.circle().slots;
        const index = slotAt(pointer, circleWindow.getBounds(), slots.length);
        if (index !== null) await router!.pick(slots[index]!.ref);
        return;
      }
      const moved = gesture.move(gestureId, pointer);
      const display = moved && nearestDisplay(pointer, screens);
      if (moved && display) putCircle(moved, display);
      const ended = gesture.end(gestureId, pointer);
      if (ended === "drag") {
        // Committed once, on a successful drag end; the panel re-anchors at its corner.
        positioning = null;
        remember();
        anchor();
        broadcast();
      } else if (ended === "toggle") {
        await clickCircle();
      }
    },
    circleCancel,
    circleToggle: clickCircle,
    circlePosition(action) {
      if (action === "begin") {
        if (!at || !circleRect) throw new Error("There's no display to put the circle on.");
        collapse(true);
        positioning = { bounds: circleRect, at: { ...at } };
      } else if (positioning && action === "commit") {
        positioning = null;
        remember();
        anchor();
      } else if (positioning) {
        const display = screens.find((d) => d.id === positioning!.at.displayId);
        if (display) putCircle(positioning.bounds, display);
        positioning = null;
        anchor();
      }
      return displaysView();
    },
    circleNudge(dx, dy) {
      const display = currentDisplay();
      if (!positioning || !display || !circleRect) throw new Error("Start Move circle first.");
      putCircle({ ...circleRect, x: circleRect.x + dx, y: circleRect.y + dy }, display);
      return displaysView();
    },
    circleDisplay(displayId) {
      const display = screens.find((d) => d.id === displayId);
      if (!display) throw new Error("That display isn't connected any more.");
      // That display's cached place, the user's choice from now on.
      collapse(true);
      putCircle(placementOn(display), display);
      remember();
      if (positioning && at && circleRect) positioning = { bounds: circleRect, at: { ...at } };
      anchor();
      return displaysView();
    },
    displays: displaysView,
    personalFiles: () => (personalCopy.path ? personalCopy.path.split(", ").filter((p) => isAbsolute(p)) : []),
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
    personal,
    async secrets() {
      const values = await Promise.all(CREDENTIALS.map((kind) => credentials.get(kind).catch(() => null)));
      return values.filter((v): v is string => typeof v === "string" && v !== "");
    },
    hostFailure: () => hostProblem,
    restart: startHost,
    keySaved: () => void reconcileModels(),
    changed: broadcast,
    platform: process.platform,
    version: app.getVersion(),
  });
  dictation.onEvent((event) => router!.voiceEvent(event));

  // Requests are honored only from the top frame of Dum's own page, and each surface only on its own channel.
  const trusted = (event: IpcMainInvokeEvent): Role | null => {
    const frame = event.senderFrame;
    const top = event.sender.mainFrame;
    const role = roles.get(event.sender.id);
    if (!role || !frame || frame.processId !== top.processId || frame.routingId !== top.routingId || !ownedPage(frame.url, INDEX_URL)) return null;
    return role;
  };
  ipcMain.handle("dum:request", (event, raw: unknown) => (trusted(event) === "window" ? router!.handle(raw, "window") : { ok: false, error: "request refused" }));
  ipcMain.handle("dum:circle", (event, raw: unknown) => (trusted(event) === "circle" ? router!.handle(raw, "circle") : { ok: false, error: "request refused" }));

  // Editing and Quit only: Cmd+W hides the window (its close is a dismissal), Cmd+Q is the controlled Quit.
  Menu.setApplicationMenu(MAC ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);

  // -- sleep and lock -------------------------------------------------------------

  const away = () => {
    router?.stopVoice();
    bubble.suspend(true);
    hideCircle();
    router?.diagnose([mainEvent("native", "ok", "sleep")]);
  };
  // Back without activation, once neither sleep nor the lock screen is in the way.
  const back = () => {
    if (!asleep && !locked) bubble.suspend(false);
    showCircle();
    router?.diagnose([mainEvent("native", "ok", "unlock")]);
  };
  powerMonitor.on("suspend", () => { asleep = true; away(); });
  powerMonitor.on("lock-screen", () => { locked = true; away(); });
  powerMonitor.on("resume", () => { asleep = false; back(); });
  powerMonitor.on("unlock-screen", () => { locked = false; back(); });

  await Promise.all([
    circleWindow.loadFile(INDEX, { query: { view: "circle" } }),
    work.loadFile(INDEX, { query: { view: "window" } }),
    bubbleWindow.loadFile(INDEX, { query: { view: "bubble" } }),
  ]);
  showCircle();
  if (settings.warning) void dialog.showMessageBox({ type: "warning", message: "Dum updated your settings", detail: settings.warning });
  const checked = agent.check().finally(broadcast);
  if (dictation.status().available) void dictation.configure(settings.get().voiceHotkey).catch(() => undefined).finally(broadcast);
  // First run asks for Screen Recording once, so the look can see the screen (it's on by default).
  if (MAC && settings.get().look.screen && systemPreferences.getMediaAccessStatus("screen") === "not-determined") {
    void desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined);
  }
  await startHost();
  if (startupConflicts.length) router.diagnose(startupConflicts);
  void checked.then(reconcileModels);

  app.on("second-instance", () => void showWindow());
  app.on("activate", () => void showWindow());

  let closing: Promise<void> | null = null;
  app.on("before-quit", (event) => {
    if (closing === null) {
      quitting = true;
      clearImmediate(publish ?? undefined);
      publish = null;
      event.preventDefault();
      clearTimeout(restartTimer ?? undefined);
      clearInterval(frames ?? undefined);
      frames = null;
      observer.close();
      captures.discard();
      agent.cancel();
      clearTimeout(foldTimer ?? undefined);
      bubble.suspend(true);
      globalShortcut.unregisterAll();
      const timeout = sleep(7_000, undefined, { ref: false });
      const shutdown = Promise.allSettled([host.close(), dictation.close(), focus.close()]).then(() => undefined);
      closing = Promise.race([shutdown, timeout]).then(() => app.quit());
    }
  });
}
