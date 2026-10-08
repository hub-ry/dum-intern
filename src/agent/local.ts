// Models that stay on this Mac: Ollama and LM Studio over loopback, driven by Dum's own loop.
// Discovery and setup live in local-setup.ts; this module is the host's backend.

import { loopSession } from "./loop.ts";
import { chatCompletionsClient } from "./openai-compatible.ts";
import { LOCAL_ENDPOINTS, NAMES, SERVERS, catalog, cloudTagged, loopbackBase, refused, type LocalEndpoints, type LocalServer } from "./local-setup.ts";
import type { AgentBackend, Capabilities, ModelOption } from "./types.ts";

const CLOUD = "Dum requires a model that stays on this Mac";

/** Selector model ids are `<server>/<model>`, e.g. `ollama/qwen3:8b`. */
export function parseModel(id: string): { server: LocalServer; model: string } {
  const slash = id.indexOf("/");
  const server = id.slice(0, slash);
  const model = id.slice(slash + 1);
  if (slash < 0 || !model || (server !== "ollama" && server !== "lmstudio")) throw new Error(`${id} isn't a local model`);
  return { server, model };
}

export function localBackend(endpoints: LocalEndpoints = LOCAL_ENDPOINTS): AgentBackend {
  for (const server of SERVERS) loopbackBase(endpoints[server]);
  const known = new Map<string, ModelOption>();
  const backend: AgentBackend = {
    id: "local",
    label: "On this Mac",
    async models(login, signal) {
      if (login !== "none") throw new Error("Local models need no sign-in");
      const out: ModelOption[] = [];
      for (const server of SERVERS) {
        try {
          out.push(...await catalog(endpoints, server, signal));
        } catch (e) {
          signal.throwIfAborted();
          if (!refused(e)) throw e;
        }
      }
      known.clear();
      for (const m of out) known.set(m.id, m);
      return out;
    },
    async capabilities(selector, login, signal): Promise<Capabilities> {
      const option = known.get(selector.model) ?? (await backend.models(login, signal)).find((m) => m.id === selector.model);
      const images = option?.images ?? false;
      return {
        model: selector.model, images, noImages: images ? "" : `${selector.model} can't see pictures`, interrupt: true, runtimeActionCheck: false,
      };
    },
    async open(o) {
      if (o.login !== "none") throw new Error("Local models need no sign-in");
      if (o.selector.backend !== "local") throw new Error(`${o.selector.backend} isn't the local backend`);
      const { server, model } = parseModel(o.selector.model);
      if (server === "ollama" && cloudTagged(model)) throw new Error(CLOUD);
      let options: ModelOption[];
      try {
        options = await catalog(endpoints, server, o.signal);
      } catch (e) {
        if (refused(e)) throw new Error(`${NAMES[server]} isn't running. Start ${NAMES[server]}, then check again.`);
        throw e;
      }
      for (const m of options) known.set(m.id, m);
      const option = options.find((m) => m.id === o.selector.model);
      if (!option) throw new Error(server === "ollama" ? `${model} isn't on this Mac in Ollama, or it runs in the cloud. ${CLOUD}.` : `${model} isn't available in LM Studio`);
      if (o.actions.length && !option.actions) throw new Error(`${model} can't call actions, so it can only be a helper`);
      if (o.selector.effort !== null && !option.efforts.includes(o.selector.effort)) throw new Error(`${model} doesn't offer effort ${o.selector.effort}`);
      const session = loopSession(chatCompletionsClient(endpoints[server]), o);
      return {
        async *turn(input) {
          if (input.images?.length && !option.images) {
            yield { type: "end", error: "The selected local model cannot see pictures", interrupted: false };
            return;
          }
          yield* session.turn(input);
        },
        interrupt: () => session.interrupt(),
        close: () => session.close(),
      };
    },
  };
  return backend;
}
