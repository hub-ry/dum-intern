// The whole renderer-to-main surface: a check that a request came from Dum's own page, and the
// router that authorizes it with protocol.ts's `parseRequest` and applies it to the host, captures,
// drafts, settings, agent setup, voice, diagnostics and a small native port. No Electron here, so
// tests drive it.
//
// Main issues the binding every conversation request carries: zoneEpoch and inputToken from the
// host's state, and a requestId of its own. While a request runs, the binding names that request
// (nested answers and shares belong to it); otherwise it names the next request, fresh after each
// Send, Do this or decision turn, and each zone epoch. Alignment uses its own per-zone binding and
// debug chat its own; neither ever carries the active zone's grants.

import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { DesktopPreferencesSchema, parseRequest } from "./protocol.ts";
import { DIAGNOSTIC_LIMITS } from "../diagnostic-types.ts";
import { sameBinding, type Drafts } from "./draft.ts";
import { BUBBLE_OPEN, BUBBLE_TTL, bubbleLines, type Bubble } from "./surfaces.ts";
import type { AgentSetup } from "./agent-setup.ts";
import type { Captures } from "./capture.ts";
import type { DictationHelper } from "./dictation.ts";
import type { HostController, HostView } from "./host-client.ts";
import type { DesktopSettings } from "./settings.ts";
import type { Context } from "../context.ts";
import type { LoginUi } from "../agent/types.ts";
import type { ContextUseView } from "../delegation-types.ts";
import type { DebugView, DiagnosticCode, DiagnosticOutcome, MainStatus, SanitizedMainEvent } from "../diagnostic-types.ts";
import type { HostLookStatus, ScreenPermission } from "../observe-types.ts";
import type { InputBinding, RequestBinding, ShareGrant } from "../share-types.ts";
import type { SharedImage } from "../store-types.ts";
import type { ZoneId, ZoneRegistry } from "../zone-types.ts";
import type { VoiceEvent, VoiceState } from "./native-protocol.ts";
import type {
  CircleDisplays, CircleReason, CircleReply, CircleRequest, CircleState, CircleView, DesktopPreferences, DraftState, PersonalView, Reply,
  Request, Role, Snapshot, ViewName, ZoneCreate,
} from "./protocol.ts";

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
  | "view" | "debug" | "running" | "createZone" | "openZone" | "updateZone" | "zoneContext" | "deleteZone" | "settings" | "agentSelect"
  | "agentModels" | "agentVerifyImages" | "send" | "respond" | "command" | "selectView" | "shareAdd" | "shareRemove" | "followAdd" | "followRemove"
  | "changeRevert" | "skillEdit" | "treeSync" | "openRecord" | "openPersonal" | "interrupt"
  | "alignmentRead" | "alignmentStep" | "alignmentAccept" | "directionRead"
  | "decisionHelp" | "decisionDismiss" | "selectHandoff" | "editHandoff" | "dismissHandoff" | "runHandoff" | "readHandoff" | "reviewHandoff"
  | "contextUseRead" | "contextReload" | "contextIgnoreObservation"
  | "newSession" | "trailRead" | "trailSource" | "trailMap" | "storyRead"
  | "debugOpen" | "debugSend" | "debugStop" | "debugReset" | "diagnosticMain">;

