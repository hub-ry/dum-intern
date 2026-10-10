// Settings → Agent ("Who powers Dum?"): pick a released backend, save its API key, then pick the
// intern, helper and look models. The renderer never sees a key after sending it, and main checks
// every choice again against the backend's sign-ins and the live catalog.

import type { Snapshot } from "../protocol.ts";
import { ROLES } from "../../agent/schema.ts";
import type { BackendId, LoginMethod, ModelOption, Role, Selector } from "../../agent/types.ts";
import { h, icon, type Client } from "./dom.ts";
import {
  backendRows, buildChoice, helperWarning, lookWarning, methodLabel, modelText, pickEffort, preselectedBackend, preselectedLogin, preselectedSelector, roleModels,
  type BackendRow,
} from "./agent-picker.ts";

type Catalog = { state: "loading" } | { state: "ready"; models: ModelOption[] } | { state: "error"; message: string };
/** One verify call at a time, keyed by role and model id; its result stays inline until the pick changes. */
type Verify = { key: string } & ({ state: "busy" } | { state: "done" } | { state: "error"; message: string });

export const VERIFY_LABEL = "Verify for pictures (one small call)";

const ROLE_TEXT: Record<Role, { title: string; hint: string }> = {
  intern: { title: "Dum's model", hint: "Runs the conversation and handoffs; needs function calling." },
  helper: { title: "Helper model", hint: "Writes the Wizard's options and reads shared pictures." },
  look: { title: "Look model", hint: "Gets one screen frame per change. A small fast model keeps it cheap." },
};

export class AgentSheet {
  readonly el: HTMLElement;
  private body = h("div", { class: "agent-body" });
  private backend: BackendId | null = null;
  private login = new Map<BackendId, LoginMethod>();
  private catalogs = new Map<string, Catalog>();
  private picks: Record<Role, Selector | null> = { intern: null, helper: null, look: null };
  private picksFor = "";
  private verify: Verify | null = null;
  private key = "";
  private keyInput = h("input", { class: "input", type: "password", autocomplete: "off", spellcheck: "false", "aria-label": "Anthropic API key", "data-focus": "key", placeholder: "sk-ant-…" });

  /** Settings → Agent. */
  constructor(private client: Client) {
    this.el = h(
      "section",
      { class: "agent-sheet", "aria-labelledby": "agent-title" },
      h("h3", { id: "agent-title", tabindex: "-1", class: "visually-hidden" }, "Agent"),
      h("p", { class: "hint" }, "Who runs Dum and the Wizard. Changing it ends the open conversation."),
      this.body,
    );
  }

  focus() {
    this.el.querySelector<HTMLElement>("[tabindex='-1']")?.focus();
  }

  update(s: Snapshot) {
    const rows = backendRows(s.agent.backends);
    if (this.backend === null || !rows.some((r) => r.id === this.backend)) this.backend = preselectedBackend(rows, s.agent.chosen);
    const row = rows.find((r) => r.id === this.backend) ?? null;
    if (row && !this.login.has(row.id)) {
      const login = preselectedLogin(row, s.agent.chosen);
      if (login) this.login.set(row.id, login);
    }
    const login = row ? this.login.get(row.id) ?? null : null;
    if (row && login && row.ready === login) this.ensureCatalog(row.id, login);
    const catalog = row && login ? this.catalogs.get(`${row.id}:${login}`) : undefined;
    const pickKey = `${row?.id}:${login}`;
    if (pickKey !== this.picksFor) {
      this.picksFor = pickKey;
      this.picks = { intern: null, helper: null, look: null };
    }
    if (row && catalog?.state === "ready") {
      for (const role of ROLES) this.picks[role] ??= preselectedSelector(row.id, role, catalog.models, s.agent.chosen);
    }
    const key = JSON.stringify([s.agent, this.backend, login, catalog, this.picks, this.verify]);
    if (key === this.key) return;
    this.key = key;
    const inside = this.el.contains(document.activeElement) ? document.activeElement : null;
    const focusId = inside instanceof HTMLElement ? inside.dataset.focus : undefined;
    this.draw(rows, row, login, catalog);
    if (focusId) this.el.querySelector<HTMLElement>(`[data-focus="${focusId}"]`)?.focus();
  }

  private redraw() {
    this.key = "";
    if (this.client.snap) this.update(this.client.snap);
  }

