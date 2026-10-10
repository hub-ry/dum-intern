// Publish a note through the workshop's private, authenticated API. Nothing here touches the
// public directory: the running workshop validates, stores the revision and writes the pages.
//
//   npm run note -- create --title "..." --topic "..." --file pages.json
//   npm run note -- revise --id <uuid> --title "..." --topic "..." --file pages.json
//   npm run note -- list
//
// pages.json is an object {"pages": [{"heading","text","code"?}, ...],
// "links"?: [{"label","url"}]}. Title and topic come from the flags. The
// serialized note must fit the API's 32 KiB body limit. Every field is checked with the same
// validator the server uses, so a rejected file never reaches the network.
//
// Configuration, each explicit environment variable overriding the file:
//   DUM_WORKSHOP_TOKEN   required
//   DUM_WORKSHOP_URL     optional http(s) origin of the workshop; otherwise built from
//   DUM_WORKSHOP_HOST    default 127.0.0.1 (a wildcard bind maps to loopback) and
//   DUM_WORKSHOP_PORT    default 8770
// read from process.env, then ~/.config/dum-workshop/environment or --env-file <path>, a
// systemd-style KEY=value file parsed literally: no shell, no expansion, no command execution.
//
// Output is only ids and URLs. Errors are generic and never include the token.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WorkshopError } from "./errors.ts";
import { MAX_NOTE_BODY_BYTES, validateNotePayload, type NotePayload } from "./public-notes.ts";

export const DEFAULT_ENV_FILE = join(homedir(), ".config", "dum-workshop", "environment");
export const KNOWN_ENV_KEYS = ["DUM_WORKSHOP_HOST", "DUM_WORKSHOP_PORT", "DUM_WORKSHOP_TOKEN", "DUM_WORKSHOP_URL"] as const;
export type KnownEnvKey = (typeof KNOWN_ENV_KEYS)[number];

const MAX_ENV_FILE_BYTES = 64 * 1024;
const MAX_PAGES_FILE_BYTES = MAX_NOTE_BODY_BYTES;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL = /[\0-\x08\x0A-\x1F\x7F]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_TIMEOUT_MS = 30_000;

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "CliError";
  }
}

// ---------------------------------------------------------------------------------------------
// Environment file

/** Unquote one double-quoted systemd value body: only \\ \" \n \t are escapes; anything else is malformed. */
function unescapeDouble(body: string, line: number): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[++i];
    switch (next) {
      case "\\": out += "\\"; break;
      case "\"": out += "\""; break;
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      default: throw new CliError(`environment file line ${line}: unsupported escape in a double-quoted value`, 2);
    }
  }
  return out;
}

/** Index of the closing quote for a value starting at 0 with `quote`, honouring backslash escapes in double quotes. */
function closingQuote(value: string, quote: string): number {
  for (let i = 1; i < value.length; i++) {
    const ch = value[i];
    if (quote === "\"" && ch === "\\") {
      i++;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

/**
 * Parse a systemd EnvironmentFile-style text: KEY=value lines, # or ; comments, blank lines, a
 * trailing backslash continuing the line, values unquoted, 'single-quoted' or "double-quoted".
 * Nothing is expanded or executed. Only the workshop's known keys are returned; a malformed line
 * is an error that names the line number, never its content.
 */
export function parseEnvFile(text: string): Map<KnownEnvKey, string> {
  if (Buffer.byteLength(text, "utf8") > MAX_ENV_FILE_BYTES) throw new CliError("environment file is larger than 64 KiB", 2);
  if (text.includes("\0")) throw new CliError("environment file contains a NUL byte", 2);
  const out = new Map<KnownEnvKey, string>();
  const rawLines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    let logical = rawLines[i]!;
    while (logical.endsWith("\\") && !logical.endsWith("\\\\") && i + 1 < rawLines.length) {
      logical = logical.slice(0, -1) + rawLines[++i]!;
    }
    const trimmed = logical.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) throw new CliError(`environment file line ${lineNo}: expected KEY=value`, 2);
    const key = trimmed.slice(0, eq).trim();
    if (!ENV_KEY.test(key)) throw new CliError(`environment file line ${lineNo}: invalid variable name`, 2);
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith("'") || value.startsWith("\"")) {
      const quote = value[0]!;
      const close = closingQuote(value, quote);
      if (close === -1) throw new CliError(`environment file line ${lineNo}: unterminated quoted value`, 2);
      const rest = value.slice(close + 1).trim();
      if (rest !== "" && !rest.startsWith("#") && !rest.startsWith(";")) throw new CliError(`environment file line ${lineNo}: text after the closing quote`, 2);
      const body = value.slice(1, close);
      value = quote === "'" ? body : unescapeDouble(body, lineNo);
    } else if (value.includes("'") || value.includes("\"")) {
      throw new CliError(`environment file line ${lineNo}: quotes inside an unquoted value`, 2);
    }
    if (CONTROL.test(value)) throw new CliError(`environment file line ${lineNo}: control characters in value`, 2);
    if ((KNOWN_ENV_KEYS as readonly string[]).includes(key)) out.set(key as KnownEnvKey, value);
  }
  return out;
}

