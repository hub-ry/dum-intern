// Who powers Dum, on main's side (docs/llm-setup-design.md §4): each released backend's status and
// sign-in, the write-only Anthropic key, and the validated choice. Main never opens a model session:
// the model catalog comes from the host, and the host gets main's persisted copy of the choice.

import { agentChoiceSchema, BackendStatusSchema, offeredLogins } from "../agent/schema.ts";
import type {
  AgentChoice, BackendId, BackendSetup, BackendStatus, CredentialSource, Flavor, LoginMethod, LoginUi, ModelOption, Selector,
} from "../agent/types.ts";
import type { Credentials } from "./credentials.ts";
import type { DesktopPreferences } from "./protocol.ts";

/** A setup that can reopen the sign-in page its running login printed (Claude's subscription flow). */
export type PageSetup = BackendSetup & { openPage?(): Promise<void> };

/** What a selection goes through after validation: the host's live catalog, main's settings, then the host's copy. */
export type SelectPorts = {
  models(backend: BackendId, login: LoginMethod): Promise<ModelOption[]>;
  settings: { get(): DesktopPreferences; set(p: DesktopPreferences): void };
  send(choice: AgentChoice): Promise<void>;
};

const KEY_REFUSED = "That key wasn't saved. Check it and paste it again.";

const LABELS: Record<BackendId, string> = { claude: "Claude", chatgpt: "ChatGPT", local: "On this Mac", copilot: "GitHub Copilot" };

/** How a row reads before or without a status: never anything a backend said that might echo a secret. */
function unknown(id: BackendId, methods: readonly LoginMethod[]): BackendStatus {
  return { id, label: LABELS[id], installed: false, methods, ready: null, loginRunning: false, loginNeedsCode: false, message: "Dum couldn't check this one. Check again." };
}

export class AgentSetup {
  private readonly byId = new Map<BackendId, PageSetup>();
  private statuses: BackendStatus[] = [];
  /** The setup whose sign-in is running, for open/code/cancel. */
  private active: PageSetup | null = null;
  private checking: Promise<void> | null = null;
  private again = false;

  constructor(setups: readonly PageSetup[], readonly flavor: Flavor, private readonly released: ReadonlySet<BackendId>) {
    for (const s of setups) {
      if (this.byId.has(s.id)) throw new Error(`${s.id} is set up twice`);
      if (released.has(s.id)) this.byId.set(s.id, s);
    }
    this.statuses = [...this.byId.values()].map((s) => unknown(s.id, offeredLogins(flavor, s.id)));
  }

  /** One row per released backend, in registration order. Booleans and one sentence each; never a key, token or account field. */
  get backends(): BackendStatus[] {
    return this.statuses.map((s) => ({ ...s, methods: [...s.methods] }));
  }

  /** Every released backend's status, in parallel. Overlapping checks coalesce into one more run. */
  check(): Promise<void> {
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    const run = async () => {
      do {
        this.again = false;
        const setups = [...this.byId.values()];
        const results = await Promise.allSettled(setups.map((s) => s.status()));
        this.statuses = setups.map((s, i) => {
          const r = results[i]!;
          const methods = offeredLogins(this.flavor, s.id);
          if (r.status === "rejected") return unknown(s.id, methods);
          const parsed = BackendStatusSchema.safeParse(r.value);
          if (!parsed.success || parsed.data.id !== s.id) return unknown(s.id, methods);
          // The flavor decides the methods, whatever a backend reports.
          const ready = parsed.data.ready && methods.includes(parsed.data.ready) ? parsed.data.ready : null;
          return { ...parsed.data, methods: parsed.data.methods.filter((m) => methods.includes(m)), ready };
        });
      } while (this.again);
    };
    this.checking = run().finally(() => { this.checking = null; });
    return this.checking;
  }

  /**
   * Start a sign-in. Refusals throw at once; the returned promise is the sign-in itself, which may run
   * for minutes in the browser. Public builds neither offer nor route a Claude subscription.
   */
  login(backend: BackendId, method: LoginMethod, ui: LoginUi): Promise<void> {
    const setup = this.setup(backend);
    this.offered(backend, method);
    if (method === "anthropic-key") throw new Error("Paste your Anthropic API key instead of signing in");
    if (this.active && this.active !== setup) this.active.cancelLogin();
    this.active = setup;
    return setup.login(method, ui);
  }