  private ensureCatalog(backend: BackendId, login: LoginMethod) {
    const id = `${backend}:${login}`;
    if (this.catalogs.has(id)) return;
    this.catalogs.set(id, { state: "loading" });
    void this.client.call({ type: "agent-models", backend, login }, true).then((r) => {
      this.catalogs.set(id, r.ok ? { state: "ready", models: r.models ?? [] } : { state: "error", message: r.error });
      this.redraw();
    });
  }

  private draw(rows: BackendRow[], row: BackendRow | null, login: LoginMethod | null, catalog: Catalog | undefined) {
    const check = h("button", {
      type: "button", class: "btn ghost", "data-focus": "check",
      onclick: () => {
        this.catalogs.clear();
        void this.client.call({ type: "agent-check" });
      },
    }, icon("refresh"), "Check again");
    if (!rows.length) {
      this.body.replaceChildren(h("p", { class: "muted" }, "No backend is available."), h("div", { class: "actions" }, check));
      return;
    }
    const list = h(
      "div",
      { class: "backend-rows", role: "radiogroup", "aria-label": "Backend" },
      ...rows.map((r) => {
        const radio = h("input", {
          type: "radio", name: "backend", value: r.id, checked: r.id === this.backend, "data-focus": `backend-${r.id}`,
          onchange: () => {
            this.backend = r.id;
            this.redraw();
          },
        });
        return h(
          "label",
          { class: `backend-row${r.id === this.backend ? " picked" : ""}` },
          radio,
          h("span", { class: "backend-label" }, r.label),
          r.ready ? h("span", { class: "chip chip-ok" }, "signed in") : !r.installed ? h("span", { class: "chip chip-bad" }, "unavailable") : h("span", { class: "chip chip-muted" }, "not set up"),
          r.message ? h("span", { class: "backend-message hint" }, r.message) : null,
        );
      }),
    );
    const parts: Node[] = [list];
    if (row) {
      parts.push(this.signIn(row, login));
      if (login && row.ready === login) parts.push(this.models(row, login, catalog));
    }
    parts.push(h("div", { class: "actions" }, check));
    this.body.replaceChildren(...parts);
  }

