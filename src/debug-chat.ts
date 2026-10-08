// Debug chat: Dum about Dum (docs/circle-design.md §6). An independent, in-memory session whose only
// authority is the three diagnostic reads. It never touches zone input, sessions, context, memory,
// skills, settings or files, and its binding is its own.

import { randomBytes, randomUUID } from "node:crypto";
import type { Registry } from "./agent/registry.ts";
import type { AgentChoice, AgentSession } from "./agent/types.ts";
import { diagnosticActions } from "./diagnostics.ts";
import {
  DIAGNOSTIC_LIMITS as L,
  DebugBindingSchema,
  DebugTextSchema,
  type DebugBinding,
  type DebugEntry,
  type DebugView,
  type ReadonlyDiagnostics,
} from "./diagnostic-types.ts";

const encoder = new TextEncoder();

const SYSTEM_PROMPT = [
  "You are Dum's debug chat. You answer questions about how Dum itself is running: its models, the look, voice, shortcuts, storage and recent calls.",
  "Your only tools are diagnostic_status, diagnostic_events and diagnostic_reference. Use them; don't guess.",
  "You can't change settings, zones, memory, files or code. When something needs changing, say which Settings control the user can change.",
  "Answer in short plain text. Never print links or commands to run.",
].join("\n");

/** Recognized secret forms. Arbitrary prose can't be proven secret-free; these are the shapes we know. */
const SECRETS: readonly [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted]"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]"],
  [/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|token|secret|password|passwd|cookie|session[_-]?id)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]"],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]"],
];

/** Replaces recognized secret forms. Main also strips exact stored credential values before forwarding. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
  return out;
}

function clip(text: string): string {
  const raw = encoder.encode(text);
  if (raw.length <= L.debugTextBytes) return text;
  return `${new TextDecoder().decode(raw.subarray(0, L.debugTextBytes - 4)).replace(/\uFFFD+$/, "")}…`;
}

/** Fixed explanations; provider text never reaches the transcript. */
function explain(error: string): string {
  if (/isn't one of Dum's actions|unreadable arguments/.test(error)) return "Debug chat refused an action outside its three diagnostic reads and ended this reply.";
  if (/model steps without finishing/.test(error)) return `Debug chat stopped after ${L.debugRounds} rounds without an answer.`;
  return "The debug call failed. Check Agent setup in Settings, then try again.";
}

const token = () => randomBytes(16).toString("base64url");

type Flight = { binding: DebugBinding; controller: AbortController; done: Promise<void> };

export class DebugChat {
  readonly #agent: Registry;
  readonly #diagnostics: ReadonlyDiagnostics;
  readonly #cwd: string;
  readonly #changed: () => void;
  #binding: DebugBinding = { debugSessionId: randomUUID(), debugEpoch: token(), requestId: token() };
  #entries: DebugEntry[] = [];
  #nextId = 1;
  #dropped = 0;
  #needsBackend = false;
  #expired = false;
  #activeAt = Date.now();
  #idle: NodeJS.Timeout | undefined;
  #flight: Flight | null = null;

  constructor(agent: Registry, diagnostics: ReadonlyDiagnostics, cwd: string, changed: () => void) {
    this.#agent = agent;
    this.#diagnostics = diagnostics;
    this.#cwd = cwd;
    this.#changed = changed;
  }

