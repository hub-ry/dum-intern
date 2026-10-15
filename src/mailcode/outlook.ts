// Reads recent mail from Ryan's Purdue Outlook for the mail agent. It reuses the Microsoft sign-in the
// pinned brightspace-mcp-server keeps on hub (same Purdue account), opens Outlook on the web headless,
// and calls Outlook's own FindItem/GetItem with that page's session. Read-only: it never saves the
// browser state, marks anything read, moves or sends anything.

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export type MailSummary = { id: string; folder: Folder; from: string; address: string; subject: string; receivedAt: string };

/** Where list_mail looks. Junk too, always: code emails from unfamiliar senders often land there. */
export const FOLDERS = { inbox: "inbox", junk: "junkemail" } as const;
export type Folder = keyof typeof FOLDERS;

const PKG = process.env.DUM_BRIGHTSPACE_DIR?.trim() || join(homedir(), "opt/brightspace-mcp");
const MODULES = join(PKG, "node_modules");
const BUILD = join(MODULES, "brightspace-mcp-server/build");

export class MailError extends Error {}

const SIGNED_OUT = "Outlook isn't signed in on hub. The Purdue sign-in is shared with Brightspace: run `~/opt/brightspace-mcp/bin/brightspace auth` on hub, then ask again.";

// The few pieces of the pinned package and its Playwright this needs. They live outside this repo
// (in ~/opt/brightspace-mcp, path set at runtime), so they're loaded dynamically and checked here.
type BrowserState = { cookies: unknown[]; origins: unknown[] };
type Request = { url(): string; headers(): Record<string, string>; resourceType(): string };
type Route = { request(): Request; continue(): Promise<void>; abort(): Promise<void> };
type Page = {
  on(event: "request", fn: (r: Request) => void): void;
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T, A>(fn: (a: A) => Promise<T>, arg: A): Promise<T>;
};
type Browser = { newContext(opts: { storageState: BrowserState }): Promise<{ route(glob: string, fn: (r: Route) => Promise<void>): Promise<void>; newPage(): Promise<Page> }>; close(): Promise<void> };
type Chromium = { launch(opts: { headless: boolean; args: string[] }): Promise<Browser> };

const ResponseMessage = z.object({ ResponseClass: z.string(), ResponseCode: z.string().optional() }).passthrough();
const Envelope = z.object({ Body: z.object({ ResponseMessages: z.object({ Items: z.array(ResponseMessage).min(1) }) }) });
const Found = z.object({
  RootFolder: z.object({
    Items: z.array(z.object({
      ItemId: z.object({ Id: z.string() }),
      Subject: z.string().optional(),
      DateTimeReceived: z.string().optional(),
      From: z.object({ Mailbox: z.object({ Name: z.string().optional(), EmailAddress: z.string().optional() }) }).optional(),
    })).default([]),
  }),
});
const Got = z.object({ Items: z.array(z.object({ Body: z.object({ Value: z.string().optional() }).optional() })).min(1) });

const HEADER = { __type: "JsonRequestHeaders:#Exchange", RequestServerVersion: "V2018_01_08", TimeZoneContext: { __type: "TimeZoneContext:#Exchange", TimeZoneDefinition: { __type: "TimeZoneDefinitionType:#Exchange", Id: "UTC" } } };
const prop = (FieldURI: string) => ({ __type: "PropertyUri:#Exchange", FieldURI });
const KEEP_HEADERS = ["authorization", "x-anchormailbox", "x-owa-hosted-ux", "x-req-source", "prefer", "x-owa-sessionid"];
const ALLOWED_HOSTS = /(^|\.)(office\.com|office\.net|microsoft\.com|microsoftonline\.com|live\.com|msftauth\.net|msauth\.net|static\.microsoft)$/;

