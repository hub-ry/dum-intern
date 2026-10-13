// Keeps the workshop's root (global) context in step with files on hub. A manifest lists source
// files in priority order; they are packed into the workshop's limit, anything that doesn't fit is
// named instead, credential-looking lines never leave hub, and nothing is written when unchanged.
// Each goal keeps its own context; this only sets the shared root.
//
//   npm run root-context            sync now
//   npm run root-context -- --show  print what would be sent, send nothing
//
//   DUM_ROOT_MANIFEST (default ~/context/dum-root.txt), plus the workshop's own environment.

import { readFileSync, statSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_GLOBAL_CONTEXT } from "../workshop/validate.ts";

/** The workshop's root context limit. */
export const LIMIT = MAX_GLOBAL_CONTEXT;
const MAX_FILE_BYTES = 256 * 1024;

export type Source = { path: string; text: string };

const CREDENTIAL = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/, // Discord bot token shape
  // A name ending in token, secret, password or api key, then a value: DISCORD_TOKEN=..., api_key: ...
  /(?:token|secret|password|passwd|api[_-]?key)["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
];

export function scrub(text: string): string {
  return text
    .split("\n")
    .map((line) => (CREDENTIAL.some((re) => re.test(line)) ? "[line removed on hub: looked like a credential]" : line))
    .join("\n");
}

/** Manifest lines are home-relative globs in priority order; `!glob` excludes; `#` comments. */
export function parseManifest(text: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) exclude.push(line.slice(1).trim());
    else include.push(line);
  }
  return { include, exclude };
}

/** Packs sources in order into the limit; a source that doesn't fit whole is named, never cut. */
export function compose(sources: Source[], limit = LIMIT): { text: string; included: string[]; omitted: string[] } {
  const head = "Root context, synced from files on hub. Edit those files, not this text.\n";
  const included: string[] = [];
  const omitted: string[] = [];
  const parts: string[] = [];
  let used = head.length;
  // Room kept back so the list of omitted files always fits.
  const tailRoom = Math.min(2000, sources.reduce((n, s) => n + s.path.length + 3, 60));
  for (const s of sources) {
    const block = `\n## ${s.path}\n\n${s.text.trim()}\n`;
    if (used + block.length <= limit - tailRoom) {
      parts.push(block);
      included.push(s.path);
      used += block.length;
    } else omitted.push(s.path);
  }
  let tail = "";
  if (omitted.length > 0) {
    tail = "\n## Also on hub, not included here (over the size limit)\n\n";
    for (const p of omitted) {
      const line = `- ${p}\n`;
      if (used + tail.length + line.length > limit) break;
      tail += line;
    }
  }
  return { text: head + parts.join("") + tail, included, omitted };
}

function readSources(manifestPath: string, home: string): Source[] {
  const { include, exclude } = parseManifest(readFileSync(manifestPath, "utf8"));
  const excluded = new Set(exclude.flatMap((g) => globSync(g, { cwd: home })));
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const pattern of include) {
    for (const rel of globSync(pattern, { cwd: home }).sort()) {
      if (seen.has(rel) || excluded.has(rel)) continue;
      seen.add(rel);
      const abs = join(home, rel);
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const text = readFileSync(abs, "utf8");
      if (text.includes("\u0000")) continue;
      out.push({ path: `~/${rel}`, text: scrub(text) });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const home = homedir();
  const manifest = process.env.DUM_ROOT_MANIFEST?.trim() || join(home, "context/dum-root.txt");
  const { text, included, omitted } = compose(readSources(manifest, home));
  if (process.argv.includes("--show")) {
    process.stdout.write(text);
    console.error(`\n${text.length} characters; ${included.length} files included, ${omitted.length} named only.`);
    return;
  }
  const host = process.env.DUM_WORKSHOP_HOST;
  const port = process.env.DUM_WORKSHOP_PORT;
  const token = process.env.DUM_WORKSHOP_TOKEN;
  if (!host || !port || !token) throw new Error("DUM_WORKSHOP_HOST, DUM_WORKSHOP_PORT and DUM_WORKSHOP_TOKEN must be set.");
  const url = `http://${host}:${port}/api/context`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const current = (await (await fetch(url, { headers })).json()) as { global?: { baseContext?: string } };
  if (current.global?.baseContext === text) {
    console.log(`[root-context] unchanged (${text.length} characters)`);
    return;
  }
  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ context: text }) });
  if (!res.ok) throw new Error(`workshop answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log(`[root-context] updated: ${text.length} characters, ${included.length} files, ${omitted.length} named only`);
}

if (process.argv[1]?.endsWith("root-context.ts")) {
  main().catch((err) => {
    console.error(`[root-context] ${(err as Error).message}`);
    process.exit(1);
  });
}