/** Operating-system actions main performs for the router. Every argument comes from main, never the renderer. */
export type Native = {
  /** The native open panel; null when cancelled. */
  choosePath(kind: "file" | "folder", purpose: "share" | "follow"): Promise<string | null>;
  /** A native yes/no the person answers themselves. */
  confirm(message: string, detail: string, yes: string): Promise<boolean>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openScreenSettings(): Promise<void>;
  screenPermission(): ScreenPermission;
  /** Apply global shortcuts and the login item; throws (having changed nothing) when one can't be applied. */
  apply(next: DesktopPreferences, previous: DesktopPreferences): void;
  hotkeyError(): string;
  /** Each global shortcut's registration problem by category; null when it is registered. */
  shortcuts(): MainStatus["shortcuts"];
  /** Capture the external app, place beside the circle, show and focus the composer. */
  showWindow(): Promise<void>;
  /** Hide and FocusReturn.dismiss() once. */
  dismissWindow(): Promise<void>;
  windowVisible(): boolean;
  /** Whether the working window has keyboard focus: a reply there is already in front of them. */
  windowFocused(): boolean;
  /** Show the working window on one in-window view. */
  openView(view: ViewName): void;
  /** Main samples the cursor and bounds; returns the gesture id. */
  circleBegin(): string;
  circleEnd(gestureId: string): Promise<void>;
  circleCancel(gestureId: string): void;
  circleToggle(): Promise<void>;
  circlePosition(action: "begin" | "commit" | "cancel"): CircleDisplays;
  circleNudge(dx: number, dy: number): CircleDisplays;
  circleDisplay(displayId: string): CircleDisplays;
  displays(): CircleDisplays;
  /** Main's current named personal-context files; an open-record personal path must be one. */
  personalFiles(): readonly string[];
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
  observer: { setLook(p: DesktopPreferences["look"]): void; pause(paused: boolean): void };
  bubble: Bubble;
  /**
   * Main's opted-in personal-context copy: `current` is cached (the Settings row reads it often),
   * `reload` re-reads the named files now. Both are empty while the opt-in is off.
   */
  personal: { current(): Context; reload(): Context };
  /** Exact stored credential values, so debug text never carries one to a model or a screen. */
  secrets(): Promise<readonly string[]>;
  /** Why the host isn't usable; "" while it is healthy. */
  hostFailure(): string;
  /** Start the host over with fresh personal context, after that setting changed. */
  restart(): Promise<void>;
  /** The Anthropic key was just saved and checked; main reconciles the saved models with the live catalog. */
  keySaved(): void;
  /** Something the snapshot shows changed; main broadcasts. */
  changed(): void;
  platform: string;
  version: string;
};

type WindowRequest = Request;
type Extra = Omit<Extract<Reply, { ok: true }>, "ok" | "snapshot">;

const IDLE_VOICE: VoiceState = { phase: "idle", recordingId: null, status: "" };
const NO_CONTEXT_USE: ContextUseView = {
  subject: null, contextRevision: null, correctionRevision: 0, counts: { used: 0, omitted: 0, missing: 0, stale: 0 }, cursor: null,
};
const REDACTED = "[redacted]";
/** Recognized secret forms. Not a promise that every secret in prose is caught; exact stored values are replaced too. */
const SECRET_FORMS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
/** Stored values shorter than this aren't credentials Dum keeps; replacing them would mangle ordinary words. */
const MIN_SECRET = 12;

/** Text with recognized secret forms and the exact stored values replaced. */
function redact(text: string, exact: readonly string[]): string {
  let out = text;
  for (const value of exact) if (value.length >= MIN_SECRET) out = out.split(value).join(REDACTED);
  for (const form of SECRET_FORMS) out = out.replace(form, REDACTED);
  return out;
}

function bounded(err: unknown): string {
  const message = err instanceof z.ZodError
    ? `Dum sent a request it doesn't accept (${err.issues.map((i) => i.path.join(".") || i.message).slice(0, 3).join(", ")})`
    : err instanceof Error ? err.message : "that didn't work";
  return message.slice(0, 2000);
}

/** One of main's own diagnostic events: categorical, no request, path or text. */
function mainEvent(kind: SanitizedMainEvent["kind"], outcome: DiagnosticOutcome, reason: DiagnosticCode): SanitizedMainEvent {
  return { kind, role: null, requestId: null, checkId: null, outcome, reason, latencyMs: null, httpStatus: null };
}

/** A request's own fields, without its wire `type`. */
function fields<R extends { type: string }>(r: R): R extends unknown ? Omit<R, "type"> : never {
  const { type: _type, ...rest } = r;
  return rest as R extends unknown ? Omit<R, "type"> : never;
}

