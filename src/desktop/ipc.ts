// The whole renderer-to-main surface: a check that a request came from Dum's own page, and the
// router that validates it with protocol.ts's RequestSchema and applies it to the host, captures,
// drafts, settings, agent setup, voice and a small native port. No Electron here, so tests drive it.
//
// Main issues the binding every conversation request carries: zoneEpoch and inputToken from the
// host's state, and a requestId of its own. While a request runs, the binding names that request
// (nested answers and shares belong to it); otherwise it names the next request, fresh after each
// Send and each zone epoch.

import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { DesktopPreferencesSchema, RequestSchema } from "./protocol.ts";
import { sameBinding, type Drafts } from "./draft.ts";
import { BUBBLE_TTL, bubbleLines, type Bubble } from "./surfaces.ts";
import type { AgentSetup } from "./agent-setup.ts";
import type { Captures } from "./capture.ts";
import type { DictationHelper } from "./dictation.ts";
import type { HostController, HostView } from "./host-client.ts";
import type { DesktopSettings } from "./settings.ts";
import type { LoginUi } from "../agent/types.ts";
import type { InputBinding, RequestBinding } from "../share-types.ts";
import type { ZoneId, ZoneRegistry } from "../zone-types.ts";
import type { VoiceEvent, VoiceState } from "./native-protocol.ts";
import type { CapturePreview, CaptureSource, DesktopPreferences, Panel, Reply, Request, Snapshot, ZoneCreate } from "./protocol.ts";
import type { ModelOption } from "../agent/types.ts";

/**
 * Who sent a request: one of Dum's windows, or main's own tray menu. The bubble has no invoke at
 * all; a request from it is refused here too.
 */
export type Role = "panel" | "command" | "bubble" | "tray";

/** A frame's URL is Dum's own UI page: the same file, any query (the view), nothing else. */
export function ownedPage(url: string, index: string): boolean {
  try {
    const page = new URL(url);
    const own = new URL(index);
    return page.protocol === "file:" && own.protocol === "file:" && page.host === own.host && page.pathname === own.pathname;
  } catch {
    return false;
  }
}

/** The host operations main routes; HostController fits. */
export type Host = Pick<HostController,
  | "view" | "running" | "createZone" | "openZone" | "updateZone" | "zoneContext" | "deleteZone" | "settings" | "agentSelect"
  | "agentModels" | "send" | "respond" | "command" | "panel" | "shareAdd" | "shareRemove" | "followAdd" | "followRemove"
  | "changeRevert" | "skillEdit" | "treeSync" | "openRecord" | "interrupt">;

/** Operating-system actions main performs for the router. Every argument comes from main, never the renderer. */
export type Native = {
  /** The native open panel; null when cancelled. */
  choosePath(kind: "file" | "folder", purpose: "share" | "follow"): Promise<string | null>;
  /** A native yes/no the person answers themselves. */
  confirm(message: string, detail: string, yes: string): Promise<boolean>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openScreenSettings(): Promise<void>;
  screenPermission(): string;
  /** Apply global shortcuts and the login item; throws (having changed nothing) when one can't be applied. */
  apply(next: DesktopPreferences, previous: DesktopPreferences): void;
  hotkeyError(): string;
  showSurface(surface: "panel" | "command"): Promise<void>;
  /** Show the panel window on one pane (a same-document hash change). */
  openPane(panel: Panel): void;
  dismissSurface(surface: "panel" | "command"): Promise<void>;
  quit(): void;
};

export type RouterPorts = {
  host: Host;
  captures: Captures;
  drafts: Drafts;
  settings: Pick<DesktopSettings, "get" | "set">;
  agent: AgentSetup;
  native: Native;
  dictation: Pick<DictationHelper, "status" | "configure" | "setup" | "start" | "stop" | "cancel">;
  observer: { setLook(p: DesktopPreferences["look"]): void; pause(paused: boolean): void; readonly status: string };
  bubble: Bubble;
  /** Start the host over with fresh personal context, after that setting changed. */
  restart(): Promise<void>;
  /** The Anthropic key was just saved and checked; main reconciles the saved models with the live catalog. */
  keySaved(): void;
  /** Something the snapshot shows changed; main broadcasts. */
  changed(): void;
  platform: string;
  version: string;
};

