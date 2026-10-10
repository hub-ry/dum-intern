// "Who powers Dum?" as data: which rows to show, what is preselected, and how each model reads.
// Pure, so the rules are tested without a window (docs/llm-setup-design.md §4.1-4.4).

import { BACKEND_LOGINS, CLAUDE_DEFAULTS, ROLES } from "../../agent/schema.ts";
import { RELEASED } from "../../agent/registry.ts";
import type { AgentChoice, BackendId, BackendStatus, LoginMethod, ModelOption, Role, Selector } from "../../agent/types.ts";

/** One backend as the sheet shows it, with only the sign-in methods Dum offers for it. */
export type BackendRow = Omit<BackendStatus, "methods" | "ready"> & { methods: LoginMethod[]; ready: LoginMethod | null };

const METHOD_LABELS: Record<LoginMethod, string> = {
  "anthropic-key": "Use an Anthropic API key",
  chatgpt: "Continue with ChatGPT",
  github: "Sign in with GitHub",
};

export const UNTESTED = "untested";

export function methodLabel(method: LoginMethod): string {
  return METHOD_LABELS[method];
}

/**
 * One row per released backend main reports, ready rows first. An unreleased backend's sign-in is
 * never offered, and a method the backend doesn't take is never listed or shown as ready.
 */
export function backendRows(backends: readonly BackendStatus[]): BackendRow[] {
  const rows: BackendRow[] = [];
  for (const b of backends) {
    if (!RELEASED[b.id]) continue;
    const offered = BACKEND_LOGINS[b.id];
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

/** The intern needs function calling, the look needs image input, and the helper may be any listed model. */
export function roleModels(models: readonly ModelOption[], role: Role): ModelOption[] {
  if (role === "intern") return models.filter((m) => m.actions);
  if (role === "look") return models.filter((m) => m.images);
  return [...models];
}

/** A model as the picker lists it: its label, and "untested" until Dum has proven it on this backend. */
export function modelText(model: ModelOption): string {
  return model.verified ? model.label : `${model.label} · ${UNTESTED}`;
}

/** What a helper without image input can't do, or "" when it can see pictures. */
export function helperWarning(model: ModelOption | null): string {
  return model && !model.images ? "This helper can't see pictures, so pictures you share won't work with it." : "";
}

/** What an unverified look model means for screen looks, or "" when it is verified. */
export function lookWarning(model: ModelOption | null): string {
  return model && !model.verified ? "Dum won't send this model pictures until it is verified, so the look runs on text alone." : "";
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

/** A complete choice, or null while any role is unpicked or picked on another backend. */
export function buildChoice(backend: BackendId | null, login: LoginMethod | null, picks: Readonly<Record<Role, Selector | null>>): AgentChoice | null {
  if (!backend || !login) return null;
  for (const role of ROLES) if (picks[role]?.backend !== backend) return null;
  return { backend, login, intern: picks.intern!, helper: picks.helper!, look: picks.look! };
}