/** Live zones under `id`, itself included. */
function subtree(registry: ZoneRegistry, id: ZoneId): ZoneId[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const z of registry.zones) if (z.parentId === out[i] && z.deletedAt === null) out.push(z.id);
  }
  return out;
}

/** Why the circle needs attention, in priority order; null when nothing does. */
function attention(s: Snapshot, hostFailure: string, keyRejected: boolean): CircleReason | null {
  if (s.state?.prompt?.type === "question" && s.state.prompt.purpose !== undefined) return "decision";
  if (hostFailure) return "host-failed";
  if (keyRejected) return "key-rejected";
  const chosen = s.settings.agent;
  if (!chosen || !s.agent.backends.some((b) => b.id === chosen.backend && b.ready !== null)) return "setup";
  if (s.voice.phase === "error") return "voice-error";
  if (s.look.reason === "unverified-model") return "look-route";
  return null;
}

/**
 * Main computes the circle's face from typed fields only, never status prose. Priority:
 * listening → needs attention → thinking → looking → idle.
 */
export function circleView(s: Snapshot, hostFailure: string, keyRejected = false): CircleView {
  const face = (state: CircleState, reason: CircleReason): CircleView => ({ state, reason, paused: s.look.paused, open: s.window.visible });
  if (s.voice.phase === "recording") return face("listening", "recording");
  if (s.voice.phase === "transcribing") return face("listening", "transcribing");
  const needs = attention(s, hostFailure, keyRejected);
  if (needs) return face("attention", needs);
  if (s.state?.busy) return face("thinking", "zone");
  if (s.debug?.state === "busy") return face("thinking", "debug");
  if (s.look.status === "checking") return face("looking", "looking");
  return face("idle", s.look.paused ? "look-paused" : "none");
}

export class Router {
  /** The next request's ID; rotated after each Send, Do this and decision turn, and each zone epoch. */
  private next = randomUUID();
  /** The request a Send or Do this started, until the host shows a fresh "what's next" prompt. */
  private running: { requestId: string; token: string; seen: boolean } | null = null;
  /** A Send or Do this is being handed to the host: a second one is refused, never queued. */
  private submitting = false;
  /** The first-run goal binding's epoch; fresh once the goal became a zone. */
  private goalEpoch = randomUUID();
  private last: InputBinding | null = null;
  private voice: VoiceState = IDLE_VOICE;
  /** The request whose reply goes to the bubble: transcript entries after `after` are its reply. */
  private following: { requestId: string; after: number } | null = null;
  private paused = false;
  /** The last Anthropic key they pasted was refused; cleared by a saved key, a sign-out or a new choice. */
  private keyRejected = false;
  /** Exact stored credential values, refreshed before each debug send and after a key change. */
  private secrets: readonly string[] = [];
  /** The status main last told this host, as JSON; "" when the host has none from us. */
  private reported = "";

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

  /** The host's state changed: retire what the old binding allowed and follow the sent request's reply. */
  changed(): void {
    const view = this.o.host.view;
    if (!view) this.reported = "";
    this.settle(view);
    const live = this.live();
    const before = this.last;
    if (before && (live?.zoneId !== before.zoneId || live?.zoneEpoch !== before.zoneEpoch)) {
      // Another zone, a new session, a reopened zone or no host: shares, captures, voice and the next request ID are void.
      this.o.drafts.invalidate(before.zoneId);
      this.o.captures.discard();
      void this.o.dictation.cancel().catch(() => undefined);
      this.voice = IDLE_VOICE;
      this.running = null;
      this.following = null;
      this.next = randomUUID();
      this.o.bubble.dismiss();
    }
    const now = this.live();
    this.o.captures.invalidate(now?.zoneId ? (now as RequestBinding) : null);
    this.last = now;
    this.follow(view);
    this.diagnose([]);
  }

