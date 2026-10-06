// The whole renderer-to-main surface: a strict schema for the finite request set, a check that a
// request came from dum's own page, and the router that applies it to the controller, captures,
// settings, runtime setup and a small native port. No Electron here, so tests drive it directly.

import { lstatSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Context } from "../context.ts";
import type { Mode } from "../gate.ts";
import type { State } from "../store.ts";
import type { View } from "../web/view.ts";
import type { SharedImage } from "./controller.ts";
import type { Captures, Binding } from "./capture.ts";
import type { RuntimeSetup } from "./runtime-setup.ts";
import type { DictationHelper } from "./dictation.ts";
import { SettingsSchema, type DesktopSettings } from "./settings.ts";
import type { CapturePreview, CaptureSource, Panel, Reply, Request, Settings, Snapshot } from "./protocol.ts";

const token = z.string().max(256);
const delta = z.number().int().min(-4000).max(4000);

export const RequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot") }).strict(),
  z.object({ type: z.literal("choose-project") }).strict(),
  z.object({ type: z.literal("open-project"), root: z.string().min(1).max(4096) }).strict(),
  z.object({ type: z.literal("send"), text: z.string().max(32 * 1024), inputToken: token, captureToken: token.min(1).optional() }).strict(),
  z.object({ type: z.literal("interrupt") }).strict(),
  z.object({ type: z.literal("panel"), panel: z.enum(["tree", "memory", "history", "context", "evidence", "boundary"]) }).strict(),
  z.object({ type: z.literal("command"), name: z.enum(["inspect", "changes", "practice", "submit", "run", "remember"]), argument: z.string().max(4096) }).strict(),
  z.object({ type: z.literal("open-record"), record: z.enum(["proposal", "course", "memory"]), path: z.string().min(1).max(4096).optional() }).strict(),
  z.object({ type: z.literal("mode"), mode: z.enum(["understand", "anti-vibe"]) }).strict(),
  z.object({ type: z.literal("settings"), settings: SettingsSchema }).strict(),
  z.object({ type: z.literal("capture-sources") }).strict(),
  z.object({ type: z.literal("git-setup") }).strict(),
  z.object({ type: z.literal("capture-preview"), sourceId: z.string().min(1).max(256), inputToken: token }).strict(),
  z.object({ type: z.literal("capture-discard") }).strict(),
  z.object({ type: z.literal("screen-permission") }).strict(),
  z.object({ type: z.literal("runtime-check") }).strict(),
  z.object({ type: z.literal("runtime-login") }).strict(),
  z.object({ type: z.literal("dictation-open") }).strict(),
  z.object({ type: z.literal("runtime-login-open") }).strict(),
  z.object({ type: z.literal("runtime-login-code"), code: z.string().min(1).max(4096) }).strict(),
  z.object({ type: z.literal("runtime-login-cancel") }).strict(),
  z.object({ type: z.literal("toggle-panel") }).strict(),
  z.object({ type: z.literal("hide-panel") }).strict(),
  z.object({ type: z.literal("move-companion"), dx: delta, dy: delta }).strict(),
  z.object({ type: z.literal("quit") }).strict(),
]) satisfies z.ZodType<Request>;

/** A frame's URL is dum's own UI page: the same file, any query (the view), nothing else. */
export function ownedPage(url: string, index: string): boolean {
  try {
    const page = new URL(url);
    const own = new URL(index);
    return page.protocol === "file:" && own.protocol === "file:" && page.host === own.host && page.pathname === own.pathname;
  } catch {
    return false;
  }
}

/** What main needs from a project controller: the in-process controller and the host proxy both fit. */
export type Controller = {
  readonly state: State | null;
  readonly inputToken: string;
  readonly canAttach: boolean;
  readonly tree: View | null;
  readonly wizardStatus: string;
  setWizardAdvice(enabled: boolean, source?: 'screen' | 'files'): void | Promise<void>;
  choose(root: string, personal: Context, mode?: Mode): Promise<void>;
  send(text: string, inputToken: string, image?: SharedImage): Promise<void>;
  command(name: string, argument?: string): void | Promise<void>;
  panel(panel: Panel): void | Promise<void>;
  interrupt(): void | Promise<void>;
  close(): Promise<void>;
};

