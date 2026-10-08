// The host's diagnostics ring (docs/circle-design.md §6). Host memory only: no file, no export.
// Every insertion is validated against the closed DTO, so nothing free-form (keys, provider bodies,
// request text, paths, titles) can enter. Debug chat reads it through the three actions below.

import {
  DIAGNOSTIC_ACTIONS,
  DiagnosticActionSchema,
  type DiagnosticActionName,
  DIAGNOSTIC_LIMITS as L,
  DiagnosticEventSchema,
  DiagnosticEventsPageSchema,
  DiagnosticSettingsSchema,
  DiagnosticStatusSchema,
  MainStatusSchema,
  SanitizedMainEventsSchema,
  type CallCounters,
  type DiagnosticEvent,
  type DiagnosticEventsPage,
  type DiagnosticEventsQuery,
  type DiagnosticRole,
  type DiagnosticSettings,
  type DiagnosticStatus,
  type DiagnosticTopic,
  type MainStatus,
  type ReadonlyDiagnostics,
  type SanitizedMainEvent,
} from "./diagnostic-types.ts";
import { z } from "zod";
import type { DumAction } from "./agent/types.ts";

const encoder = new TextEncoder();
const bytes = (v: unknown) => encoder.encode(JSON.stringify(v)).length;

const ROLES: readonly DiagnosticRole[] = ["intern", "helper", "look", "debug"];
const zeroCounters = (): CallCounters => ({ started: 0, ok: 0, failed: 0, timedOut: 0, lastLatencyMs: null, inputTokens: null, outputTokens: null });

/** Version-matched, app-owned explanations. Never user code, paths or URLs. */
const REFERENCE: Record<DiagnosticTopic, string> = {
  look: [
    "The look is Dum's view of what you're doing. The host owns it; main only reports screen permission and pause.",
    "Each tick decides whether to call the look model. Skipped reasons: unchanged (nothing new on screen), dedup (same as the last call), coalesced (folded into a pending call), busy (a call is in flight), decision (a Wizard decision is open), voice (you're dictating), no-zone (no zone is open), no-frame (no picture was captured), permission (screen recording isn't allowed), unverified-model (the look model isn't verified for pictures), stale-epoch (the zone changed while it ran).",
    "Failures: rate-limit, timeout and call-failed. 'paused' means you paused the look; 'no-backend' means it notices changes but never sends anything.",
    "lastTick/lastAttempt/lastSuccess are the latest decision, call and successful call; pending counts queued changes and inflight is 0 or 1.",
  ].join("\n"),
  models: [
    "Dum has three roles: intern (the conversation, and this debug chat), helper (bounded one-shots such as Wizard decisions) and look (sees pictures).",
    "'chosen' is the selector you picked; 'resolved' is the model it runs today, e.g. an alias's current target. Verification is keyed on the resolved model, never the alias.",
    "Call counters count starts, successes, failures and timeouts per role since the host started. Token counts appear only when the backend reported them; Dum never estimates cost.",
    "Failure codes: authentication (the sign-in or key was refused), network, provider (the provider returned an error), isolation (the session failed Dum's provenance or action checks and was closed), timeout, io, invalid-reply.",
  ].join("\n"),
  status: [
    "diagnostic_status shows: app version and platform, which released backends are installed and signed in, chosen and resolved models, the look's switches and pause, its last tick/attempt/success and queue, screen permission, voice helper state, shortcut registration problems by category, and call counters.",
    "The ring keeps the newest 500 events, 512 KiB and 30 minutes, in host memory only. Sequence numbers rise for the host's lifetime; events older than expiredBefore are gone, not hidden.",
    "Settings shown are only: launch at login, personal context, look switches, mode and the three shortcuts. Keys, accounts, paths and display ids are never diagnostic inputs.",
  ].join("\n"),
  voice: [
    "Voice is the cursor bubble. 'supported' means this platform can dictate, 'available' means speech recognition is allowed now, and 'bridge' means the native helper is running.",
    "While you dictate, the look skips with reason 'voice'. A voice shortcut problem (conflict, invalid, unavailable) means the voice hotkey couldn't be registered.",
  ].join("\n"),
  storage: [
    "Dum keeps zones, directions, handoffs, memory, evidence and skills under its own home folder. Debug chat cannot read or write any of them.",
    "Diagnostics and the debug transcript are never written to disk; they vanish when the host restarts. The debug chat's working folder is an empty debug runtime folder, never a zone or a repository.",
    "io means a storage read or write failed; the event carries only that category, never the path.",
  ].join("\n"),
  shortcuts: [
    "Dum registers three shortcuts: open (the window), voice (dictation) and send draft.",
    "Problems by category: conflict (another app holds it), invalid (it isn't a valid accelerator), unavailable (the system refused it). Change a shortcut in Settings; debug chat can't change it for you.",
  ].join("\n"),
};
for (const [topic, text] of Object.entries(REFERENCE)) {
  if (encoder.encode(text).length > L.referenceBytes) throw new Error(`${topic} reference is too large`);
}