  private signIn(row: BackendRow, login: LoginMethod | null): HTMLElement {
    const box = h("div", { class: "sign-in", role: "group", "aria-label": `Sign in to ${row.label}` });
    if (row.methods.length > 1) {
      box.append(
        h(
          "div",
          { class: "methods", role: "radiogroup", "aria-label": "Sign-in method" },
          ...row.methods.map((m) =>
            h(
              "label",
              { class: "check" },
              h("input", {
                type: "radio", name: `method-${row.id}`, value: m, checked: m === login, "data-focus": `method-${m}`,
                onchange: () => {
                  this.login.set(row.id, m);
                  this.redraw();
                },
              }),
              h("span", {}, methodLabel(m)),
              row.ready === m ? h("span", { class: "chip chip-ok" }, "signed in") : null,
            ),
          ),
        ),
      );
    }
    if (login !== "anthropic-key") return box;
    if (row.ready === login) {
      box.append(
        h("p", { class: "hint" }, "An API key is saved. Dum never shows it again. Calls are billed to your Anthropic account."),
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn ghost", "data-focus": "signout", onclick: () => void this.client.call({ type: "agent-signout", backend: row.id, method: login }) }, "Remove key")),
      );
    }
    const form = h(
      "form",
      { class: "inline-form" },
      h("label", { class: "field" }, h("span", {}, row.ready === login ? "Replace the key" : "Anthropic API key"), this.keyInput),
      h("button", { type: "submit", class: "btn primary" }, icon("key"), "Save key"),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const key = this.keyInput.value.trim();
      this.keyInput.value = "";
      if (!key) return this.keyInput.focus();
      void this.client.call({ type: "agent-key", backend: "claude", key });
    });
    box.append(form, h("p", { class: "hint" }, "The key goes to Dum's encrypted store on this Mac and is used only for Dum's own Claude sessions."));
    return box;
  }

  private models(row: BackendRow, login: LoginMethod, catalog: Catalog | undefined): HTMLElement {
    const box = h("div", { class: "model-picker", role: "group", "aria-label": "Models" });
    if (!catalog || catalog.state === "loading") {
      box.append(h("p", { class: "muted" }, "Reading the models you can use…"));
      return box;
    }
    if (catalog.state === "error") {
      box.append(h("div", { class: "notice bad" }, icon("warning"), h("span", {}, catalog.message)));
      return box;
    }
    for (const role of ROLES) box.append(this.rolePicker(row.id, role, roleModels(catalog.models, role)));
    const choice = buildChoice(row.id, login, this.picks);
    const chosen = this.client.snap?.agent.chosen;
    const same = !!choice && JSON.stringify(choice) === JSON.stringify(chosen);
    box.append(
      h(
        "div",
        { class: "actions" },
        h("button", {
          type: "button", class: "btn primary", "data-focus": "use", disabled: !choice || same,
          onclick: () => choice && void this.client.call({ type: "agent-select", choice }),
        }, same ? "In use" : "Save"),
      ),
    );
    return box;
  }

  private rolePicker(backend: BackendId, role: Role, models: ModelOption[]): HTMLElement {
    const pick = this.picks[role];
    const current = models.find((m) => m.id === pick?.model) ?? null;
    const select = h(
      "select",
      { class: "input", "aria-label": ROLE_TEXT[role].title, "data-focus": `${role}-model` },
      h("option", { value: "", selected: !current, disabled: true }, models.length ? "choose a model" : "no model can do this"),
      ...models.map((m) => h("option", { value: m.id, selected: m.id === current?.id }, modelText(m))),
    );
    select.addEventListener("change", () => {
      const m = models.find((x) => x.id === select.value);
      this.picks[role] = m ? { backend, model: m.id, effort: pickEffort(m, pick?.effort ?? null) } : null;
      this.redraw();
    });
    const effort = current?.efforts.length
      ? h("select", { class: "input", "aria-label": `${ROLE_TEXT[role].title} effort`, "data-focus": `${role}-effort` }, ...current.efforts.map((e) => h("option", { value: e, selected: e === pick?.effort }, e)))
      : null;
    effort?.addEventListener("change", () => {
      if (pick) this.picks[role] = { ...pick, effort: effort.value };
      this.redraw();
    });
    const caps = current ? [current.actions ? "function calling" : "no function calling", current.images ? "sees pictures" : "no pictures", current.verified ? "verified with Dum" : "untested with Dum"].join(" · ") : "";
    const warning = role === "helper" ? helperWarning(current) : role === "look" ? lookWarning(current) : "";
    return h(
      "div",
      { class: "role-picker" },
      h("h4", {}, ROLE_TEXT[role].title),
      h("div", { class: "role-selects" }, select, effort),
      caps ? h("p", { class: "hint" }, caps) : null,
      warning ? h("p", { class: "hint warn-text" }, icon("warning"), warning) : null,
      current && pick && backend === "claude" && (!current.verified || this.verify?.key === `${role}:${current.id}`) ? this.verifier(role, pick, current) : null,
      h("p", { class: "hint" }, ROLE_TEXT[role].hint),
    );
  }

  /**
   * Verify for pictures: one real picture call to the chosen Claude model. Success re-reads the catalog,
   * which then shows the row verified; a refusal or timeout changes nothing and its reason stays inline.
   */
  private verifier(role: Role, pick: Selector, model: ModelOption): HTMLElement {
    const key = `${role}:${model.id}`;
    const state = this.verify?.key === key ? this.verify : null;
    const button = model.verified ? null : h("button", {
      type: "button", class: "btn ghost", "data-focus": `${role}-verify`, disabled: state?.state === "busy",
      onclick: async () => {
        this.verify = { key, state: "busy" };
        this.redraw();
        const r = await this.client.call({ type: "agent-verify-images", backend: "claude", selector: pick }, true);
        if (r.ok) {
          this.verify = { key, state: "done" };
          // The host's catalog now lists the row verified; drop the copy so update() reads it again.
          this.catalogs.delete(`${pick.backend}:${this.login.get(pick.backend)}`);
        } else {
          this.verify = { key, state: "error", message: r.error };
        }
        this.redraw();
      },
    }, state?.state === "busy" ? "Verifying…" : VERIFY_LABEL);
    const result = state?.state === "done"
      ? h("span", { class: "hint" }, `${model.label} is verified for pictures on this Mac.`)
      : state?.state === "error" ? h("span", { class: "hint warn-text" }, icon("warning"), `Not verified: ${state.message}`) : null;
    return h("div", { class: "role-verify", "aria-live": "polite" }, button, result);
  }
}