  /** Reopen the running sign-in's page, for a person whose browser didn't open. */
  async openPage(): Promise<void> {
    if (!this.active?.openPage) throw new Error("No sign-in page is waiting");
    await this.active.openPage();
  }

  code(code: string): void {
    if (!this.active?.code) throw new Error("Sign-in isn't waiting for a code");
    this.active.code(code);
  }

  cancel(): void {
    this.active?.cancelLogin();
  }

  /** Store the Anthropic key, write-only. Nothing returns it and no message repeats it. */
  async setKey(backend: "claude", key: string): Promise<void> {
    const setup = this.setup(backend);
    this.offered(backend, "anthropic-key");
    if (!setup.setKey) throw new Error("Claude doesn't take a key in this build");
    try {
      await setup.setKey(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      throw new Error(message && !message.includes(key) ? message : KEY_REFUSED);
    }
  }

  /** Remove only that method's credential; never transcript, memory, evidence, skills or changes. */
  async signOut(backend: BackendId, method: LoginMethod): Promise<void> {
    const setup = this.setup(backend);
    this.offered(backend, method);
    await setup.signOut(method);
  }

  /** The host's catalog for one backend and method; the backend must be released and the method offered. */
  async models(backend: BackendId, login: LoginMethod, ports: Pick<SelectPorts, "models">): Promise<ModelOption[]> {
    this.setup(backend);
    this.offered(backend, login);
    return ports.models(backend, login);
  }

  /**
   * Validate a choice for this flavor and against the host's live catalog, persist it in main's
   * settings, then send the host its copy. A choice that fails any step changes nothing saved.
   */
  async select(raw: AgentChoice, ports: SelectPorts): Promise<AgentChoice> {
    const parsed = agentChoiceSchema(this.flavor).safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "That choice isn't offered in this build");
    const choice = parsed.data;
    this.setup(choice.backend);
    const catalog = await ports.models(choice.backend, choice.login);
    pick(catalog, choice.intern, "intern");
    pick(catalog, choice.helper, "helper");
    const prefs = ports.settings.get();
    ports.settings.set({ ...prefs, agent: choice });
    await ports.send(choice);
    return choice;
  }

  private setup(id: BackendId): PageSetup {
    const found = this.byId.get(id);
    if (!found) throw new Error(this.released.has(id) ? `${id} isn't available in this build` : `${id} isn't released yet`);
    return found;
  }

  private offered(backend: BackendId, method: LoginMethod): void {
    if (!offeredLogins(this.flavor, backend).includes(method)) {
      throw new Error(method === "claude-subscription"
        ? "This build of Dum doesn't sign in with a Claude subscription. Use an Anthropic API key."
        : `${backend} doesn't sign in with ${method} in this build`);
    }
  }
}

/** The selector must name a listed model at an effort it advertises; the intern needs actions. */
function pick(catalog: readonly ModelOption[], selector: Selector, role: "intern" | "helper"): void {
  const option = catalog.find((m) => m.id === selector.model);
  if (!option) throw new Error(`${selector.model} isn't in ${selector.backend}'s model list - choose again`);
  if (role === "intern" && !option.actions) throw new Error(`${option.label} can't call Dum's actions, so it can't be the intern`);
  const effortOk = option.efforts.length === 0 ? selector.effort === null : selector.effort !== null && option.efforts.includes(selector.effort);
  if (!effortOk) throw new Error(`${option.label} doesn't offer ${selector.effort ?? "the default"} effort`);
}

/**
 * Main's answers to the host's credential requests: the Anthropic key from the encrypted store and a
 * short-lived ChatGPT access token. Any failure answers null; nothing is logged or kept here.
 */
export function credentialSource(
  credentials: Credentials,
  chatgptAccess: (credentials: Credentials, signal: AbortSignal) => Promise<{ value: string; expiresAt: number }>,
): CredentialSource {
  return async (need, signal) => {
    try {
      if (need === "anthropic-key") {
        const value = await credentials.get("anthropic-key");
        signal.throwIfAborted();
        return value ? { value, expiresAt: null } : null;
      }
      return await chatgptAccess(credentials, signal);
    } catch {
      return null;
    }
  };
}
