// `dum workday-mcp`: the Workday agent's only tools, served on hub. The browser tools are passed
// to the worker in the VM as they are; request_submit asks the worker to park a submit for the
// review page and puts it in front of Ryan as an approval card in Discord. Nothing here can
// submit: only Ryan's button makes the signed approval the worker needs (approval.ts).

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSIONS } from "../mcp/server.ts";
import { createRequest, listRequests } from "../shared/requests.ts";
import { WorkerError, type WorkerApi } from "./api.ts";
import { updateJob } from "./jobs.ts";

type Json = Record<string, unknown>;

const field = { type: "string", maxLength: 20, description: "A field key from the latest listing, like f3." };

export const TOOLS = [
  {
    name: "open_application",
    title: "Open an application",
    description: "Open a Workday application page by URL (allowlisted sites only). Returns the page as text: fields with keys, buttons, page text, and the profile values and secret placeholders you can fill with.",
    inputSchema: { type: "object", properties: { url: { type: "string", maxLength: 2000 } }, required: ["url"] },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "fill_from_profile",
    title: "Fill fields",
    description: "Type values into listed fields. A value may use {{profile.x}} placeholders, or be exactly one secret placeholder like {{SSN}} (the worker types the real value; you never see it). Checkboxes and radio options take \"check\"; selects take an option's text.",
    inputSchema: {
      type: "object",
      properties: { fields: { type: "array", maxItems: 40, items: { type: "object", properties: { field, value: { type: "string", maxLength: 4000 } }, required: ["field", "value"] } } },
      required: ["fields"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "upload_resume",
    title: "Attach the résumé",
    description: "Attach one of Ryan's résumé files (default unless you name another from the profile) to a file field, or to the page's first file field.",
    inputSchema: { type: "object", properties: { field, resume: { type: "string", maxLength: 40 } } },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "screenshot",
    title: "Read the page again",
    description: "Re-read the current page (fields, buttons, text) and save a screenshot with secrets covered, for Ryan. You get text, not the image.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "next_step",
    title: "Next step",
    description: "Press the page's Next / Save and Continue button, or another listed button by its exact text (e.g. \"Apply Manually\"). Never presses Submit.",
    inputSchema: { type: "object", properties: { button: { type: "string", maxLength: 80 } } },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "request_submit",
    title: "Ask Ryan to submit",
    description: "On the review page: ask Ryan in Discord to approve submitting this application, with a screenshot. Only his approval submits it. After this you're done.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
];

export type WorkdayMcpOptions = {
  worker: WorkerApi;
  requestsDir: string;
  /** Who is asking, shown on the card. */
  requestedBy: string;
  /** Goal whose channel gets the card; empty for the lobby. */
  goalId: string;
  /** The job this agent run works on, so the approval request is linked to it. */
  job?: { dir: string; id: string };
};

export function createWorkdayMcp(o: WorkdayMcpOptions): (msg: unknown) => Promise<Json | null> {
  async function requestSubmit(): Promise<string> {
    const prep = await o.worker.prepareSubmit();
    const same = listRequests(o.requestsDir).find((r) => r.kind === "workday-submit" && r.status === "pending" && r.workday?.nonce === prep.nonce);
    if (same) return `Already waiting for Ryan to approve this submit (request ${same.id}). You're done with this application.`;
    mkdirSync(o.requestsDir, { recursive: true, mode: 0o700 });
    const screenshot = `${prep.nonce}.png`;
    // The picture goes down first, so the card never goes out without it.
    writeFileSync(join(o.requestsDir, screenshot), Buffer.from(prep.screenshotPng, "base64"), { mode: 0o600 });
    const req = createRequest(o.requestsDir, {
      kind: "workday-submit",
      goalId: o.goalId,
      concept: `Submit: ${prep.title}`.slice(0, 160),
      text: prep.summary,
      requestedBy: o.requestedBy,
      workday: { nonce: prep.nonce, fingerprint: prep.fingerprint, url: prep.url, screenshot },
    });
    if (o.job) updateJob(o.job.dir, o.job.id, { status: "awaiting_approval", requestId: req.id });
    return `Asked Ryan in Discord to approve submitting this application (request ${req.id}). It is submitted only if he presses Submit on that card. You're done with this application.`;
  }

  async function call(name: unknown, args: Json): Promise<{ text: string; isError: boolean }> {
    if (name === "request_submit") return { text: await requestSubmit(), isError: false };
    if (typeof name === "string" && TOOLS.some((t) => t.name === name)) return o.worker.call(name, args);
    return { text: `Unknown tool ${String(name)}.`, isError: true };
  }

  return async function handle(msg: unknown): Promise<Json | null> {
    const m = (msg ?? {}) as { id?: string | number | null; method?: string; params?: Json };
    const isRequest = m.id !== undefined && m.id !== null;
    const reply = (result: Json) => (isRequest ? { jsonrpc: "2.0", id: m.id, result } : null);
    switch (m.method) {
      case "initialize": {
        const asked = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "";
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "workday", title: "Workday applications, prefill only (via dum)", version: "1.0.0" },
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call":
        try {
          const r = await call(m.params?.name, (m.params?.arguments ?? {}) as Json);
          return reply({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
        } catch (err) {
          const text = err instanceof WorkerError ? err.message : `The Workday worker failed: ${(err as Error).message.split("\n")[0]}`;
          return reply({ content: [{ type: "text", text }], isError: true });
        }
      default:
        if (typeof m.method === "string" && m.method.startsWith("notifications/")) return null;
        return isRequest ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${String(m.method)}` } } : null;
    }
  };
}