function readEnvFile(path: string, required: boolean): Map<KnownEnvKey, string> {
  let text: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new CliError(`${path} is not a regular file`, 2);
    if (st.size > MAX_ENV_FILE_BYTES) throw new CliError(`${path} is larger than 64 KiB`, 2);
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof CliError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (!required) return new Map();
      throw new CliError(`environment file ${path} does not exist`, 2);
    }
    throw new CliError(`environment file ${path} could not be read`, 2);
  }
  return parseEnvFile(text);
}

// ---------------------------------------------------------------------------------------------
// Configuration

export type CliConfig = { baseUrl: string; token: string };

function isWildcardHost(h: string): boolean {
  return h === "" || h === "0.0.0.0" || h === "::" || h === "[::]";
}

/** Combine process environment (wins) with the parsed file, and settle the workshop origin and token. */
export function resolveConfig(env: Record<string, string | undefined>, file: Map<KnownEnvKey, string>): CliConfig {
  const pick = (key: KnownEnvKey): string | undefined => (env[key] !== undefined ? env[key] : file.get(key));
  const token = (pick("DUM_WORKSHOP_TOKEN") ?? "").trim();
  if (!token) throw new CliError("DUM_WORKSHOP_TOKEN is not configured: set it in the environment or in the environment file", 2);
  if (CONTROL.test(token) || /\s/.test(token)) throw new CliError("DUM_WORKSHOP_TOKEN contains whitespace or control characters", 2);

  const explicit = (pick("DUM_WORKSHOP_URL") ?? "").trim();
  if (explicit) {
    let url: URL;
    try {
      url = new URL(explicit);
    } catch {
      throw new CliError("DUM_WORKSHOP_URL is not a valid URL", 2);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new CliError("DUM_WORKSHOP_URL must use http or https", 2);
    if (url.username || url.password) throw new CliError("DUM_WORKSHOP_URL must not carry credentials", 2);
    if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new CliError("DUM_WORKSHOP_URL must be an origin only, without a path or query", 2);
    return { baseUrl: url.origin, token };
  }

  let host = (pick("DUM_WORKSHOP_HOST") ?? "127.0.0.1").trim().toLowerCase();
  if (isWildcardHost(host)) host = host.startsWith("::") || host === "[::]" ? "[::1]" : "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  if (!/^(\[[0-9a-f:.]{2,45}\]|[a-z0-9](?:[a-z0-9.-]{0,252})?)$/.test(host)) throw new CliError("DUM_WORKSHOP_HOST is not a valid host", 2);
  const portRaw = (pick("DUM_WORKSHOP_PORT") ?? "8770").trim();
  if (!/^\d{1,5}$/.test(portRaw)) throw new CliError("DUM_WORKSHOP_PORT must be a port number", 2);
  const port = Number(portRaw);
  if (port < 1 || port > 65535) throw new CliError("DUM_WORKSHOP_PORT must be between 1 and 65535", 2);
  return { baseUrl: `http://${host}:${port}`, token };
}

// ---------------------------------------------------------------------------------------------
// The pages file

/** Turn the file text plus the title and topic flags into a validated note payload. */
export function payloadFromFile(text: string, title: string, topic: string): NotePayload {
  if (Buffer.byteLength(text, "utf8") > MAX_PAGES_FILE_BYTES) throw new CliError(`the pages file is larger than ${MAX_PAGES_FILE_BYTES} bytes`, 2);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("the pages file is not valid JSON", 2);
  }
  let pages: unknown;
  let links: unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== "pages" && key !== "links") throw new CliError(`the pages file has an unexpected field "${key.slice(0, 40)}"; only "pages" and optional "links" belong there (title and topic are flags)`, 2);
    }
    pages = obj.pages;
    links = obj.links;
  } else {
    throw new CliError("the pages file must hold an object with \"pages\"", 2);
  }
  const candidate: Record<string, unknown> = { title, topic, pages };
  if (links !== undefined) candidate.links = links;
  try {
    return validateNotePayload(candidate);
  } catch (err) {
    if (err instanceof WorkshopError) throw new CliError(`the note is not valid: ${err.message}`, 2);
    throw err;
  }
}

function readPagesFile(path: string): string {
  const abs = resolve(path);
  try {
    const st = statSync(abs);
    if (!st.isFile()) throw new CliError(`${abs} is not a regular file`, 2);
    if (st.size > MAX_PAGES_FILE_BYTES) throw new CliError(`${abs} is larger than ${MAX_PAGES_FILE_BYTES} bytes`, 2);
    return readFileSync(abs, "utf8");
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`the pages file ${abs} could not be read`, 2);
  }
}

