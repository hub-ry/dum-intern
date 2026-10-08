// The host's backends and the user's choice. No fallback: no choice, or an unavailable backend, is an error.

import type { AgentBackend, AgentChoice, BackendId, Role, Selector } from "./types.ts";

/** Which backends users can see. ChatGPT flips at its release gate; Copilot after its probe. */
export const RELEASED: Readonly<Record<BackendId, boolean>> = { claude: true, local: true, chatgpt: false, copilot: false };

export type Registry = {
  /** Throws for an unregistered or unreleased id. */
  backend(id: BackendId): AgentBackend;
  /** The validated copy main sends; throws when its backend is unavailable. */
  set(choice: AgentChoice | null): void;
  /** Throws "Choose who powers Dum" when none. */
  chosen(): AgentChoice;
  selector(role: Role): Selector;
};

export function createRegistry(backends: readonly AgentBackend[], released: ReadonlySet<BackendId>): Registry {
  const byId = new Map<BackendId, AgentBackend>();
  for (const b of backends) {
    if (byId.has(b.id)) throw new Error(`${b.id} is registered twice`);
    byId.set(b.id, b);
  }
  let choice: AgentChoice | null = null;
  const registry: Registry = {
    backend(id) {
      const found = byId.get(id);
      if (!found) throw new Error(`${id} isn't available in this build`);
      if (!released.has(id)) throw new Error(`${id} isn't released yet`);
      return found;
    },
    set(next) {
      if (next) registry.backend(next.backend);
      choice = next;
    },
    chosen() {
      if (!choice) throw new Error("Choose who powers Dum");
      return choice;
    },
    selector(role) {
      return registry.chosen()[role];
    },
  };
  return registry;
}
