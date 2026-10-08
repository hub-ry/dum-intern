// The agent contract (docs/llm-setup-design.md §8.1). Model-callable functions are actions, never tools.

import type { z } from "zod";
import type { ZoneContext } from "../zone-types.ts";
import type { RequestBinding } from "../share-types.ts";

/** Fixed when the app is built. "public" is what Dum distributes; "local" is the owner's own or dev build. */
export type Flavor = "public" | "local";
export type BackendId = "claude" | "chatgpt" | "local" | "copilot";
/** How a backend authenticates. "claude-subscription" exists only in local builds. */
export type LoginMethod = "anthropic-key" | "claude-subscription" | "chatgpt" | "github" | "none";
/** "intern" is the conversation; "helper" is every bounded one-shot (suggested projects, Wizard, ambient calls, picture descriptions). */
export type Role = "intern" | "helper";
export type Selector = { backend: BackendId; model: string; effort: string | null };
/** What the user picked. Sessions must prove `login` at runtime. */
export type AgentChoice = { backend: BackendId; login: LoginMethod; intern: Selector; helper: Selector };

/** Base64 PNG. */
export type Picture = { mimeType: "image/png"; data: string };
export type UserTurn = { text: string; images?: readonly Picture[] };

export type DumAction = {
  /** Bare action name; the backend namespaces it on the wire. */
  name: string;
  description: string;
  schema: z.ZodRawShape;
  call(args: unknown, signal: AbortSignal): Promise<{ text: string; isError?: boolean }>;
};

export type ModelOption = {
  id: string;
  label: string;
  /** [] = no effort knob. */
  efforts: readonly string[];
  images: boolean;
  /** Provider function calling; required for the intern. */
  actions: boolean;
  /** Proven with real calls on this backend; false shows "untested". */
  verified: boolean;
};

export type Capabilities = {
  images: boolean;
  interrupt: boolean;
  /** Backend reports active actions; open()/turn() assert them. */
  runtimeActionCheck: boolean;
};

export type BackendStatus = {
  id: BackendId;
  label: string;
  /** Bundled binary runs, or the endpoint answers. */
  installed: boolean;
  /** Offered in this flavor. */
  methods: readonly LoginMethod[];
  /** Confirmed by a live check; never an account field. */
  ready: LoginMethod | null;
  loginRunning: boolean;
  loginNeedsCode: boolean;
  message: string;
};

export type LoginUi = {
  /** Allowlisted https auth hosts only. */
  openUrl(url: string): Promise<void>;
  changed(): void;
};

export type AgentEvent =
  | { type: "model"; model: string; effort: string | null }
  | { type: "text"; text: string }
  | { type: "action"; name: string }
  | { type: "retry"; message: string }
  | { type: "end"; error: string | null; interrupted: boolean };

export type OpenOptions = {
  /** The active zone's empty runtime/ directory. */
  cwd: string;
  /** Immutable prompt/gate context for this request. */
  zone: ZoneContext;
  /** Epoch/token/request correlation. */
  binding: RequestBinding;
  systemPrompt: string;
  selector: Selector;
  /** Provenance the session must prove. */
  login: LoginMethod;
  /** Closed set; [] for one-shot helpers. */
  actions: readonly DumAction[];
  signal: AbortSignal;
  maxTurns?: number;
};

export interface AgentSession {
  turn(input: UserTurn): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  close(): void;
}

/** Electron main: status and sign-in only. Never opens a model session. */
export interface BackendSetup {
  readonly id: BackendId;
  status(): Promise<BackendStatus>;
  /** Refuses methods the flavor doesn't offer. */
  login(method: LoginMethod, ui: LoginUi): Promise<void>;
  /** Claude subscription paste-code. */
  code?(code: string): void;
  /** Anthropic API key; write-only. */
  setKey?(key: string): Promise<void>;
  cancelLogin(): void;
  signOut(method: LoginMethod): Promise<void>;
}

/** Desktop host: catalog and sessions. */
export interface AgentBackend {
  readonly id: BackendId;
  readonly label: string;
  models(login: LoginMethod, signal: AbortSignal): Promise<ModelOption[]>;
  capabilities(selector: Selector): Capabilities;
  /** Resolves only after provenance passes; never falls back. */
  open(o: OpenOptions): Promise<AgentSession>;
}

/** Host asks main; main answers from its encrypted store. Values never enter env, settings or logs. */
export type CredentialNeed = "anthropic-key" | "chatgpt-access";
export type CredentialSource = (need: CredentialNeed, signal: AbortSignal) =>
  Promise<{ value: string; expiresAt: number | null } | null>;

// Shared by the ChatGPT and local adapters.
export type WireCall = { id: string; name: string; arguments: string };
export type WireMessage =
  | { role: "user"; text: string; images?: readonly Picture[] }
  | { role: "assistant"; text: string; calls: readonly WireCall[] }
  /** Provider role name. */
  | { role: "tool"; callId: string; text: string; isError: boolean };
export type WireAction = { name: string; description: string; parameters: object };
export type ModelStep = { text: string; calls: WireCall[]; error: string | null };
export interface ModelClient {
  step(req: {
    system: string;
    history: readonly WireMessage[];
    actions: readonly WireAction[];
    model: string;
    effort: string | null;
    signal: AbortSignal;
  }): Promise<ModelStep>;
}