  snapshot(): Snapshot {
    const { host, settings, agent, native, drafts } = this.o;
    const view = host.view;
    const live = this.live();
    const prefs = settings.get();
    return {
      state: view?.state ?? null,
      tree: view?.tree ?? null,
      settings: prefs,
      zones: view?.registry ?? { version: 1, revision: 0, activeZoneId: null, zones: [] },
      activeZone: view?.activeZone ?? null,
      zoneEpoch: live?.zoneEpoch ?? "",
      binding: live,
      draft: drafts.current(live),
      shares: view?.shares ?? [],
      follows: view?.follows ?? [],
      changes: view?.changes ?? [],
      voice: { ...this.voice },
      agent: { backends: agent.backends, chosen: prefs.agent },
      look: { ...(view?.look ?? this.noLook()), paused: this.paused, permission: native.screenPermission() },
      direction: view?.direction ?? null,
      decision: view?.decision ?? null,
      handoff: view?.handoff ?? null,
      contextUse: view?.contextUse ?? NO_CONTEXT_USE,
      session: view?.session ?? null,
      trail: view?.trail ?? null,
      debug: host.debug ? this.redactView(host.debug) : null,
      window: { visible: native.windowVisible() },
      personal: this.personal(prefs),
      hotkeyError: native.hotkeyError(),
      platform: this.o.platform,
      version: this.o.version,
      canAttach: view?.canAttach ?? false,
    };
  }

  /** The circle's face, for its restricted channel. */
  circle(): CircleView {
    return circleView(this.snapshot(), this.o.hostFailure(), this.keyRejected);
  }

  /** Main's sanitized facts for the host: on initialize and whenever they change. */
  mainStatus(): MainStatus {
    const voice = this.o.dictation.status();
    return {
      version: this.o.version,
      platform: this.o.platform,
      backends: this.o.agent.backends.map((b) => ({ id: b.id, installed: b.installed, ready: b.ready })),
      screenPermission: this.o.native.screenPermission(),
      lookPaused: this.paused,
      voice: { supported: voice.supported, available: voice.available, bridge: voice.bridge },
      shortcuts: this.o.native.shortcuts(),
    };
  }

  /**
   * Main's own diagnostic events (OS, settings, backend), with its status when that changed since
   * the host last heard it. Nothing goes while the host isn't running; the ring is the host's.
   */
  diagnose(events: readonly SanitizedMainEvent[]): void {
    const { host } = this.o;
    if (!host.running || !host.view) return;
    const status = this.mainStatus();
    const json = JSON.stringify(status);
    const fresh = json !== this.reported;
    if (!events.length && !fresh) return;
    this.reported = json;
    void host.diagnosticMain(events.slice(-DIAGNOSTIC_LIMITS.mainEvents), fresh ? status : null).catch(() => {
      if (this.reported === json) this.reported = "";
    });
  }

  /**
   * Validate and apply one request from `role`'s surface. The working window gets a Reply, the
   * circle a CircleReply, the bubble nothing. Failures come back as a message; nothing throws across IPC.
   */
  handle(raw: unknown, role: "window"): Promise<Reply>;
  handle(raw: unknown, role: "circle"): Promise<CircleReply>;
  handle(raw: unknown, role: Role): Promise<Reply | CircleReply>;
  async handle(raw: unknown, role: Role): Promise<Reply | CircleReply> {
    try {
      const parsed = parseRequest(role, raw);
      if (parsed.role === "circle") {
        const gestureId = await this.circleRequest(parsed.request);
        return { ok: true, view: this.circle(), ...(gestureId ? { gesture: { gestureId } } : {}) };
      }
      const extra = await this.apply(parsed.request);
      return { ok: true, snapshot: this.snapshot(), ...extra };
    } catch (err) {
      return { ok: false, error: bounded(err) };
    } finally {
      // A request may have changed main's status (pause, voice, backends, shortcuts).
      this.diagnose([]);
      this.o.changed();
    }
  }

