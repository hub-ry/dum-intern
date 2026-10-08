// "Who powers Dum?" as data: which rows to show, what is preselected, and how each model reads.
// Pure, so the rules are tested without a window (docs/llm-setup-design.md §4.1-4.4).

import { CLAUDE_DEFAULTS, offeredLogins } from "../../agent/schema.ts";
import type { AgentChoice, BackendId, BackendStatus, Flavor, LoginMethod, ModelOption, Role, Selector } from "../../agent/types.ts";

/** One backend as the sheet shows it, with only the sign-in methods this build offers. */
export type BackendRow = Omit<BackendStatus, "methods" | "ready"> & { methods: LoginMethod[]; ready: LoginMethod | null };

const METHOD_LABELS: Record<LoginMethod, string> = {
  "anthropic-key": "Use an Anthropic API key",
  "claude-subscription": "Sign in with Claude",
  chatgpt: "Continue with ChatGPT",
  github: "Sign in with GitHub",
  none: "No sign-in needed",
};

export const UNTESTED = "untested";

export function methodLabel(method: LoginMethod): string {
  return METHOD_LABELS[method];
}

/** One row per backend main reports, ready rows first. A method the flavor doesn't offer is never listed or shown as ready. */
export function backendRows(flavor: Flavor, backends: readonly BackendStatus[]): BackendRow[] {
  const rows: BackendRow[] = [];
  for (const b of backends) {
    const offered = offeredLogins(flavor, b.id);
    const methods = b.methods.filter((m) => offered.includes(m));
    if (!methods.length) continue;
    rows.push({ ...b, methods, ready: b.ready !== null && methods.includes(b.ready) ? b.ready : null });
  }
  return rows.map((row, i) => ({ row, i })).sort((a, b) => Number(b.row.ready !== null) - Number(a.row.ready !== null) || a.i - b.i).map((x) => x.row);
}

/** The saved backend if it is still listed, else the only ready row, else none. */
export function preselectedBackend(rows: readonly BackendRow[], chosen: AgentChoice | null): BackendId | null {
  if (chosen && rows.some((r) => r.id === chosen.backend)) return chosen.backend;
  const ready = rows.filter((r) => r.ready !== null);
  return ready.length === 1 ? ready[0]!.id : null;
}

/** The saved method for this backend, else the one that is signed in, else the only one offered. */
export function preselectedLogin(row: BackendRow, chosen: AgentChoice | null): LoginMethod | null {
  if (chosen?.backend === row.id && row.methods.includes(chosen.login)) return chosen.login;
  if (row.ready) return row.ready;
  return row.methods.length === 1 ? row.methods[0]! : null;
}

/** The intern needs function calling; the helper may be any listed model. */
export function roleModels(models: readonly ModelOption[], role: Role): ModelOption[] {
  return role === "intern" ? models.filter((m) => m.actions) : [...models];
}

/** A model as the picker lists it: its label, and "untested" until Dum has proven it on this backend. */
export function modelText(model: ModelOption): string {
  return model.verified ? model.label : `${model.label} · ${UNTESTED}`;
}

/** What a helper without image input can't do, or "" when it can see pictures. */
export function helperWarning(model: ModelOption | null): string {
  return model && !model.images ? "This helper can't see pictures, so screen look and shared pictures won't work with it." : "";
}

/** `wanted` when the model advertises it, else its first advertised effort, or null for a model without the knob. */
export function pickEffort(model: ModelOption, wanted: string | null): string | null {
  if (!model.efforts.length) return null;
  return wanted !== null && model.efforts.includes(wanted) ? wanted : model.efforts[0]!;
}

/** The saved selector when it is still offered for this role, else Claude's defaults on Claude, else nothing. */
export function preselectedSelector(backend: BackendId, role: Role, models: readonly ModelOption[], chosen: AgentChoice | null): Selector | null {
  const listed = roleModels(models, role);
  const from = (s: Selector): Selector | null => {
    const m = listed.find((x) => x.id === s.model);
    return m ? { backend, model: m.id, effort: pickEffort(m, s.effort) } : null;
  };
  const saved = chosen?.backend === backend ? from(chosen[role]) : null;
  if (saved) return saved;
  return backend === "claude" ? from(CLAUDE_DEFAULTS[role]) : null;
}

/** A complete choice, or null while anything is still unpicked. */
export function buildChoice(backend: BackendId | null, login: LoginMethod | null, intern: Selector | null, helper: Selector | null): AgentChoice | null {
  if (!backend || !login || !intern || !helper || intern.backend !== backend || helper.backend !== backend) return null;
  return { backend, login, intern, helper };
}
