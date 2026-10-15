// `dum mailcode-mcp`: the mail agent's only tools. list_mail shows recent emails (sender, subject,
// time) inside a window; read_mail opens one of those. The window is the boundary: when the watcher
// starts it for a request, DUM_MAIL_SINCE pins it to mail that arrived after the request, so the
// agent can't browse the rest of the inbox. read_mail only opens emails list_mail already showed.

import { MailError, openMailbox, type Mailbox, type MailSummary } from "./outlook.ts";
import { PROTOCOL_VERSIONS } from "../mcp/server.ts";

type Json = Record<string, unknown>;

/** How many of the newest emails list_mail looks at. */
export const SCAN = 50;
export const DEFAULT_WITHIN_MINUTES = 15;
export const MAX_WITHIN_MINUTES = 24 * 60;
/** Enough for any code email; keeps a long newsletter from flooding the agent. */
const MAX_BODY = 6000;

const TOOLS = [
  {
    name: "list_mail",
    title: "Recent emails",
    description: "Emails in Ryan's Purdue Outlook, Inbox and Junk together, inside your window, newest first: id, sender name and address, subject, when it arrived. No bodies; open one with read_mail.",
    inputSchema: { type: "object", properties: { within_minutes: { type: "number", description: `How far back (default ${DEFAULT_WITHIN_MINUTES}, max ${MAX_WITHIN_MINUTES}). Ignored when the window is fixed for a request.` } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "read_mail",
    title: "Open an email",
    description: "The text of one email from list_mail, by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

/** The email list as the agent sees it. */
function listing(messages: MailSummary[], now: number): string {
  if (!messages.length) return "No emails in the window yet.";
  return messages
    .map((m) => `- id ${m.id}\n  folder: ${m.folder}\n  from: ${m.from || "?"} <${m.address || "?"}>\n  subject: ${m.subject || "(none)"}\n  arrived: ${Math.max(0, Math.round((now - Date.parse(m.receivedAt)) / 60_000))} min ago`)
    .join("\n");
}

/** The mail tools' JSON-RPC handler, plus close() for the browser behind it. */
export type MailcodeMcp = ((msg: unknown) => Promise<Json | null>) & { close(): Promise<void> };

/** One JSON-RPC message in, its response out. `fixedSince` (ms) pins the window for a request. */
export function createMailcodeMcp(opts: { open?: () => Promise<Mailbox>; fixedSince?: number; now?: () => number } = {}): MailcodeMcp {
  const open = opts.open ?? openMailbox;
  const now = opts.now ?? (() => Date.now());
  let box: Promise<Mailbox> | null = null;
  const shown = new Set<string>();

  async function call(name: unknown, args: Json): Promise<string> {
    box ??= open();
    const mailbox = await box;
    if (name === "list_mail") {
      const raw = typeof args.within_minutes === "number" && Number.isFinite(args.within_minutes) ? args.within_minutes : DEFAULT_WITHIN_MINUTES;
      const since = opts.fixedSince ?? now() - Math.min(Math.max(raw, 1), MAX_WITHIN_MINUTES) * 60_000;
      const messages = (await mailbox.recent(SCAN)).filter((m) => Date.parse(m.receivedAt) >= since);
      for (const m of messages) shown.add(m.id);
      return listing(messages, now());
    }
    if (name === "read_mail") {
      const id = typeof args.id === "string" ? args.id : "";
      if (!shown.has(id)) throw new MailError("Only emails from list_mail can be opened.");
      const body = (await mailbox.body(id)).replace(/\n{3,}/g, "\n\n").trim();
      return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n[... cut]` : body || "(empty)";
    }
    throw new MailError(`Unknown tool ${String(name)}.`);
  }

  async function handle(msg: unknown): Promise<Json | null> {
    const m = (msg ?? {}) as { id?: string | number | null; method?: string; params?: Json };
    const isRequest = m.id !== undefined && m.id !== null;
    const reply = (result: Json) => (isRequest ? { jsonrpc: "2.0", id: m.id, result } : null);
    switch (m.method) {
      case "initialize": {
        const asked = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "";
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mailcode", title: "Ryan's Purdue mail, read-only (via dum)", version: "2.0.0" },
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call":
        try {
          return reply({ content: [{ type: "text", text: await call(m.params?.name, (m.params?.arguments ?? {}) as Json) }] });
        } catch (err) {
          const text = err instanceof MailError ? err.message : `Couldn't read Outlook: ${(err as Error).message}`;
          return reply({ content: [{ type: "text", text }], isError: true });
        }
      default:
        if (typeof m.method === "string" && m.method.startsWith("notifications/")) return null;
        return isRequest ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${String(m.method)}` } } : null;
    }
  }

  return Object.assign(handle, {
    async close() {
      if (box) await (await box.catch(() => null))?.close();
    },
  });
}
