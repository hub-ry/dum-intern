// Changes Dum wrote: the diff after the fact and one-click Revert (rule 6). Revert is refused by the
// host if the file moved on since the change (rule 7); the button only asks.

import type { Snapshot } from "../protocol.ts";
import type { ChangeReceipt } from "../../zone-types.ts";
import { h, icon, type Client } from "./dom.ts";

export function diffBody(diff: string): HTMLElement {
  const pre = h("pre", { class: "code diff" });
  for (const line of diff.split("\n")) {
    const cls = line.startsWith("@@") ? "hunk" : line.startsWith("+++") || line.startsWith("---") ? "file" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    pre.append(h("span", { class: `dl ${cls}` }, line), "\n");
  }
  return pre;
}

/** Revert for one change; disabled once the change can no longer be restored or nothing is open to bind it to. */
export function revertButton(client: Client, change: ChangeReceipt | undefined, changeId: string): HTMLButtonElement {
  const live = !!change?.revertible && !!client.snap?.binding;
  return h(
    "button",
    {
      type: "button",
      class: "btn small",
      disabled: !live,
      title: change && !change.revertible ? "This change can't be reverted any more" : "Put the file back the way it was",
      onclick: () => {
        const binding = client.snap?.binding;
        if (binding) void client.call({ type: "change-revert", changeId, binding });
      },
    },
    icon("undo"),
    "Revert",
  );
}

/** Records → Changes: this zone's changes, newest first, each with its diff, Revert and its record. */
export class ChangesPane {
  readonly el = h("div", { class: "changes" });
  private key = "";

  constructor(private client: Client) {}

  update(s: Snapshot) {
    const key = JSON.stringify(s.changes) + String(!!s.binding);
    if (key === this.key) return;
    this.key = key;
    if (!s.activeZone) {
      this.el.replaceChildren(h("p", { class: "muted" }, "Enter a zone to see the changes Dum made there."));
      return;
    }
    if (!s.changes.length) {
      this.el.replaceChildren(h("p", { class: "muted" }, "Dum hasn't changed any file in this zone. When it does, the diff shows here with a Revert button."));
      return;
    }
    this.el.replaceChildren(
      h("p", { class: "hint" }, "Dum writes a change only when you ask and your skills allow it. Revert puts the file back, unless you've edited it since."),
      h(
        "ul",
        { class: "change-list" },
        ...s.changes.map((c) =>
          h(
            "li",
            { class: "change" },
            h(
              "details",
              {},
              h("summary", {}, icon("chevron"), h("code", {}, c.target), h("span", { class: "muted small" }, new Date(c.appliedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })), c.revertible ? null : h("span", { class: "chip chip-muted" }, "not revertible")),
              diffBody(c.diff),
            ),
            h(
              "div",
              { class: "actions" },
              revertButton(this.client, c, c.id),
              h("button", { type: "button", class: "link-btn", onclick: () => void this.client.call({ type: "open-record", record: "change", id: c.id }) }, icon("external"), h("span", {}, "open the change record")),
            ),
          ),
        ),
      ),
    );
  }
}