/** Operating-system actions main performs for the router. Every argument comes from main, never the renderer. */
export type Native = {
  chooseDirectory(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openScreenSettings(): Promise<void>;
  screenPermission(): string;
  /** Apply window, hotkey and login-item settings; throws (having changed nothing) when one can't be applied. */
  applySettings(next: Settings, previous: Settings): void;
  hotkeyError(): string;
  togglePanel(): void;
  hidePanel(): void;
  moveCompanion(dx: number, dy: number): void;
  quit(): void;
};

export type Runtime = Pick<RuntimeSetup, "status" | "check" | "login" | "loginPage" | "code" | "cancel" | "gitSetup">;

export type RouterPorts = {
  controller: Controller;
  captures: Captures;
  settings: DesktopSettings;
  runtime: Runtime;
  native: Native;
  dictation: Pick<DictationHelper, "status" | "open">;
  /** The personal context to hand a newly opened project: empty unless the setting is on. */
  personal(enabled: boolean): Context;
  platform: string;
  version: string;
};

const PROPOSAL = /^\.dum\/proposals\/[A-Za-z0-9._-]+\.patch$/;
const SCRATCH = /^\.dum\/courses\/[a-z0-9-]+\.[a-z0-9+#]+$/;

/**
 * The absolute file an open-record request may open: a proposal this session reported, the
 * current course's scratch file, or the project's memory notes. Every component under the
 * project must be real (no symlinks) and the file must exist.
 */
export function recordPath(state: State, record: "proposal" | "course" | "memory", path?: string): string {
  let rel: string;
  if (record === "memory") {
    if (path !== undefined && path !== ".dum/memory.md") throw new Error("Only the project's .dum/memory.md can be opened as memory");
    rel = ".dum/memory.md";
  } else if (record === "proposal") {
    const reported = path !== undefined && PROPOSAL.test(path) && state.transcript.some((e) => e.kind === "diff" && e.outcome === "proposed" && e.artifact === path);
    if (!reported) throw new Error("That isn't a proposal dum reported in this project");
    rel = path!;
  } else {
    const current = state.prompt?.type === "course" ? state.prompt.card.path : undefined;
    const known = current === path || state.transcript.some((e) => e.kind === "course" && e.card.path === path);
    if (path === undefined || !SCRATCH.test(path) || !known) throw new Error("That isn't a course scratch file from this project");
    rel = path;
  }
  let at = state.root;
  const parts = rel.split("/");
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      throw new Error(`${rel} doesn't exist any more`);
    }
    if (st.isSymbolicLink()) throw new Error(`${rel} goes through a symlink - dum won't open it`);
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) throw new Error(`${rel} isn't a regular file`);
  }
  return at;
}

function bounded(err: unknown): string {
  const message = err instanceof z.ZodError
    ? `dum's window sent a request it doesn't accept (${err.issues.map((i) => i.path.join(".") || i.message).slice(0, 3).join(", ")})`
    : err instanceof Error ? err.message : "that didn't work";
  return message.slice(0, 2000);
}

export class Router {
  private opening = false;

  constructor(private readonly o: RouterPorts) {}

  /** The project and prompt a capture taken now belongs to. */
  binding(): Binding | null {
    const state = this.o.controller.state;
    return state ? { root: state.root, inputToken: this.o.controller.inputToken } : null;
  }

  /** The controller changed: a capture for a different project or prompt is released. */
  changed(): void {
    this.o.captures.invalidate(this.binding());
  }

  snapshot(): Snapshot {
    const { controller, settings, runtime, native } = this.o;
    return {
      state: controller.state,
      inputToken: controller.inputToken,
      tree: controller.tree,
      canAttach: controller.canAttach,
      recentProjects: settings.recent.map((root) => ({ name: basename(root) || root, root })),
      settings: { ...settings.settings },
      wizardStatus: controller.wizardStatus,
      runtime: { ...runtime.status },
      screenPermission: native.screenPermission(),
      dictation: this.o.dictation.status(),
      hotkeyError: native.hotkeyError(),
      platform: this.o.platform,
      version: this.o.version,
    };
  }

  /** Validate and apply one renderer request. Failures come back as a message; nothing throws across IPC. */
  async handle(raw: unknown): Promise<Reply> {
    try {
      const request = RequestSchema.parse(raw) as Request;
      const extra = await this.apply(request);
      return { ok: true, snapshot: this.snapshot(), ...extra };
    } catch (err) {
      return { ok: false, error: bounded(err) };
    }
  }

