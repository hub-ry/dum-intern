// The agent contract (docs/llm-setup-design.md §8.1). Model-callable functions are actions, never tools.

import type { z } from "zod";
import type { ZoneContext } from "../zone-types.ts";
import type { RequestBinding } from "../share-types.ts";

export type BackendId = "claude" | "chatgpt" | "local" | "copilot";
/** How a backend authenticates. Claude connects only with the user's own Anthropic API key. */
export type LoginMethod = "anthropic-key" | "chatgpt" | "github" | "none";
/**
 * "intern" is the conversation; "helper" is every bounded one-shot (suggested projects, Wizard decisions,
 * picture descriptions); "look" is the live look's calls, which need a model that sees pictures.
 */
export type Role = "intern" | "helper" | "look";
/** `model` is an id the backend's live catalog lists; for Claude that may be an alias such as "haiku". */
export type Selector = { backend: BackendId; model: string; effort: string | null };
/** What the user picked. Sessions must prove `login` at runtime. */
export type AgentChoice = { backend: BackendId; login: LoginMethod; intern: Selector; helper: Selector; look: Selector };

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
  /** What the selector names: for Claude, often an alias such as "haiku". */
  id: string;
  /** The model `id` runs today: an alias's current target, or `id` itself. Verification is keyed on this. */
  resolved: string;
  label: string;
  /** [] = no effort knob. */
  efforts: readonly string[];
  /** The model takes picture input. Whether Dum may send it pictures is `Capabilities.images`. */
  images: boolean;
  /** Provider function calling; required for the intern. */
  actions: boolean;
  /** `resolved` is proven with real calls on this backend; false shows "untested". */
  verified: boolean;
};

export type Capabilities = {
  /** The model the selector runs today (see `ModelOption.resolved`). */
  model: string;
  /** Dum may send this selector pictures now. Claude also needs its resolved model verified. */
  images: boolean;
  /** Why pictures are refused, in a sentence; "" when `images`. */
  noImages: string;
  interrupt: boolean;
  /** Backend reports active actions; open()/turn() assert them. */
  runtimeActionCheck: boolean;
};

export type BackendStatus = {
  id: BackendId;
  label: string;
  /** Bundled binary runs, or the endpoint answers. */
  installed: boolean;
  /** The sign-in methods this backend takes. */
  methods: readonly LoginMethod[];
  /** Confirmed by a live check; never an account field. */
  ready: LoginMethod | null;
  loginRunning: boolean;
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
  /** Refuses methods this backend doesn't take. */
  login(method: LoginMethod, ui: LoginUi): Promise<void>;
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
  /** What the selector can do on this sign-in, from the live catalog. Throws when the catalog can't be read. */
  capabilities(selector: Selector, login: LoginMethod, signal: AbortSignal): Promise<Capabilities>;
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