const IDLE_VOICE: VoiceState = { phase: "idle", recordingId: null, status: "" };

function bounded(err: unknown): string {
  const message = err instanceof z.ZodError
    ? `Dum's window sent a request it doesn't accept (${err.issues.map((i) => i.path.join(".") || i.message).slice(0, 3).join(", ")})`
    : err instanceof Error ? err.message : "that didn't work";
  return message.slice(0, 2000);
}

/** Live zones under `id`, itself included. */
function subtree(registry: ZoneRegistry, id: ZoneId): ZoneId[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const z of registry.zones) if (z.parentId === out[i] && z.deletedAt === null) out.push(z.id);
  }
  return out;
}

export class Router {
  /** The next request's ID; rotated after each Send and each zone epoch. */
  private next = randomUUID();
  /** The request a Send started, until the host shows a fresh "what's next" prompt. */
  private running: { requestId: string; token: string; seen: boolean } | null = null;
  /** The first-run goal binding's epoch; fresh once the goal became a zone. */
  private goalEpoch = randomUUID();
  private last: InputBinding | null = null;
  private voice: VoiceState = IDLE_VOICE;
  /** A voice-originated request whose reply goes to the bubble: entries after `after` are its reply. */
  private spoken: { requestId: string; after: number } | null = null;
  private paused = false;

  constructor(private readonly o: RouterPorts) {}

  /** The binding the next conversation request must carry, or null while no zone or goal is taking input. */
  live(): InputBinding | null {
    const view = this.o.host.view;
    if (!view) return null;
    if (view.zoneEpoch && view.activeZone) {
      const requestId = this.running?.requestId ?? this.next;
      return { zoneId: view.activeZone.id, zoneEpoch: view.zoneEpoch, inputToken: view.inputToken, requestId };
    }
    if (view.registry.activeZoneId === null) return { zoneId: null, zoneEpoch: this.goalEpoch, inputToken: view.inputToken, requestId: this.next };
    return null;
  }

  /** The host's state changed: retire what the old binding allowed and follow a voice request's reply. */
  changed(): void {
    const view = this.o.host.view;
    this.settle(view);
    const live = this.live();
    const before = this.last;
    if (before && (live?.zoneId !== before.zoneId || live?.zoneEpoch !== before.zoneEpoch)) {
      // Another zone, a reopened zone or no host: shares, captures, voice and the next request ID are void.
      this.o.drafts.invalidate(before.zoneId);
      this.o.captures.discard();
      void this.o.dictation.cancel().catch(() => undefined);
      this.voice = IDLE_VOICE;
      this.running = null;
      this.spoken = null;
      this.next = randomUUID();
      this.o.bubble.dismiss();
    }
    const now = this.live();
    this.o.captures.invalidate(now?.zoneId ? (now as RequestBinding) : null);
    this.last = now;
    this.follow(view);
  }

  snapshot(): Snapshot {
    const { host, settings, agent, native, drafts } = this.o;
    const view = host.view;
    const live = this.live();
    return {
      state: view?.state ?? null,
      tree: view?.tree ?? null,
      settings: settings.get(),
      zones: view?.registry ?? { version: 1, revision: 0, activeZoneId: null, zones: [] },
      activeZone: view?.activeZone ?? null,
      zoneEpoch: live?.zoneEpoch ?? "",
      binding: live,
      draft: drafts.current(live),
      shares: view?.shares ?? [],
      follows: view?.follows ?? [],
      changes: view?.changes ?? [],
      voice: { ...this.voice },
      agent: { backends: agent.backends, chosen: settings.get().agent },
      look: { status: view?.look.status ?? this.o.observer.status, paused: this.paused, screenPermission: native.screenPermission() },
      hotkeyError: native.hotkeyError(),
      platform: this.o.platform,
      version: this.o.version,
      canAttach: view?.canAttach ?? false,
    };
  }

  /** Validate and apply one request from `role`'s window. Failures come back as a message; nothing throws across IPC. */
  async handle(raw: unknown, role: Role): Promise<Reply> {
    try {
      if (role === "bubble") throw new Error("The bubble can't ask for anything");
      const request = RequestSchema.parse(raw) as Request;
      const extra = await this.apply(request, role);
      return { ok: true, snapshot: this.snapshot(), ...extra };
    } catch (err) {
      return { ok: false, error: bounded(err) };
    } finally {
      this.o.changed();
    }
  }