  /** The Send-draft shortcut: send the zone chat's current draft exactly as a Send button would. */
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
          bubble.timed("voice", ["Your draft isn't empty", "Open Dum to edit it, or send it first"], BUBBLE_TTL.error);
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
          bubble.timed("voice", [preview, "Send with the Send-draft shortcut, or open Dum to edit it"], BUBBLE_TTL.ready);
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

  /** The look as Current context shows it before a host has reported one. */
  private noLook(): HostLookStatus {
    return {
      status: this.o.hostFailure() ? "failed" : "blocked", reason: null, noPictures: "", seen: null,
      lastTick: null, lastAttempt: null, lastSuccess: null, chosen: null, resolved: null,
    };
  }

  private personal(prefs: DesktopPreferences): PersonalView {
    if (!prefs.personalContext) return { status: "off", files: [], warning: "" };
    const context = this.o.personal.current();
    const status = context.text ? "loaded" : context.warning ? "unreadable" : "missing";
    return { status, files: [...this.o.native.personalFiles()], warning: context.warning.slice(0, 2000) };
  }

  private redactView(view: DebugView): DebugView {
    return { ...view, entries: view.entries.map((e) => ({ ...e, text: redact(e.text, this.secrets) })) };
  }

  private async refreshSecrets(): Promise<void> {
    this.secrets = [...(await this.o.secrets())];
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

  /** The bubble follows the request they sent, typed or spoken: status while it works, then what Dum said. */
  private follow(view: HostView | null): void {
    const sent = this.following;
    const state = view?.state;
    if (!sent || !state) return;
    const { bubble, native } = this.o;
    const fresh = state.transcript.filter((e) => e.id > sent.after);
    const said = fresh.flatMap((e) => (e.kind === "say" ? [e.text] : []));
    const asked = fresh.flatMap((e) => (e.kind === "question" ? [e.question] : []));
    const quips = fresh.flatMap((e) => (e.kind === "quip" ? [e.text] : []));
    const wizard = quips.length ? quips.join(" ") : null;
    const done = this.running?.requestId !== sent.requestId;
    const prompt = state.prompt;
    const asking = prompt?.type === "question";
    if (done || asking) this.following = null;
    // The working window is in front of them: the reply is already on screen.
    if (native.windowVisible() && native.windowFocused()) {
      bubble.dismiss();
      return;
    }
    if (asking) {
      // A decision itself stays in the window; a plain question is shown. Both say where the answer goes.
      const deciding = prompt.purpose !== undefined;
      const lines = bubbleLines(deciding ? said : [...said, ...asked], wizard);
      this.reply([...lines, deciding ? "Decision waiting - answer it in Dum" : "Dum is waiting for your answer in Dum"]);
      return;
    }
    if (done) {
      if (said.length || wizard) this.reply(bubbleLines(said, wizard));
      else bubble.dismiss();
      return;
    }
    bubble.voice(said.length ? bubbleLines(said, wizard) : [state.status.slice(0, 200) || "Dum is working…"]);
  }

  private reply(lines: string[]): void {
    this.o.bubble.timed("reply", lines, lines.includes(BUBBLE_OPEN) ? BUBBLE_TTL.replyCut : BUBBLE_TTL.reply);
  }

  private requestBinding(binding: RequestBinding): RequestBinding {
    const live = this.live();
    if (!live || !sameBinding(binding, live)) throw new Error("That was meant for a prompt that's over - nothing happened");
    return binding;
  }

  /** Zone and epoch must be the open ones; the host checks the prompt, card and record revisions itself. */
  private zoneBinding<B extends InputBinding>(binding: B): B & { zoneId: ZoneId } {
    const live = this.live();
    if (!live || binding.zoneId === null || binding.zoneId !== live.zoneId || binding.zoneEpoch !== live.zoneEpoch) {
      throw new Error("That was meant for a zone that isn't open any more - nothing happened");
    }
    return binding as B & { zoneId: ZoneId };
  }

  /**
   * Hand a request the draft's grants exactly once: the shares it names and its held picture. Only
   * one Send or Do this is handed over at a time; after the host takes it the draft is consumed.
   */
  private async submit(
    live: RequestBinding,
    draft: DraftState,
    start: (shares: ShareGrant[], image: SharedImage | undefined) => Promise<void>,
  ): Promise<void> {
    const { host, drafts, captures } = this.o;
    if (this.submitting) throw new Error("Dum is still taking your last request - nothing was sent");
    const view = host.view!;
    const asking = view.state?.prompt?.type === "next";
    if (draft.captureToken && !view.canAttach) throw new Error("Dum can only take a picture with your next request - nothing was sent. Send it then, or discard it.");
    this.submitting = true;
    try {
      const image = draft.captureToken ? captures.take(draft.captureToken, live) : undefined;
      const named = new Set(draft.shareIds);
      try {
        await start(view.shares.filter((s) => named.has(s.id)), image);
      } catch (err) {
        // The picture was handed over once; a failed request doesn't get it back.
        if (image) drafts.capture(live, null);
        throw err;
      }
    } finally {
      this.submitting = false;
    }
    drafts.sent(live);
    if (asking) this.running = { requestId: live.requestId, token: live.inputToken, seen: false };
  }

  private async send(binding: InputBinding, revision: number): Promise<void> {
    const live = this.live();
    const draft = this.o.drafts.ready(binding, revision, live);
    if (live!.zoneId === null) {
      await this.createRoot(draft.text);
      return;
    }
    if (!draft.text.trim()) throw new Error("Type something to send");
    const bound = live as RequestBinding;
    const after = this.o.host.view?.state?.transcript.at(-1)?.id ?? -1;
    await this.submit(bound, draft, (shares, image) => this.o.host.send(bound, draft.text, shares, image));
    this.watch(bound, after);
  }

  /** The bubble follows the request just submitted under `bound`; entries up to `after` are not its reply. */
  private watch(bound: RequestBinding, after: number): void {
    this.following = { requestId: this.running?.requestId ?? bound.requestId, after };
    const { native, bubble } = this.o;
    if (!(native.windowVisible() && native.windowFocused())) bubble.voice(["Dum is working…"]);
  }

  /**
   * Do this: the explicit command for one handoff revision. The canonical draft is compare-and-swapped
   * and consumed like a Send; it must hold no text of its own, since that would be a different request.
   */
  private async runHandoff(r: Extract<WindowRequest, { type: "handoff-run" }>): Promise<void> {
    const binding = this.requestBinding(r.binding);
    const draft = this.o.drafts.ready(binding, r.draftRevision, this.live());
    if (draft.text.trim()) throw new Error("Your draft has text that isn't part of this handoff - send it or clear it first; nothing ran");
    const after = this.o.host.view?.state?.transcript.at(-1)?.id ?? -1;
    await this.submit(binding, draft, (shares, image) =>
      this.o.host.runHandoff({ binding, handoffId: r.handoffId, revision: r.revision, shares, ...(image ? { image } : {}) }));
    this.watch(binding, after);
  }

  /** A decision turn: the host composes one card for their outcome, then that request ID is retired. */
  private async decisionHelp(r: Extract<WindowRequest, { type: "decision-help" }>): Promise<Extra> {
    const binding = this.requestBinding(r.binding);
    if (this.running) throw new Error("Wait for Dum to finish, or Stop it - nothing was asked");
    const decision = await this.o.host.decisionHelp(binding, r.outcome);
    if (!this.running && this.next === binding.requestId) this.next = randomUUID();
    return { decision };
  }

  /** The first-run goal becomes the root zone: the exact trimmed goal, and a default name from its start. */
  private async createRoot(text: string): Promise<void> {
    const goal = text.trim();
    if (!goal) throw new Error("Tell Dum what you're trying to learn first");
    const name = goal.replace(/\s+/g, " ").slice(0, 80).trim();
    await this.createZone({ name, goal, parentId: null, language: null, focusSkills: [] }, true);
  }

  private async createZone(zone: ZoneCreate, enter: boolean): Promise<Extra> {
    const goalStep = this.o.host.view?.registry.activeZoneId === null;
    const { direction } = await this.o.host.createZone(zone, enter);
    if (goalStep && enter) {
      this.o.drafts.drop([null]);
      this.goalEpoch = randomUUID();
    }
    return { direction };
  }

  private async settingsChange(next: DesktopPreferences): Promise<void> {
    const { settings, native, host, dictation, observer } = this.o;
    const parsed = DesktopPreferencesSchema.parse(next);
    const previous = settings.get();
    if (JSON.stringify(parsed.agent) !== JSON.stringify(previous.agent)) throw new Error("Choose who powers Dum in Settings › Agent");
    const keys = [parsed.hotkey, parsed.sendDraftHotkey, parsed.voiceHotkey];
    if (new Set(keys).size !== keys.length) throw new Error("The Open Dum, Send-draft and voice shortcuts must all be different");
    try {
      native.apply(parsed, previous);
    } catch (err) {
      this.diagnose([mainEvent("settings", "failed", "shortcut-conflict")]);
      throw err;
    }
    try {
      settings.set(parsed);
      if (parsed.voiceHotkey !== previous.voiceHotkey && dictation.status().available) await dictation.configure(parsed.voiceHotkey);
    } catch (err) {
      try { settings.set(previous); } catch { /* the file still holds what failed to replace it */ }
      native.apply(previous, parsed);
      throw new Error(`Settings couldn't be applied: ${(err as Error).message}`);
    }
    observer.setLook(parsed.look);
    this.diagnose([mainEvent("settings", "ok", "settings-change")]);
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

  /** The circle's gestures and toggle; main samples the pointer itself. Returns a new gesture's id. */
  private async circleRequest(r: CircleRequest): Promise<string | null> {
    const { native } = this.o;
    switch (r.type) {
      case "circle-press":
        if (r.phase === "begin") return native.circleBegin();
        if (r.phase === "end") await native.circleEnd(r.gestureId);
        else native.circleCancel(r.gestureId);
        return null;
      case "circle-toggle":
        await native.circleToggle();
        return null;
      case "circle-view":
        return null;
    }
  }

  private async apply(r: WindowRequest): Promise<Extra> {
    const { host, captures, drafts, agent, native, dictation } = this.o;
    switch (r.type) {
      case "snapshot":
        return {};
      case "zone-create":
        return this.createZone(r.zone, r.enter);
      case "zone-enter":
        await host.openZone(r.id, r.expectedRevision);
        return {};
      case "zone-update":
        return { direction: (await host.updateZone(r.id, r.patch, r.expectedRevision)).direction };
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
      case "view":
        // The window switches its own views; the host loads what that view shows.
        await host.selectView(r.view);
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
      case "open-record": {
        if (r.record !== "personal") {
          await native.openPath(await host.openRecord(r.record, r.id));
          return {};
        }
        // The host names the file behind its own ref; main opens it only if it is one of its named files now.
        const path = await host.openPersonal(r.sourceId);
        if (!native.personalFiles().includes(path)) throw new Error("That isn't one of your current personal-context files - nothing was opened");
        await native.openPath(path);
        return {};
      }
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
        this.diagnose([mainEvent("backend", "ok", "backend-check")]);
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
        try {
          await agent.setKey(r.backend, r.key);
        } catch (err) {
          this.keyRejected = true;
          this.diagnose([mainEvent("backend", "failed", "authentication")]);
          throw err;
        }
        this.keyRejected = false;
        await this.refreshSecrets();
        await agent.check();
        this.diagnose([mainEvent("backend", "ok", "backend-check")]);
        this.o.keySaved();
        return {};
      case "agent-signout":
        await agent.signOut(r.backend, r.method);
        this.keyRejected = false;
        await this.refreshSecrets();
        await agent.check();
        return {};
      case "agent-models":
        return { models: await agent.models(r.backend, r.login, { models: (b, l) => host.agentModels(b, l) }) };
      case "agent-verify-images":
        // Claude's one sign-in is the API key; the probe is refused while a request runs, like decision help.
        if (this.running) throw new Error("Wait for Dum to finish, or Stop it - nothing was verified");
        await host.agentVerifyImages(r.selector, "anthropic-key");
        return {};
      case "agent-select":
        await agent.select(r.choice, {
          models: (b, l) => host.agentModels(b, l),
          settings: this.o.settings,
          send: (choice) => host.agentSelect(choice),
        });
        this.keyRejected = false;
        return {};
      // Goal alignment of any zone, by its own binding: nothing of the active zone's request goes with it.
      case "alignment-read":
        return { direction: await host.alignmentRead(r.zoneId) };
      case "alignment-step":
        return { direction: await host.alignmentStep(fields(r)) };
      case "alignment-accept":
        return { direction: await host.alignmentAccept(fields(r)) };
      case "direction-read":
        return { directionRecord: await host.directionRead(r.zoneId, r.directionId) };
      // Decisions and handoffs in the open zone. Selection and edits write no source file.
      case "decision-help":
        return this.decisionHelp(r);
      case "decision-dismiss":
        await host.decisionDismiss(this.zoneBinding(r.binding), r.decisionId, r.revision);
        return {};
      case "handoff-select":
        this.zoneBinding(r.binding);
        return { handoff: await host.selectHandoff(fields(r)) };
      case "handoff-edit":
        this.zoneBinding(r.binding);
        return { handoff: await host.editHandoff(fields(r)) };
      case "handoff-dismiss":
        this.zoneBinding(r.binding);
        await host.dismissHandoff(fields(r));
        return {};
      case "handoff-run":
        await this.runHandoff(r);
        return {};
      case "handoff-read":
        return { handoff: await host.readHandoff(r.zoneId, r.handoffId) };
      case "handoff-review":
        this.zoneBinding(r.binding);
        return { handoff: await host.reviewHandoff(fields(r)) };
      // Current context.
      case "context-use-read":
        return { contextUse: await host.contextUseRead(this.zoneBinding(r.binding), r.cursor) };
      case "context-reload": {
        const binding = this.zoneBinding(r.binding);
        // Main re-reads its opted-in copy first; the renderer never names a file.
        const personal = this.o.settings.get().personalContext ? this.o.personal.reload() : { path: "", text: "", warning: "" };
        await host.contextReload(binding, personal);
        return {};
      }
      case "context-ignore-observation":
        this.zoneBinding(r.binding);
        await host.contextIgnoreObservation(fields(r));
        return {};
      // Sessions, trail and story. Historical reads confer nothing.
      case "session-new":
        await host.newSession(this.zoneBinding(r.binding));
        return {};
      case "trail-read":
        return { trail: await host.trailRead(fields(r)) };
      case "trail-source":
        return { trailSource: await host.trailSource(r.zoneId, r.sessionId, r.sourceId) };
      case "trail-map":
        this.zoneBinding(r.binding);
        await host.trailMap(fields(r));
        return {};
      case "story-read":
        return { story: await host.storyRead(fields(r)) };
      // Debug chat: its own binding; typed text is redacted here before any model sees it.
      case "debug-open":
        await this.refreshSecrets();
        return { debug: this.redactView(await host.debugOpen()) };
      case "debug-send": {
        await this.refreshSecrets();
        const text = redact(r.text, this.secrets);
        await host.debugSend(r.binding, text);
        return {};
      }
      case "debug-stop":
        await host.debugStop(r.binding);
        return {};
      case "debug-reset":
        return { debug: this.redactView(await host.debugReset()) };
      // Move circle: main samples and clamps.
      case "circle-position":
        return { displays: native.circlePosition(r.action) };
      case "circle-nudge":
        return { displays: native.circleNudge(r.dx, r.dy) };
      case "circle-display":
        return { displays: native.circleDisplay(r.displayId) };
      case "show-surface":
        await native.showWindow();
        return {};
      case "dismiss-surface":
        await native.dismissWindow();
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