  open(): DebugView {
    this.#checkIdle();
    if (!this.#expired) this.#touch();
    return this.view();
  }

  view(): DebugView {
    this.#checkIdle();
    return {
      binding: { ...(this.#flight?.binding ?? this.#binding) },
      state: this.#flight ? "busy" : this.#expired ? "expired" : this.#needsBackend ? "needs-backend" : "idle",
      entries: this.#entries.map((e) => ({ ...e })),
      dropped: this.#dropped,
      expiresAt: new Date(this.#activeAt + L.debugIdleMs).toISOString(),
    };
  }

  /** One flight. Refuses a stale binding, a busy chat and an expired session. */
  async send(binding: DebugBinding, text: string): Promise<void> {
    this.#checkIdle();
    this.#assertCurrent(binding);
    if (this.#flight) throw new Error("Debug chat is already answering");
    if (this.#expired) throw new Error("This debug session expired; start a new one");
    const question = redact(DebugTextSchema.parse(text));
    let choice: AgentChoice;
    try {
      choice = this.#agent.chosen();
      this.#agent.backend(choice.backend);
    } catch {
      // The renderer keeps the debug draft and opens ordinary Agent setup.
      this.#needsBackend = true;
      this.#changed();
      return;
    }
    this.#needsBackend = false;
    this.#touch();
    const recap = this.#recap();
    this.#push("you", question);
    const controller = new AbortController();
    const flight: Flight = { binding: this.#binding, controller, done: Promise.resolve() };
    this.#binding = { ...this.#binding, requestId: token() };
    this.#flight = flight;
    this.#changed();
    flight.done = this.#run(choice, recap, question, controller);
    await flight.done;
  }

  /** Aborts this debug flight only; never a zone request. */
  async stop(binding: DebugBinding): Promise<void> {
    const parsed = DebugBindingSchema.parse(binding);
    const flight = this.#flight;
    if (!flight || !same(flight.binding, parsed)) throw new Error("That debug request isn't running");
    flight.controller.abort();
    await flight.done;
  }

  /** New/Clear: a fresh session, binding and empty history. */
  reset(): DebugView {
    this.#flight?.controller.abort();
    this.#flight = null;
    this.#fresh();
    this.#touch();
    this.#changed();
    return this.view();
  }

  /** Agent or key changed, or the host is going away: end the flight and invalidate the binding. */
  async close(): Promise<void> {
    const flight = this.#flight;
    flight?.controller.abort();
    await flight?.done;
    this.#flight = null;
    this.#fresh();
    clearTimeout(this.#idle);
    this.#changed();
  }

  async #run(choice: AgentChoice, recap: string, question: string, controller: AbortController): Promise<void> {
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), L.debugMs);
    let session: AgentSession | null = null;
    let reply = "";
    let outcome: string;
    try {
      session = await this.#agent.backend(choice.backend).open({
        cwd: this.#cwd,
        systemPrompt: SYSTEM_PROMPT,
        selector: choice.intern,
        login: choice.login,
        actions: diagnosticActions(this.#diagnostics),
        signal: controller.signal,
        maxTurns: L.debugRounds,
      });
      outcome = "The debug call ended without an answer.";
      for await (const e of session.turn({ text: recap ? `${recap}\n\nQuestion: ${question}` : question })) {
        if (controller.signal.aborted) break;
        if (e.type === "text") reply += (reply ? "\n" : "") + e.text;
        if (e.type === "end") {
          if (e.error) outcome = explain(e.error);
          else if (!e.interrupted) outcome = "";
        }
      }
    } catch {
      outcome = controller.signal.aborted ? "" : "Debug chat couldn't start a verified session with your agent. Check Agent setup in Settings.";
    } finally {
      clearTimeout(timeout);
      session?.close();
    }
    if (this.#flight?.controller !== controller) return;
    if (controller.signal.aborted) outcome = controller.signal.reason instanceof Error && controller.signal.reason.message === "timeout" ? `Debug chat timed out after ${L.debugMs / 1000} seconds.` : "Stopped.";
    if (reply.trim()) this.#push("dum", clip(redact(reply.trim())));
    if (outcome) this.#push("notice", outcome);
    this.#flight = null;
    this.#touch();
    this.#changed();
  }

  /** The previous debug exchange, already redacted, so follow-ups make sense. Zone data never enters. */
  #recap(): string {
    const lines: string[] = [];
    let size = 0;
    for (let i = this.#entries.length - 1; i >= 0 && lines.length < 6; i--) {
      const e = this.#entries[i]!;
      if (e.from === "notice") continue;
      const line = `${e.from === "you" ? "User" : "You"}: ${e.text}`;
      size += encoder.encode(line).length;
      if (size > L.debugTextBytes) break;
      lines.unshift(line);
    }
    return lines.length ? `Earlier in this debug chat:\n${lines.join("\n")}` : "";
  }

  #push(from: DebugEntry["from"], text: string): void {
    this.#entries.push({ id: this.#nextId++, from, text });
    let bytes = encoder.encode(JSON.stringify(this.#entries)).length;
    while (this.#entries.length > L.debugEntries || bytes > L.debugBytes) {
      bytes -= encoder.encode(JSON.stringify(this.#entries.shift())).length + 1;
      this.#dropped++;
    }
  }

  #fresh(): void {
    this.#binding = { debugSessionId: randomUUID(), debugEpoch: token(), requestId: token() };
    this.#entries = [];
    this.#dropped = 0;
    this.#expired = false;
    this.#needsBackend = false;
  }

  #assertCurrent(binding: DebugBinding): void {
    if (!same(this.#binding, DebugBindingSchema.parse(binding))) throw new Error("This debug request is stale; reopen debug chat");
  }

  #touch(): void {
    this.#activeAt = Date.now();
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      this.#checkIdle();
      this.#changed();
    }, L.debugIdleMs);
    this.#idle.unref?.();
  }

  #checkIdle(): void {
    if (this.#flight || this.#expired || Date.now() - this.#activeAt < L.debugIdleMs) return;
    this.#expired = true;
    this.#entries = [];
    this.#dropped = 0;
  }
}

function same(a: DebugBinding, b: DebugBinding): boolean {
  return a.debugSessionId === b.debugSessionId && a.debugEpoch === b.debugEpoch && a.requestId === b.requestId;
}