  /** The Send-draft shortcut: send the current draft exactly as a Send button would. */
  async sendDraft(): Promise<void> {
    const live = this.live();
    if (!live) throw new Error("Dum isn't ready for a message yet");
    await this.send(live, this.o.drafts.current(live).revision);
    this.o.changed();
  }

  /** One validated event from the voice helper. Push-to-talk starts here; late or stale output is dropped. */
  voiceEvent(event: VoiceEvent): void {
    const { bubble, dictation, drafts } = this.o;
    switch (event.op) {
      case "ready":
      case "released":
        break;
      case "pressed": {
        const live = this.live();
        if (!live) {
          bubble.timed("voice", ["Dum isn't ready to listen yet"], BUBBLE_TTL.error);
          break;
        }
        if (drafts.current(live).text.trim()) {
          bubble.timed("voice", ["Your draft isn't empty", "Edit it with the command bar, or send it first"], BUBBLE_TTL.error);
          break;
        }
        this.voice = { phase: "idle", recordingId: null, status: "Starting to listen…" };
        void dictation.start(live, event.gestureId).catch((err: unknown) => this.voiceError(bounded(err)));
        break;
      }
      case "recording":
        this.voice = { phase: "recording", recordingId: event.recordingId, status: "Listening…" };
        bubble.voice(["Listening…"]);
        break;
      case "transcribing":
        this.voice = { phase: "transcribing", recordingId: event.recordingId, status: "Transcribing…" };
        bubble.voice(["Transcribing…"]);
        break;
      case "transcript":
        try {
          const draft = drafts.voice(event.text, event.binding, this.live());
          this.voice = { phase: "ready", recordingId: null, status: "Your draft is ready - send it or edit it" };
          const preview = draft.text.length > 280 ? `${draft.text.slice(0, 279)}…` : draft.text;
          bubble.timed("voice", [preview, "Send with the Send-draft shortcut, or edit it in the command bar"], BUBBLE_TTL.ready);
        } catch (err) {
          this.voiceError(bounded(err));
        }
        break;
      case "cancelled":
        if (this.voice.recordingId === null || this.voice.recordingId === event.recordingId) {
          this.voice = IDLE_VOICE;
          bubble.dismiss();
        }
        break;
      case "error":
        if (event.recordingId === undefined || this.voice.recordingId === null || this.voice.recordingId === event.recordingId) this.voiceError(event.message);
        break;
    }
    this.o.changed();
  }

  /** Voice must stop: sleep, lock, quit. */
  stopVoice(): void {
    void this.o.dictation.cancel().catch(() => undefined);
    this.voice = IDLE_VOICE;
    this.o.bubble.dismiss();
  }

  /** Recording or transcribing: the look pauses meanwhile. */
  get recording(): boolean {
    return this.voice.phase === "recording" || this.voice.phase === "transcribing";
  }

  // -- internals --------------------------------------------------------------

  private voiceError(message: string): void {
    this.voice = { phase: "error", recordingId: null, status: message };
    this.o.bubble.timed("voice", [message], BUBBLE_TTL.error);
    this.o.changed();
  }

  /** A sent request ends when the host shows a fresh "what's next" prompt with nothing running. */
  private settle(view: HostView | null): void {
    const run = this.running;
    const state = view?.state;
    if (!run || !state) return;
    const working = state.busy || state.prompt?.type !== "next";
    if (working) run.seen = true;
    else if (run.seen || view.inputToken !== run.token) {
      this.running = null;
      this.next = randomUUID();
    }
  }

