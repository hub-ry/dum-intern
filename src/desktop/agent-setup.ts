// Who powers Dum, on main's side (docs/llm-setup-design.md §4): each released backend's status and
// sign-in, the write-only Anthropic key, and the validated choice. Main never opens a model session:
// the model catalog comes from the host, and the host gets main's persisted copy of the choice.

import { AgentChoiceSchema, BACKEND_LOGINS, BackendStatusSchema, CLAUDE_DEFAULTS, ROLES } from "../agent/schema.ts";
import type {
  AgentChoice, BackendId, BackendSetup, BackendStatus, CredentialSource, LoginMethod, LoginUi, ModelOption, Role, Selector,
} from "../agent/types.ts";
import type { Credentials } from "./credentials.ts";
import type { DesktopPreferences } from "./protocol.ts";

/** What a selection goes through after validation: the host's live catalog, main's settings, then the host's copy. */
export type SelectPorts = {
  models(backend: BackendId, login: LoginMethod): Promise<ModelOption[]>;
  settings: { get(): DesktopPreferences; set(p: DesktopPreferences): void };
  send(choice: AgentChoice): Promise<void>;
};

const KEY_REFUSED = "That key wasn't saved. Check it and paste it again.";

const LABELS: Record<BackendId, string> = { claude: "Claude", chatgpt: "ChatGPT", copilot: "GitHub Copilot" };

/** How a row reads before or without a status: never anything a backend said that might echo a secret. */
function unknown(id: BackendId): BackendStatus {
  return { id, label: LABELS[id], installed: false, methods: BACKEND_LOGINS[id], ready: null, loginRunning: false, message: "Dum couldn't check this one. Check again." };
}

export class AgentSetup {
  private readonly byId = new Map<BackendId, BackendSetup>();
  private statuses: BackendStatus[] = [];
  /** The setup whose sign-in is running, for cancel. */
  private active: BackendSetup | null = null;
  private checking: Promise<void> | null = null;
  private again = false;

  constructor(setups: readonly BackendSetup[], private readonly released: ReadonlySet<BackendId>) {
    for (const s of setups) {
      if (this.byId.has(s.id)) throw new Error(`${s.id} is set up twice`);
      if (released.has(s.id)) this.byId.set(s.id, s);
    }
    this.statuses = [...this.byId.values()].map((s) => unknown(s.id));
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
          const methods = BACKEND_LOGINS[s.id];
          if (r.status === "rejected") return unknown(s.id);
          const parsed = BackendStatusSchema.safeParse(r.value);
          if (!parsed.success || parsed.data.id !== s.id) return unknown(s.id);
          // The backend's own sign-in list decides the methods, whatever a backend reports.
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
   * for minutes in the browser. Claude has no sign-in: it takes only an Anthropic API key.
   */
  login(backend: BackendId, method: LoginMethod, ui: LoginUi): Promise<void> {
    const setup = this.setup(backend);
    this.offered(backend, method);
    if (method === "anthropic-key") throw new Error("Paste your Anthropic API key instead of signing in");
    if (this.active && this.active !== setup) this.active.cancelLogin();
    this.active = setup;
    return setup.login(method, ui);
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

  /** The host's catalog for one backend and method; the backend must be released and take the method. */
  async models(backend: BackendId, login: LoginMethod, ports: Pick<SelectPorts, "models">): Promise<ModelOption[]> {
    this.setup(backend);
    this.offered(backend, login);
    return ports.models(backend, login);
  }

  /**
   * Validate a choice against the host's live catalog for every role, persist it in main's settings,
   * then send the host its copy. A choice that fails any step changes nothing saved.
   */
  async select(raw: AgentChoice, ports: SelectPorts): Promise<AgentChoice> {
    const parsed = AgentChoiceSchema.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "That choice isn't offered in this build");
    const choice = parsed.data;
    this.setup(choice.backend);
    const catalog = await ports.models(choice.backend, choice.login);
    for (const role of ROLES) {
      const problem = unfit(catalog, choice[role], role);
      if (problem) throw new Error(problem);
    }
    const prefs = ports.settings.get();
    ports.settings.set({ ...prefs, agent: choice });
    await ports.send(choice);
    return choice;
  }

  /**
   * The explicit migration for saved selectors whose id the live catalog no longer lists (Dum once saved
   * full ids such as claude-opus-5-5; Claude lists aliases such as opus that resolve to them). Each such
   * role moves to the listed row that runs the same model at the saved effort, preferring Dum's default
   * id for that role. Either every unlisted role maps and the choice is saved, or nothing changes and the
   * sentence asks the user to choose again; never a different model. Null when nothing needs saying,
   * including when the catalog can't be read yet.
   */
  async reconcile(ports: SelectPorts): Promise<string | null> {
    const prefs = ports.settings.get();
    const saved = prefs.agent;
    if (!saved || !this.byId.has(saved.backend)) return null;
    let catalog: ModelOption[];
    try {
      catalog = await ports.models(saved.backend, saved.login);
    } catch {
      return null;
    }
    const next: AgentChoice = { ...saved };
    const moved: string[] = [];
    const lost: Role[] = [];
    for (const role of ROLES) {
      const selector = saved[role];
      if (catalog.some((m) => m.id === selector.model)) continue;
      const same = catalog.filter((m) => m.resolved === selector.model && !unfit([m], { ...selector, model: m.id }, role));
      const preferred = saved.backend === "claude" ? same.find((m) => m.id === CLAUDE_DEFAULTS[role].model) : undefined;
      const row = preferred ?? same[0];
      if (!row) {
        lost.push(role);
        continue;
      }
      next[role] = { ...selector, model: row.id };
      const change = `${selector.model} → ${row.id}`;
      if (!moved.includes(change)) moved.push(change);
    }
    const label = LABELS[saved.backend];
    if (lost.length) {
      const roles = lost.length === 1 ? `${lost[0]} model` : `${lost.slice(0, -1).join(", ")} and ${lost.at(-1)} models`;
      return `${label} no longer lists Dum's saved ${roles}. Choose the ${roles} again in Settings › Agent.`;
    }
    if (!moved.length) return null;
    ports.settings.set({ ...prefs, agent: next });
    await ports.send(next);
    return `Dum's saved models now use the names ${label} lists: ${moved.join(", ")}.`;
  }

  private setup(id: BackendId): BackendSetup {
    const found = this.byId.get(id);
    if (!found) throw new Error(this.released.has(id) ? `${id} isn't available in this build` : `${id} isn't released yet`);
    return found;
  }

  private offered(backend: BackendId, method: LoginMethod): void {
    if (!BACKEND_LOGINS[backend].includes(method)) throw new Error(`${LABELS[backend]} doesn't sign in with ${method}`);
  }
}

/**
 * Why a selector can't fill a role, or null: it must name a listed model at an effort it advertises;
 * the intern needs actions and the look needs pictures.
 */
function unfit(catalog: readonly ModelOption[], selector: Selector, role: Role): string | null {
  const option = catalog.find((m) => m.id === selector.model);
  if (!option) return `${selector.model} isn't in ${selector.backend}'s model list - choose again`;
  if (role === "intern" && !option.actions) return `${option.label} can't call Dum's actions, so it can't be the intern`;
  if (role === "look" && !option.images) return `${option.label} can't look at pictures, so it can't be the look`;
  const effortOk = option.efforts.length === 0 ? selector.effort === null : selector.effort !== null && option.efforts.includes(selector.effort);
  return effortOk ? null : `${option.label} doesn't offer ${selector.effort ?? "the default"} effort`;
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