/** One Outlook service call from inside the signed-in page: its response messages (one per folder or item asked about), all successful. */
async function call(page: Page, headers: Record<string, string>, action: string, body: unknown): Promise<unknown[]> {
  const res = await page.evaluate(
    async ({ headers, action, body }) => {
      const r = await fetch(`/owa/service.svc?action=${action}&app=Mail`, { method: "POST", headers: { ...headers, action, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
      return { status: r.status, text: await r.text() };
    },
    { headers, action, body },
  );
  if (res.status === 401 || res.status === 440) throw new MailError(SIGNED_OUT);
  if (res.status !== 200) throw new MailError(`Outlook answered ${res.status} to ${action}.`);
  const parsed = Envelope.safeParse(JSON.parse(res.text));
  if (!parsed.success) throw new MailError(`Outlook's answer to ${action} had an unexpected shape.`);
  const msgs = parsed.data.Body.ResponseMessages.Items;
  const bad = msgs.find((m) => m.ResponseClass !== "Success");
  if (bad) throw new MailError(`Outlook refused ${action} (${bad.ResponseCode ?? "no response code"}).`);
  return msgs;
}

/**
 * FindItem's answer for several folders as one list: one response message per folder, in the order
 * asked, merged newest first and cut to `count`. Reading only the first message once hid Junk.
 */
export function mergeFolders(msgs: unknown[], folders: Folder[], count: number): MailSummary[] {
  if (msgs.length !== folders.length) throw new MailError(`Outlook answered FindItem for ${msgs.length} folders, not ${folders.length}.`);
  return msgs
    .flatMap((m, i) => Found.parse(m).RootFolder.Items.map((it) => ({
      id: it.ItemId.Id,
      folder: folders[i]!,
      from: it.From?.Mailbox.Name ?? "",
      address: it.From?.Mailbox.EmailAddress ?? "",
      subject: it.Subject ?? "",
      receivedAt: it.DateTimeReceived ?? "",
    })))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, count);
}

export type Mailbox = { recent(count: number): Promise<MailSummary[]>; body(id: string): Promise<string>; close(): Promise<void> };

/** Opens Outlook on the web with the saved Purdue sign-in. Throws MailError with a fix when it can't. */
export async function openMailbox(): Promise<Mailbox> {
  const prevCwd = process.cwd();
  process.chdir(PKG); // the package reads its config relative to its own folder
  let state: BrowserState | undefined;
  try {
    // Runtime path outside this repo (see above), so these can't be static imports.
    const { resolveSessionLocation } = (await import(pathToFileURL(join(BUILD, "utils/config.js")).href)) as { resolveSessionLocation(): { sessionDir: string } };
    const { BrowserStateStore } = (await import(pathToFileURL(join(BUILD, "auth/browser-state-store.js")).href)) as { BrowserStateStore: new (dir: string) => { load(): Promise<BrowserState | undefined> } };
    state = await new BrowserStateStore(resolveSessionLocation().sessionDir).load();
  } catch {
    throw new MailError("Couldn't read the saved Purdue sign-in (keyring locked or Brightspace not set up). Check `systemctl --user status gnome-keyring-daemon.service`.");
  } finally {
    process.chdir(prevCwd);
  }
  if (!state) throw new MailError(SIGNED_OUT);

  const { chromium } = (await import(pathToFileURL(join(MODULES, "playwright/index.mjs")).href)) as { chromium: Chromium };
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  try {
    const context = await browser.newContext({ storageState: state });
    // Nothing but Outlook and Microsoft sign-in loads: no images, trackers or other sites.
    await context.route("**/*", (route) => {
      const r = route.request();
      const ok = ALLOWED_HOSTS.test(new URL(r.url()).hostname) && r.resourceType() !== "image" && r.resourceType() !== "media";
      return ok ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    let headers: Record<string, string> | null = null;
    page.on("request", (r) => {
      const u = new URL(r.url());
      const h = r.headers();
      if (!headers && u.hostname === "outlook.office.com" && u.pathname === "/owa/service.svc" && h.authorization) {
        headers = Object.fromEntries(Object.entries(h).filter(([k]) => KEEP_HEADERS.includes(k)));
      }
    });
    await page.goto("https://outlook.office.com/mail/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    for (let i = 0; i < 40 && !headers; i++) {
      if (i > 4 && new URL(page.url()).hostname === "login.microsoftonline.com") throw new MailError(SIGNED_OUT);
      await page.waitForTimeout(500);
    }
    if (!headers) throw new MailError("Outlook on the web didn't finish loading in 20 seconds. Try again in a minute.");
    const h: Record<string, string> = headers;

    return {
      async recent(count) {
        const folders = Object.keys(FOLDERS) as Folder[];
        const msgs = await call(page, h, "FindItem", {
          __type: "FindItemJsonRequest:#Exchange",
          Header: HEADER,
          Body: {
            __type: "FindItemRequest:#Exchange",
            ItemShape: { __type: "ItemResponseShape:#Exchange", BaseShape: "IdOnly", AdditionalProperties: ["Subject", "DateTimeReceived", "From"].map(prop) },
            ParentFolderIds: folders.map((f) => ({ __type: "DistinguishedFolderId:#Exchange", Id: FOLDERS[f] })),
            Traversal: "Shallow",
            Paging: { __type: "IndexedPageView:#Exchange", BasePoint: "Beginning", Offset: 0, MaxEntriesReturned: count },
            SortOrder: [{ __type: "SortResults:#Exchange", Order: "Descending", Path: prop("DateTimeReceived") }],
          },
        });
        return mergeFolders(msgs, folders, count);
      },
      async body(id) {
        const msg = Got.parse((await call(page, h, "GetItem", {
          __type: "GetItemJsonRequest:#Exchange",
          Header: HEADER,
          Body: {
            __type: "GetItemRequest:#Exchange",
            ItemShape: { __type: "ItemResponseShape:#Exchange", BaseShape: "IdOnly", BodyType: "Text", AdditionalProperties: [prop("Body")] },
            ItemIds: [{ __type: "ItemId:#Exchange", Id: id }],
          },
        }))[0]);
        return msg.Items[0]!.Body?.Value ?? "";
      },
      async close() {
        await browser.close().catch(() => {});
      },
    };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}