  /** The bubble follows a voice-originated request: status while it works, then what Dum and the Wizard said. */
  private follow(view: HostView | null): void {
    const spoken = this.spoken;
    if (!spoken) return;
    const state = view?.state;
    if (!state) return;
    const fresh = state.transcript.filter((e) => e.id > spoken.after);
    const dum = fresh.flatMap((e) => (e.kind === "say" ? [e.text] : e.kind === "question" ? [e.question] : []));
    const quip = fresh.findLast((e) => e.kind === "quip");
    const wizard = quip?.kind === "quip" ? quip.text : null;
    const done = this.running?.requestId !== spoken.requestId;
    const deciding = state.prompt?.type === "question" && state.prompt.purpose !== undefined;
    if (deciding) {
      this.o.bubble.timed("reply", [...bubbleLines(dum, wizard), "Decision waiting - answer it in the command bar"], BUBBLE_TTL.reply);
      this.spoken = null;
      return;
    }
    if (done) {
      this.spoken = null;
      if (dum.length || wizard) this.o.bubble.timed("reply", bubbleLines(dum, wizard), BUBBLE_TTL.reply);
      else this.o.bubble.dismiss();
      return;
    }
    const lines = dum.length || wizard ? bubbleLines(dum, wizard) : [state.status.slice(0, 200) || "Dum is working…"];
    this.o.bubble.voice(lines);
  }

  private requestBinding(binding: RequestBinding): RequestBinding {
    const live = this.live();
    if (!live || !sameBinding(binding, live)) throw new Error("That was meant for a prompt that's over - nothing happened");
    return binding;
  }

  /** Zone and epoch must be the open ones; the host checks the prompt itself. */
  private zoneBinding<B extends InputBinding>(binding: B): B {
    const live = this.live();
    if (!live || binding.zoneId === null || binding.zoneId !== live.zoneId || binding.zoneEpoch !== live.zoneEpoch) {
      throw new Error("That was meant for a zone that isn't open any more - nothing happened");
    }
    return binding;
  }

  private async send(binding: InputBinding, revision: number): Promise<void> {
    const { host, drafts, captures } = this.o;
    const live = this.live();
    const draft = drafts.ready(binding, revision, live);
    if (live!.zoneId === null) {
      await this.createRoot(draft.text);
      return;
    }
    const bound = live as RequestBinding;
    const view = host.view!;
    if (!draft.text.trim()) throw new Error("Type something to send");
    const asking = view.state?.prompt?.type === "next";
    if (draft.captureToken && !view.canAttach) throw new Error("Dum can only take a picture with your next request - nothing was sent. Send it then, or discard it.");
    const image = draft.captureToken ? captures.take(draft.captureToken, bound) : undefined;
    const named = new Set(draft.shareIds);
    const shares = view.shares.filter((s) => named.has(s.id));
    const after = view.state?.transcript.at(-1)?.id ?? -1;
    try {
      await host.send(bound, draft.text, shares, image);
    } catch (err) {
      // The picture was handed over once; a failed Send doesn't get it back.
      if (image) drafts.capture(live, null);
      throw err;
    }
    drafts.sent(live);
    if (asking) this.running = { requestId: bound.requestId, token: bound.inputToken, seen: false };
    if (draft.source === "voice") {
      this.spoken = { requestId: this.running?.requestId ?? bound.requestId, after };
      this.o.bubble.voice(["Dum is working…"]);
    }
  }

  /** The first-run goal becomes the root zone: the exact trimmed goal, and a default name from its start. */
  private async createRoot(text: string): Promise<void> {
    const goal = text.trim();
    if (!goal) throw new Error("Tell Dum what you're trying to learn first");
    const name = goal.replace(/\s+/g, " ").slice(0, 80).trim();
    await this.createZone({ name, goal, parentId: null, language: null, focusSkills: [] }, true);
  }

  private async createZone(zone: ZoneCreate, enter: boolean): Promise<void> {
    const goalStep = this.o.host.view?.registry.activeZoneId === null;
    await this.o.host.createZone(zone, enter);
    if (goalStep && enter) {
      this.o.drafts.drop([null]);
      this.goalEpoch = randomUUID();
    }
  }