// ---------------------------------------------------------------------------------------------
// Requests to the private API

type ApiNote = { id: string; url: string; revision: number };

function safeMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\0-\x1F\x7F]/g, " ").slice(0, 300);
}

async function callApi(config: CliConfig, method: string, path: string, payload?: NotePayload): Promise<unknown> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  if (body !== undefined && Buffer.byteLength(body, "utf8") > MAX_NOTE_BODY_BYTES) {
    throw new CliError(`the note is larger than the ${MAX_NOTE_BODY_BYTES}-byte body limit`, 2);
  }
  const headers: Record<string, string> = { authorization: `Bearer ${config.token}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    // redirect: "error" so the bearer token is never replayed to wherever a redirect points.
    res = await fetch(`${config.baseUrl}${path}`, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const cause = (err as { cause?: { code?: unknown } })?.cause?.code;
    const hint = typeof cause === "string" ? ` (${cause})` : "";
    throw new CliError(`could not reach the workshop at ${config.baseUrl}${hint}`);
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const detail = data && typeof data === "object" ? safeMessage((data as Record<string, unknown>).error) : "";
    throw new CliError(`workshop API answered ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  if (!data || typeof data !== "object") throw new CliError("workshop API returned an unexpected response");
  return data;
}

function noteFrom(data: unknown): ApiNote {
  const note = (data as Record<string, unknown>).note as Record<string, unknown> | undefined;
  if (!note || typeof note.id !== "string" || typeof note.url !== "string" || typeof note.revision !== "number") {
    throw new CliError("workshop API returned an unexpected note");
  }
  return { id: note.id, url: note.url, revision: note.revision };
}

// ---------------------------------------------------------------------------------------------
// Command line

const USAGE = `usage:
  npm run note -- create --title <title> --topic <topic> --file <pages.json> [--env-file <path>]
  npm run note -- revise --id <uuid> --title <title> --topic <topic> --file <pages.json> [--env-file <path>]
  npm run note -- list [--env-file <path>]

pages.json: {"pages": [{"heading","text","code"?}], "links"?: [{"label","url"}]}.
Links must be https. 1 to 12 pages. The note must fit in 32 KiB.
Configuration: DUM_WORKSHOP_TOKEN, optional DUM_WORKSHOP_URL or DUM_WORKSHOP_HOST/DUM_WORKSHOP_PORT,
from the environment (wins) or ${DEFAULT_ENV_FILE}.`;

function parseCli(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: { title: { type: "string" }, topic: { type: "string" }, file: { type: "string" }, id: { type: "string" }, "env-file": { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    throw new CliError(USAGE, 2);
  }
}

export async function main(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<number> {
  const parsed = parseCli(argv);
  const [command, ...extra] = parsed.positionals;
  if (!command || extra.length > 0 || !["create", "revise", "list"].includes(command)) throw new CliError(USAGE, 2);
  const { values } = parsed;

  const envFile = values["env-file"];
  const file = envFile !== undefined ? readEnvFile(resolve(envFile), true) : readEnvFile(DEFAULT_ENV_FILE, false);
  const config = resolveConfig(env, file);

  if (command === "list") {
    if (values.title !== undefined || values.topic !== undefined || values.file !== undefined || values.id !== undefined) throw new CliError(USAGE, 2);
    const data = await callApi(config, "GET", "/api/notes");
    const list = (data as Record<string, unknown>).notes;
    if (!Array.isArray(list)) throw new CliError("workshop API returned an unexpected list");
    for (const item of list) {
      const n = item as Record<string, unknown>;
      if (typeof n.id === "string" && typeof n.url === "string") out(`${n.id}\t${n.url}`);
    }
    return 0;
  }

  if (values.title === undefined || values.topic === undefined || values.file === undefined) throw new CliError(USAGE, 2);
  const payload = payloadFromFile(readPagesFile(values.file), values.title, values.topic);
  if (command === "create") {
    if (values.id !== undefined) throw new CliError(USAGE, 2);
    const note = noteFrom(await callApi(config, "POST", "/api/notes", payload));
    out(note.id);
    out(note.url);
    return 0;
  }
  if (values.id === undefined || !UUID.test(values.id)) throw new CliError("--id must be the note's lowercase UUID", 2);
  const note = noteFrom(await callApi(config, "PUT", `/api/notes/${values.id}`, payload));
  out(note.id);
  out(note.url);
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`))
    .then((status) => process.exit(status))
    .catch((err) => {
      if (err instanceof CliError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(err.exitCode);
      }
      // Anything else is unexpected; its message could in principle quote input, so keep it generic.
      process.stderr.write("note: failed unexpectedly\n");
      process.exit(1);
    });
}