type Stored = { event: DiagnosticEvent; bytes: number };

export class Diagnostics implements ReadonlyDiagnostics {
  readonly #now: () => number;
  #main: MainStatus;
  #settings: DiagnosticSettings;
  #models: DiagnosticStatus["models"] = {
    intern: { chosen: null, resolved: null },
    helper: { chosen: null, resolved: null },
    look: { chosen: null, resolved: null },
  };
  #look: DiagnosticStatus["look"] = { status: "no-backend", reason: null, lastTick: null, lastAttempt: null, lastSuccess: null, pending: 0, inflight: 0 };
  readonly #calls: Record<DiagnosticRole, CallCounters> = { intern: zeroCounters(), helper: zeroCounters(), look: zeroCounters(), debug: zeroCounters() };
  /** Oldest first. */
  #ring: Stored[] = [];
  #ringBytes = 0;
  #seq = 0;
  /** Everything below this sequence number has left the ring. */
  #firstKept = 1;

  constructor(now: () => number, main: MainStatus, settings: DiagnosticSettings) {
    this.#now = now;
    this.#main = MainStatusSchema.parse(main);
    this.#settings = DiagnosticSettingsSchema.parse(settings);
  }

  /** Host events. Throws on anything outside the closed DTO. */
  record(event: Omit<DiagnosticEvent, "seq" | "at">): void {
    const full = DiagnosticEventSchema.parse({ seq: this.#seq + 1, at: Math.max(0, Math.floor(this.#now())), ...event });
    this.#seq = full.seq;
    this.#count(full);
    this.#ring.push({ event: full, bytes: bytes(full) });
    this.#ringBytes += this.#ring.at(-1)!.bytes;
    this.#trim();
  }

  /** Main's sanitized report; validated again here, so main can't widen the DTO. */
  main(events: readonly SanitizedMainEvent[], status: MainStatus | null): void {
    const list = SanitizedMainEventsSchema.parse(events);
    if (status) this.#main = MainStatusSchema.parse(status);
    for (const e of list) this.record(e);
  }

  settings(settings: DiagnosticSettings): void {
    this.#settings = DiagnosticSettingsSchema.parse(settings);
  }

  models(models: DiagnosticStatus["models"]): void {
    this.#models = DiagnosticStatusSchema.shape.models.parse(models);
  }

  look(look: DiagnosticStatus["look"]): void {
    this.#look = DiagnosticStatusSchema.shape.look.parse(look);
  }

  status(): DiagnosticStatus {
    this.#trim();
    const calls = Object.fromEntries(ROLES.map((r) => [r, { ...this.#calls[r] }])) as Record<DiagnosticRole, CallCounters>;
    return structuredClone({
      main: this.#main,
      settings: this.#settings,
      models: this.#models,
      look: this.#look,
      calls,
      ring: {
        events: this.#ring.length,
        bytes: this.#ringBytes,
        oldestSeq: this.#ring[0]?.event.seq ?? null,
        newestSeq: this.#ring.at(-1)?.event.seq ?? null,
        maxEvents: L.ringEvents,
        maxBytes: L.ringBytes,
        maxAgeMs: L.ringMs,
      },
    });
  }

  /** Newest first, below `beforeSeq`; at most 50 events and 32 KiB. */
  events(query: DiagnosticEventsQuery): DiagnosticEventsPage {
    const q = z.object(DIAGNOSTIC_ACTIONS.diagnostic_events).strict().parse(query);
    this.#trim();
    const before = q.beforeSeq ?? Number.POSITIVE_INFINITY;
    const kinds = q.kinds ? new Set(q.kinds) : null;
    const events: DiagnosticEvent[] = [];
    let size = bytes({ events: [], nextBeforeSeq: Number.MAX_SAFE_INTEGER, expiredBefore: Number.MAX_SAFE_INTEGER });
    let more = false;
    for (let i = this.#ring.length - 1; i >= 0; i--) {
      const { event, bytes: n } = this.#ring[i]!;
      if (event.seq >= before || (kinds && !kinds.has(event.kind))) continue;
      if (events.length >= q.limit || size + n + 1 > L.pageBytes) {
        more = true;
        break;
      }
      events.push({ ...event });
      size += n + 1;
    }
    const page = { events, nextBeforeSeq: more ? events.at(-1)?.seq ?? null : null, expiredBefore: this.#firstKept > 1 ? this.#firstKept : null };
    return DiagnosticEventsPageSchema.parse(page);
  }

  reference(topic: DiagnosticTopic): string {
    return REFERENCE[topic];
  }

  #count(e: DiagnosticEvent): void {
    if (!e.role || (e.kind !== "call-start" && e.kind !== "call-end")) return;
    const c = this.#calls[e.role];
    if (e.kind === "call-start") c.started++;
    else if (e.outcome === "ok") c.ok++;
    else if (e.reason === "timeout") c.timedOut++;
    else if (e.outcome === "failed") c.failed++;
    if (e.kind === "call-end" && e.latencyMs !== null) c.lastLatencyMs = e.latencyMs;
  }

  #trim(): void {
    const oldest = this.#now() - L.ringMs;
    while (this.#ring.length && (this.#ring.length > L.ringEvents || this.#ringBytes > L.ringBytes || this.#ring[0]!.event.at < oldest)) {
      const gone = this.#ring.shift()!;
      this.#ringBytes -= gone.bytes;
      this.#firstKept = gone.event.seq + 1;
    }
  }
}

const DESCRIPTIONS: Record<DiagnosticActionName, string> = {
  diagnostic_status: "Dum's sanitized current status: version, platform, backend readiness, chosen and resolved models, look state, permissions, shortcut problems, call counters and ring bounds.",
  diagnostic_events: "Recent diagnostic events, newest first: at most `limit` (≤50) below `beforeSeq`, optionally only some kinds. Returns the next cursor and `expiredBefore` (older events are gone).",
  diagnostic_reference: "A fixed explanation of Dum's diagnostic codes and ownership for one topic: look, models, status, voice, storage or shortcuts.",
};

/**
 * Exactly diagnostic_status, diagnostic_events and diagnostic_reference. The closure is the three
 * read methods; arguments are parsed strictly and anything else is refused.
 */
export function diagnosticActions(diagnostics: ReadonlyDiagnostics): DumAction[] {
  return (Object.keys(DIAGNOSTIC_ACTIONS) as DiagnosticActionName[]).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    schema: DIAGNOSTIC_ACTIONS[name],
    async call(args) {
      const parsed = DiagnosticActionSchema.safeParse({ name, args: args ?? {} });
      if (!parsed.success) {
        const why = parsed.error.issues.map((i) => `${i.path.slice(1).join(".") || "args"}: ${i.message}`).join("; ");
        return { text: `Refused: ${why}`.slice(0, 512), isError: true };
      }
      const action = parsed.data;
      if (action.name === "diagnostic_reference") return { text: diagnostics.reference(action.args.topic) };
      return { text: JSON.stringify(action.name === "diagnostic_status" ? diagnostics.status() : diagnostics.events(action.args)) };
    },
  }));
}