  private async settingsChange(next: DesktopPreferences): Promise<void> {
    const { settings, native, host, dictation, observer } = this.o;
    const parsed = DesktopPreferencesSchema.parse(next);
    const previous = settings.get();
    if (JSON.stringify(parsed.agent) !== JSON.stringify(previous.agent)) throw new Error("Choose who powers Dum in Settings › Agent");
    const keys = [parsed.hotkey, parsed.sendDraftHotkey, parsed.voiceHotkey];
    if (new Set(keys).size !== keys.length) throw new Error("The command bar, Send-draft and voice shortcuts must all be different");
    native.apply(parsed, previous);
    try {
      settings.set(parsed);
      if (parsed.voiceHotkey !== previous.voiceHotkey && dictation.status().available) await dictation.configure(parsed.voiceHotkey);
    } catch (err) {
      try { settings.set(previous); } catch { /* the file still holds what failed to replace it */ }
      native.apply(previous, parsed);
      throw new Error(`Settings couldn't be applied: ${(err as Error).message}`);
    }
    observer.setLook(parsed.look);
    if (parsed.personalContext !== previous.personalContext) {
      await this.o.restart();
      return;
    }
    if (host.running) await host.settings(parsed);
  }

  private ui(): LoginUi {
    return {
      openUrl: (url) => this.o.native.openExternal(url),
      changed: () => void this.o.agent.check().finally(() => this.o.changed()),
    };
  }