  private async open(root: string, mode?: Mode): Promise<void> {
    const { controller, captures, settings } = this.o;
    if (this.opening) throw new Error("A project is already opening");
    if (controller.state?.busy) throw new Error("dum is working - press Stop before switching");
    this.opening = true;
    captures.discard();
    try {
      await controller.setWizardAdvice(settings.settings.wizardAdvice, settings.settings.wizardSource);
      await controller.choose(root, this.o.personal(settings.settings.personalContext), mode);
      try {
        settings.remember(controller.state?.root ?? root);
      } catch {
        // The project is open and listed for this run; only remembering it across restarts failed.
      }
    } finally {
      this.opening = false;
    }
  }

  private project(): State {
    const state = this.o.controller.state;
    if (!state) throw new Error("Open a project first");
    return state;
  }

  private async apply(r: Request): Promise<{ sources?: CaptureSource[]; preview?: CapturePreview }> {
    const { controller, captures, settings, runtime, native } = this.o;
    switch (r.type) {
      case "snapshot":
        return {};
      case "choose-project": {
        const root = await native.chooseDirectory();
        if (root) await this.open(root);
        return {};
      }
      case "open-project":
        if (!settings.recent.includes(r.root)) throw new Error("Choose that folder with Open project… first");
        await this.open(r.root);
        return {};
      case "mode": {
        const state = this.project();
        if (state.mode !== r.mode) await this.open(state.root, r.mode);
        return {};
      }
      case "send": {
        const state = this.project();
        if (r.inputToken !== controller.inputToken) throw new Error("That prompt changed before your message arrived - nothing was sent");
        if (!r.text.trim() && !r.captureToken) throw new Error("Type something to send");
        let image: SharedImage | undefined;
        if (r.captureToken) {
          if (!controller.canAttach) throw new Error("dum can't take a screenshot at this prompt - nothing was sent. Send it with your next request, or discard it.");
          image = captures.take(r.captureToken, { root: state.root, inputToken: r.inputToken });
        }
        await controller.send(r.text, r.inputToken, image);
        return {};
      }
      case "interrupt":
        this.project();
        await controller.interrupt();
        return {};
      case "panel":
        this.project();
        await controller.panel(r.panel);
        return {};
      case "command":
        this.project();
        await controller.command(r.name, r.argument);
        return {};
      case "open-record":
        await native.openPath(recordPath(this.project(), r.record, r.path));
        return {};
      case "settings": {
        const previous = settings.settings;
        native.applySettings(r.settings, previous);
        try {
          settings.update(r.settings);
          await controller.setWizardAdvice(r.settings.wizardAdvice, r.settings.wizardSource);
        } catch (err) {
          if (settings.settings !== previous) settings.update(previous);
          native.applySettings(previous, r.settings);
          throw new Error(`Settings couldn't be applied: ${(err as Error).message}`);
        }
        return {};
      }
      case "capture-sources":
        return { sources: await captures.sources() };
      case "capture-preview": {
        const state = this.project();
        if (r.inputToken !== controller.inputToken) throw new Error("That prompt changed - choose what to share again");
        if (!controller.canAttach) throw new Error("dum can only look at a screenshot with your request or at your next turn");
        return { preview: await captures.preview(r.sourceId, { root: state.root, inputToken: r.inputToken }) };
      }
      case "capture-discard":
        captures.discard();
        return {};
      case "dictation-open":
        await this.o.dictation.open();
        return {};
      case "screen-permission":
        await native.openScreenSettings();
        return {};
      case "runtime-check":
        await runtime.check();
        return {};
      case "runtime-login":
        runtime.login();
        return {};
      case "runtime-login-open":
        await native.openExternal(runtime.loginPage());
        return {};
      case "runtime-login-code":
        runtime.code(r.code);
        return {};
      case "runtime-login-cancel":
        runtime.cancel();
        return {};
      case "git-setup":
        await runtime.gitSetup();
        return {};
      case "toggle-panel":
        native.togglePanel();
        return {};
      case "hide-panel":
        native.hidePanel();
        return {};
      case "move-companion":
        native.moveCompanion(r.dx, r.dy);
        return {};
      case "quit":
        native.quit();
        return {};
    }
  }
}