  private async apply(r: Request, role: Role): Promise<{ sources?: CaptureSource[]; preview?: CapturePreview; models?: ModelOption[] }> {
    const { host, captures, drafts, agent, native, dictation } = this.o;
    switch (r.type) {
      case "snapshot":
        return {};
      case "zone-create":
        await this.createZone(r.zone, r.enter);
        return {};
      case "zone-enter":
        await host.openZone(r.id, r.expectedRevision);
        return {};
      case "zone-update":
        await host.updateZone(r.id, r.patch, r.expectedRevision);
        return {};
      case "zone-context":
        await host.zoneContext(r.id, r.text, r.expectedRevision);
        return {};
      case "zone-delete": {
        const registry = host.view?.registry;
        const zone = registry?.zones.find((z) => z.id === r.id && z.deletedAt === null);
        if (!registry || !zone) throw new Error("That zone doesn't exist any more");
        const inside = subtree(registry, r.id).length - 1;
        const detail = `${inside ? `This also deletes ${inside} zone${inside === 1 ? "" : "s"} inside it. ` : ""}Your skills, proof and notes stay; the zone's files are kept for inspection.`;
        if (!(await native.confirm(`Delete "${zone.name}"?`, detail, "Delete"))) return {};
        const deleted = await host.deleteZone(r.id, r.expectedRevision);
        drafts.drop(deleted.deletedIds);
        return {};
      }
      case "draft-set":
        drafts.set(r.text, r.expectedDraftRevision, r.binding, this.live());
        return {};
      case "send":
        await this.send(r.binding, r.draftRevision);
        return {};
      case "respond":
        this.zoneBinding(r.binding);
        this.o.bubble.dismiss();
        await host.respond(r.binding, r.decision);
        return {};
      case "interrupt":
        this.zoneBinding(r.binding);
        await host.interrupt();
        return {};
      case "panel":
        // The panel switches its own panes; from the command bar or tray, main takes the panel there.
        if (role !== "panel") native.openPane(r.panel);
        await host.panel(r.panel);
        return {};
      case "command":
        await host.command(r.name, r.argument, this.zoneBinding(r.binding));
        return {};
      case "share-choose": {
        const binding = this.requestBinding(r.binding);
        const path = await native.choosePath(r.kind, "share");
        if (path) drafts.share(binding, (await host.shareAdd(path, r.kind, binding)).id, true);
        return {};
      }
      case "share-path": {
        const binding = this.requestBinding(r.binding);
        const path = await this.consent(r.path, r.kind);
        if (path) drafts.share(binding, (await host.shareAdd(path, r.kind, binding)).id, true);
        return {};
      }
      case "share-remove":
        await host.shareRemove(r.shareId, this.zoneBinding(r.binding));
        if (sameBinding(r.binding, this.live())) drafts.share(r.binding, r.shareId, false);
        return {};
      case "follow-add": {
        const path = await native.choosePath("folder", "follow");
        if (path) await host.followAdd(path);
        return {};
      }
      case "follow-remove":
        await host.followRemove(r.followId);
        return {};
      case "change-revert":
        await host.changeRevert(r.changeId, this.zoneBinding(r.binding));
        return {};
      case "open-record":
        await native.openPath(await host.openRecord(r.record, r.id));
        return {};
      case "skill-edit":
        if (r.op === "add") {
          const label = r.skill.lang ? `${r.skill.name} (${r.skill.lang})` : r.skill.name;
          const yes = await native.confirm(`Add ${label} to your skills?`, "Only add a skill you can do yourself, unaided. Dum will write code that uses it for you.", "I can do it unaided");
          if (!yes) return {};
        }
        await host.skillEdit(r.op, r.skill);
        return {};
      case "tree-sync": {
        const url = await host.treeSync(r.sync);
        if (url) await native.openExternal(url);
        return {};
      }
      case "settings":
        await this.settingsChange(r.settings);
        return {};
      case "capture-sources":
        return { sources: await captures.sources() };
      case "capture-preview": {
        const binding = this.requestBinding(r.binding);
        if (!host.view?.canAttach) throw new Error("Dum can only look at a picture with your next request");
        const preview = await captures.preview(r.sourceId, binding);
        drafts.capture(binding, preview.token);
        return { preview };
      }
      case "capture-discard":
        captures.discard();
        drafts.capture(this.live(), null);
        return {};
      case "screen-permission":
        await native.openScreenSettings();
        return {};
      case "look-pause":
        this.paused = r.paused;
        this.o.observer.pause(r.paused);
        return {};
      case "voice-setup":
        await dictation.setup();
        return {};
      case "voice-start": {
        const live = this.live();
        if (!live || !sameBinding(r.binding, live)) throw new Error("That prompt changed - start voice again");
        if (drafts.current(live).text.trim()) throw new Error("Your draft isn't empty - edit it, send it or clear it before talking");
        if (this.voice.phase === "recording" || this.voice.phase === "transcribing") throw new Error("Dum is already listening");
        this.voice = { phase: "idle", recordingId: null, status: "Starting to listen…" };
        try {
          await dictation.start(live, null);
        } catch (err) {
          this.voice = IDLE_VOICE;
          throw err;
        }
        return {};
      }
      case "voice-stop":
        if (this.voice.recordingId !== r.recordingId) throw new Error("That recording is no longer active");
        await dictation.stop(r.recordingId);
        return {};
      case "voice-cancel":
        await dictation.cancel(r.recordingId);
        return {};
      case "agent-check":
        await agent.check();
        return {};
      case "agent-login": {
        // Refusals come back now; the sign-in itself runs on, reporting through the backend's status.
        const flow = agent.login(r.backend, r.method, this.ui());
        void flow.catch(() => undefined).finally(() => void agent.check().finally(() => this.o.changed()));
        return {};
      }
      case "agent-login-cancel":
        agent.cancel();
        return {};
      case "agent-key":
        await agent.setKey(r.backend, r.key);
        await agent.check();
        this.o.keySaved();
        return {};
      case "agent-signout":
        await agent.signOut(r.backend, r.method);
        await agent.check();
        return {};
      case "agent-models":
        return { models: await agent.models(r.backend, r.login, { models: (b, l) => host.agentModels(b, l) }) };
      case "agent-select":
        await agent.select(r.choice, {
          models: (b, l) => host.agentModels(b, l),
          settings: this.o.settings,
          send: (choice) => host.agentSelect(choice),
        });
        return {};
      case "show-surface":
        await native.showSurface(r.surface);
        return {};
      case "dismiss-surface":
        if (r.surface !== role) throw new Error("A window can only dismiss itself");
        await native.dismissSurface(r.surface);
        return {};
      case "quit":
        native.quit();
        return {};
    }
  }

  /**
   * A path they typed is never a grant by itself: it must be absolute, resolve to an existing file or
   * folder of the kind named, and they confirm the resolved path natively. Null when they decline.
   */
  private async consent(typed: string, kind: "file" | "folder"): Promise<string | null> {
    if (!isAbsolute(typed)) throw new Error("Type the full path, starting with /");
    let resolved: string;
    try {
      resolved = realpathSync(typed);
    } catch {
      throw new Error("Nothing exists at that path");
    }
    const st = statSync(resolved);
    if (kind === "file" ? !st.isFile() : !st.isDirectory()) throw new Error(kind === "file" ? "That path isn't a file" : "That path isn't a folder");
    const ok = await this.o.native.confirm(`Share this ${kind} with Dum for this request?`, resolved, "Share");
    return ok ? resolved : null;
  }
}
