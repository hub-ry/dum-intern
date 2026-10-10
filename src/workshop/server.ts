// The workshop: one page where you set a goal, study one concept at a time, predict what a loop or
// a condition does in plain English, report what you tried, teach Dum in your own words, and ask
// it to build. Dum's builds come back as a manga strip served from a separate, unauthenticated
// artifact origin so nothing it generates can touch the app's cookies.
//
//   DUM_WORKSHOP_PORT=8770 DUM_WORKSHOP_ARTIFACT_PORT=8771 npx tsx src/workshop/server.ts
//
// Two servers, two origins:
//   app       http://<host>:8770   ui.html + /api, cookie or bearer auth whenever a token is set
//   artifact  http://<host>:8771   GET/HEAD /artifacts/:jobId/<path> for ready jobs, no auth, no API
//
// With DUM_PUBLIC_NOTES_DIR set, the app also carries /api/notes: explicit, token-authenticated
// publication of short notes into that directory, which a separate static process serves. Without
// a token those routes answer 401 even on loopback; the open mode never publishes anything.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, sep, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { WorkshopStore, WorkshopRunner, WorkshopError } from "./runtime.js";
import type { Attempt, ExerciseConcept, Goal, Job, Material, Progress, Teaching } from "./runtime.js";
import { COMBINED_CONCEPT, CONDITIONS_CONCEPT, LOOPS_CONCEPT } from "./materials.js";
import { NotesProjectionError, PublicNotes } from "./public-notes.js";

// ---------------------------------------------------------------------------------------------
// Configuration

export type WorkshopOptions = {
  host?: string;
  port?: number;
  artifactPort?: number;
  home?: string;
  token?: string;
  /** The hosting owner's public notes directory (DUM_PUBLIC_NOTES_DIR). Unset leaves /api/notes answering 503. */
  publicNotesDir?: string;
};

export type WorkshopHandle = {
  appServer: Server;
  artifactServer: Server;
  store: WorkshopStore;
  runner: WorkshopRunner;
  /** Present only when a public notes directory is configured. */
  notes: PublicNotes | null;
  stop(): Promise<void>;
};

const MAX_BODY = 32 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const MAX_ANSWER_CHARS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const HOSTNAME = /^(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*\.?)$/;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SESSION_COOKIE = "dum_workshop_session";
const LOGIN_FAILURES_PER_WINDOW = 10;
const LOGIN_WINDOW_MS = 5 * 60_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number, got ${JSON.stringify(raw)}`);
  return n;
}

function isLoopbackBind(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function isWildcardBind(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "" || h === "0.0.0.0" || h === "::";
}

/** The hostname form a browser would put in Host/Origin for this bind address. */
function bindHostname(host: string): string {
  const h = host.toLowerCase();
  if (h.includes(":") && !h.startsWith("[")) return `[${h}]`;
  return h;
}

// ---------------------------------------------------------------------------------------------
// Small HTTP helpers

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type ParsedHost = { hostname: string; port: number };

function parseHostHeader(raw: string | undefined): ParsedHost | null {
  if (!raw || raw.length > 300) return null;
  const m = /^(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(raw);
  if (!m) return null;
  const hostname = m[1]!.toLowerCase();
  if (!HOSTNAME.test(hostname)) return null;
  const port = m[2] === undefined ? 80 : Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { hostname, port };
}

function hostnameAllowed(hostname: string, bindHost: string): boolean {
  if (!HOSTNAME.test(hostname)) return false;
  if (isWildcardBind(bindHost)) return true;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  if (isLoopbackBind(bindHost)) return false;
  return hostname === bindHostname(bindHost);
}

/** Validates Host against where we are bound; a request addressed to someone else is refused. */
function requireHost(req: IncomingMessage, bindHost: string, boundPort: number): ParsedHost {
  const host = parseHostHeader(req.headers.host);
  if (!host) throw new HttpError(400, "Missing or malformed Host header.");
  if (!hostnameAllowed(host.hostname, bindHost) || host.port !== boundPort) {
    throw new HttpError(421, "This server does not answer to that Host.");
  }
  return host;
}

function originMatches(origin: string, host: ParsedHost, appPort: number): boolean {
  if (origin.length > 400 || origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return false;
  const port = url.port === "" ? 80 : Number(url.port);
  return url.hostname.toLowerCase() === host.hostname && port === appPort && host.port === appPort;
}

function parseCookies(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || raw.length > 4096) return out;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && !out.has(k)) out.set(k, v);
  }
  return out;
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(data.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(data);
}

type Body = Record<string, unknown>;

function readJsonBody(req: IncomingMessage, optional = false): Promise<Body> {
  return new Promise((resolvePromise, reject) => {
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const declared = Number(req.headers["content-length"] ?? "0");
    if (type !== "application/json") {
      if (optional && (!type || declared === 0)) return resolvePromise({});
      return reject(new HttpError(415, "Send a JSON body with Content-Type: application/json."));
    }
    if (Number.isFinite(declared) && declared > MAX_BODY) return reject(new HttpError(413, "Request body is too large (limit 32 KiB)."));
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => { req.destroy(); reject(new HttpError(408, "Timed out reading the request body.")); }), BODY_TIMEOUT_MS);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) return finish(() => { req.destroy(); reject(new HttpError(413, "Request body is too large (limit 32 KiB).")); });
      chunks.push(chunk);
    });
    req.on("error", (err) => finish(() => reject(err)));
    req.on("end", () => finish(() => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = text.trim() === "" ? {} : JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return reject(new HttpError(400, "The JSON body must be an object."));
        resolvePromise(parsed as Body);
      } catch {
        reject(new HttpError(400, "The request body is not valid JSON."));
      }
    }));
  });
}

/** A string field. Bounds are the store's business; this only settles the type so calls are well typed. */
function field(body: Body, key: string): string {
  const v = body[key];
  if (typeof v !== "string") throw new HttpError(400, `"${key}" must be a string.`);
  return v;
}

function boolField(body: Body, key: string): boolean {
  const v = body[key];
  if (typeof v !== "boolean") throw new HttpError(400, `"${key}" must be true or false.`);
  return v;
}

function requireUuid(value: string | null | undefined, what: string): string {
  if (!value || !UUID.test(value)) throw new HttpError(400, `That ${what} id is not valid.`);
  return value;
}

// ---------------------------------------------------------------------------------------------
// Exercises: predict what everyday loops and conditions do, in plain words. No syntax needed; the
// JavaScript for each is optional reading. Answers live only here and are compared exactly.

export type Exercise = {
  id: string;
  /** Exercises in one family share a rule and differ only in input, so a learner can change the input and go again. */
  family: string;
  concept: ExerciseConcept;
  rule: string;
  situation: string;
  question: string;
  code?: string;
};

type Key = { answer: string; explain: string };

const EXERCISES: Exercise[] = [
  // loops: a list is visited once per item, in order
  { id: "loops-visits-3", family: "loops-visits", concept: "loops", rule: "A loop visits every creature in the list once, first to last, and does the same thing for each one.", situation: "The list holds Mossy, Pip and Tangle. For each creature, Dum says \"hello\".", question: "How many times does Dum say hello? Answer with a number.", code: "const creatures = [\"Mossy\", \"Pip\", \"Tangle\"];\nfor (const name of creatures) {\n  console.log(\"hello\");\n}" },
  { id: "loops-visits-5", family: "loops-visits", concept: "loops", rule: "A loop visits every creature in the list once, first to last, and does the same thing for each one.", situation: "The list holds Mossy, Pip, Tangle, Bramble and Pip again. For each creature, Dum says \"hello\".", question: "How many times does Dum say hello? Answer with a number.", code: "const creatures = [\"Mossy\", \"Pip\", \"Tangle\", \"Bramble\", \"Pip\"];\nfor (const name of creatures) {\n  console.log(\"hello\");\n}" },
  { id: "loops-visits-0", family: "loops-visits", concept: "loops", rule: "A loop visits every creature in the list once, first to last, and does the same thing for each one.", situation: "The list is empty. For each creature, Dum says \"hello\".", question: "How many times does Dum say hello? Answer with a number.", code: "const creatures = [];\nfor (const name of creatures) {\n  console.log(\"hello\");\n}" },
  // loops: running total
  { id: "loops-total-a", family: "loops-total", concept: "loops", rule: "A running total starts at 0. Each visit adds that creature's hunger to the total.", situation: "The hungers in the list are 3, 8 and 5.", question: "What is the total after the loop finishes? Answer with a number.", code: "const hungers = [3, 8, 5];\nlet total = 0;\nfor (const hunger of hungers) {\n  total = total + hunger;\n}\nconsole.log(total);" },
  { id: "loops-total-b", family: "loops-total", concept: "loops", rule: "A running total starts at 0. Each visit adds that creature's hunger to the total.", situation: "The hungers in the list are 2, 2, 2 and 2.", question: "What is the total after the loop finishes? Answer with a number.", code: "const hungers = [2, 2, 2, 2];\nlet total = 0;\nfor (const hunger of hungers) {\n  total = total + hunger;\n}\nconsole.log(total);" },
  { id: "loops-total-c", family: "loops-total", concept: "loops", rule: "A running total starts at 0. Each visit adds that creature's hunger to the total.", situation: "The list of hungers is empty.", question: "What is the total after the loop finishes? Answer with a number.", code: "const hungers = [];\nlet total = 0;\nfor (const hunger of hungers) {\n  total = total + hunger;\n}\nconsole.log(total);" },
  // loops: order
  { id: "loops-order-a", family: "loops-order", concept: "loops", rule: "Items are visited in list order, first to last. The last thing done is for the last item.", situation: "The list holds Mossy, Pip and Tangle. For each creature, Dum says its name.", question: "Which name is said last? Answer with the name exactly as written.", code: "const creatures = [\"Mossy\", \"Pip\", \"Tangle\"];\nfor (const name of creatures) {\n  console.log(name);\n}" },
  { id: "loops-order-b", family: "loops-order", concept: "loops", rule: "Items are visited in list order, first to last. The last thing done is for the last item.", situation: "The list holds Tangle, Mossy and Pip. For each creature, Dum says its name.", question: "Which name is said first? Answer with the name exactly as written.", code: "const creatures = [\"Tangle\", \"Mossy\", \"Pip\"];\nfor (const name of creatures) {\n  console.log(name);\n}" },
  // conditions: greater than
  { id: "conditions-gt-7", family: "conditions-gt", concept: "conditions", rule: "If a creature's hunger is greater than 5 it is fed. Otherwise it is skipped. Exactly one of the two happens.", situation: "This creature's hunger is 7.", question: "What happens? Answer fed or skipped.", code: "const hunger = 7;\nif (hunger > 5) {\n  console.log(\"fed\");\n} else {\n  console.log(\"skipped\");\n}" },
  { id: "conditions-gt-5", family: "conditions-gt", concept: "conditions", rule: "If a creature's hunger is greater than 5 it is fed. Otherwise it is skipped. Exactly one of the two happens.", situation: "This creature's hunger is exactly 5.", question: "What happens? Answer fed or skipped.", code: "const hunger = 5;\nif (hunger > 5) {\n  console.log(\"fed\");\n} else {\n  console.log(\"skipped\");\n}" },
  { id: "conditions-gt-2", family: "conditions-gt", concept: "conditions", rule: "If a creature's hunger is greater than 5 it is fed. Otherwise it is skipped. Exactly one of the two happens.", situation: "This creature's hunger is 2.", question: "What happens? Answer fed or skipped.", code: "const hunger = 2;\nif (hunger > 5) {\n  console.log(\"fed\");\n} else {\n  console.log(\"skipped\");\n}" },
  // conditions: at least
  { id: "conditions-gte-5", family: "conditions-gte", concept: "conditions", rule: "If a creature's hunger is at least 5, meaning 5 or more, it is fed. Otherwise it is skipped.", situation: "This creature's hunger is exactly 5.", question: "What happens? Answer fed or skipped.", code: "const hunger = 5;\nif (hunger >= 5) {\n  console.log(\"fed\");\n} else {\n  console.log(\"skipped\");\n}" },
  { id: "conditions-gte-4", family: "conditions-gte", concept: "conditions", rule: "If a creature's hunger is at least 5, meaning 5 or more, it is fed. Otherwise it is skipped.", situation: "This creature's hunger is 4.", question: "What happens? Answer fed or skipped.", code: "const hunger = 4;\nif (hunger >= 5) {\n  console.log(\"fed\");\n} else {\n  console.log(\"skipped\");\n}" },
  // conditions: exactly
  { id: "conditions-eq-3", family: "conditions-eq", concept: "conditions", rule: "If a creature's energy is exactly 3 it plays. Otherwise it rests.", situation: "This creature's energy is 3.", question: "What happens? Answer plays or rests.", code: "const energy = 3;\nif (energy === 3) {\n  console.log(\"plays\");\n} else {\n  console.log(\"rests\");\n}" },
  { id: "conditions-eq-2", family: "conditions-eq", concept: "conditions", rule: "If a creature's energy is exactly 3 it plays. Otherwise it rests.", situation: "This creature's energy is 2.", question: "What happens? Answer plays or rests.", code: "const energy = 2;\nif (energy === 3) {\n  console.log(\"plays\");\n} else {\n  console.log(\"rests\");\n}" },
  // conditions inside a loop: count
  { id: "conditions-count-a", family: "conditions-count", concept: "conditions", rule: "Visit every creature. If its hunger is at least 5 it is fed. Count how many are fed.", situation: "The hungers are 8, 2 and 5.", question: "How many creatures are fed? Answer with a number.", code: "const hungers = [8, 2, 5];\nlet fed = 0;\nfor (const hunger of hungers) {\n  if (hunger >= 5) {\n    fed = fed + 1;\n  }\n}\nconsole.log(fed);" },
  { id: "conditions-count-b", family: "conditions-count", concept: "conditions", rule: "Visit every creature. If its hunger is at least 5 it is fed. Count how many are fed.", situation: "The hungers are 1 and 2.", question: "How many creatures are fed? Answer with a number.", code: "const hungers = [1, 2];\nlet fed = 0;\nfor (const hunger of hungers) {\n  if (hunger >= 5) {\n    fed = fed + 1;\n  }\n}\nconsole.log(fed);" },
  { id: "conditions-count-c", family: "conditions-count", concept: "conditions", rule: "Visit every creature. If its hunger is greater than 5 it is fed. Count how many are fed.", situation: "The hungers are 8, 5 and 5.", question: "How many creatures are fed? Answer with a number.", code: "const hungers = [8, 5, 5];\nlet fed = 0;\nfor (const hunger of hungers) {\n  if (hunger > 5) {\n    fed = fed + 1;\n  }\n}\nconsole.log(fed);" },
];

const ANSWER_KEY: Record<string, Key> = {
  "loops-visits-3": { answer: "3", explain: "there are three creatures, so the body runs three times, once per creature." },
  "loops-visits-5": { answer: "5", explain: "there are five entries in the list; Pip being listed twice counts twice, because the loop visits entries, not distinct names." },
  "loops-visits-0": { answer: "0", explain: "an empty list gives zero visits, so the body never runs and nothing is said." },
  "loops-total-a": { answer: "16", explain: "the total goes 0, then 3, then 11, then 16, one addition per visit." },
  "loops-total-b": { answer: "8", explain: "four visits each add 2: 2, 4, 6, 8." },
  "loops-total-c": { answer: "0", explain: "with no items nothing is added, so the total stays at its starting value of 0." },
  "loops-order-a": { answer: "Tangle", explain: "the list is visited first to last, so the last name said is the last one in the list." },
  "loops-order-b": { answer: "Tangle", explain: "the list is visited first to last, so the first name said is the first one in the list." },
  "conditions-gt-7": { answer: "fed", explain: "7 is greater than 5, so the condition is true and the first branch runs." },
  "conditions-gt-5": { answer: "skipped", explain: "5 is not greater than 5; \"greater than\" does not include the equal case, so the otherwise branch runs." },
  "conditions-gt-2": { answer: "skipped", explain: "2 is not greater than 5, so the otherwise branch runs." },
  "conditions-gte-5": { answer: "fed", explain: "\"at least 5\" includes 5 itself, so the condition is true." },
  "conditions-gte-4": { answer: "skipped", explain: "4 is less than 5, so \"at least 5\" is false and the otherwise branch runs." },
  "conditions-eq-3": { answer: "plays", explain: "the energy is exactly 3, so the condition is true." },
  "conditions-eq-2": { answer: "rests", explain: "2 is not exactly 3, so the otherwise branch runs." },
  "conditions-count-a": { answer: "2", explain: "8 and 5 are at least 5, 2 is not, so the count ends at 2." },
  "conditions-count-b": { answer: "0", explain: "neither 1 nor 2 is at least 5, so nothing is counted." },
  "conditions-count-c": { answer: "1", explain: "only 8 is greater than 5; the two 5s are equal, not greater, so the count ends at 1." },
};

const EXERCISE_BY_ID = new Map(EXERCISES.map((e) => [e.id, e]));

/** Exact, case-preserving comparison: only surrounding whitespace and runs of spaces are forgiven. */
function normalizeAnswer(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function gradeAttempt(exerciseId: string, answer: string): { concept: ExerciseConcept; correct: boolean; feedback: string } {
  const ex = EXERCISE_BY_ID.get(exerciseId);
  const key = ANSWER_KEY[exerciseId];
  if (!ex || !key) throw new HttpError(400, "That exercise does not exist.");
  const correct = normalizeAnswer(answer) === key.answer;
  const feedback = correct
    ? `Correct: ${key.explain}`
    : `Not quite. The answer is ${key.answer}: ${key.explain} You can change the input and try the same rule again.`;
  return { concept: ex.concept, correct, feedback };
}

/** Study groups: each graded concept with the goal's materials that teach it, plus its exercises. */
const MATERIAL_CONCEPT_TO_EXERCISE: Record<string, ExerciseConcept> = {
  [LOOPS_CONCEPT]: "loops",
  [CONDITIONS_CONCEPT]: "conditions",
  [COMBINED_CONCEPT]: "conditions",
};
const CONCEPT_TITLES: Record<ExerciseConcept, string> = { loops: "Loops", conditions: "Conditions" };

type StudyGroup = { id: string; title: string; graded: boolean; materials: Material[]; exercises: Exercise[] };

function studyGroups(materials: Material[]): StudyGroup[] {
  const groups = new Map<string, StudyGroup>();
  for (const id of ["loops", "conditions"] as const) groups.set(id, { id, title: CONCEPT_TITLES[id], graded: true, materials: [], exercises: EXERCISES.filter((e) => e.concept === id) });
  for (const m of materials) {
    const key = MATERIAL_CONCEPT_TO_EXERCISE[m.concept] ?? m.concept;
    let g = groups.get(key);
    if (!g) {
      g = { id: key, title: m.concept, graded: false, materials: [], exercises: [] };
      groups.set(key, g);
    }
    g.materials.push(m);
  }
  return [...groups.values()];
}

/** Plain counts a reader can check against the records. Never a claim about what the person knows. */
function observe(progress: Progress, teachings: Teaching[], attempts: Attempt[]): string[] {
  const out: string[] = [];
  const concepts = new Set<string>();
  for (const c of progress.concepts) concepts.add(c.concept);
  for (const t of teachings) concepts.add(t.concept);
  for (const a of attempts) concepts.add(a.concept);
  if (concepts.size === 0) out.push("Nothing recorded for this goal yet.");
  for (const concept of [...concepts].sort((a, b) => a.localeCompare(b))) {
    const p = progress.concepts.find((c) => c.concept === concept);
    const parts: string[] = [];
    if (p) {
      parts.push(`marked studied ${p.counts.introduced} time${p.counts.introduced === 1 ? "" : "s"}`);
      const reports = p.learnerReports.length;
      parts.push(`${reports} self-reported attempt${reports === 1 ? "" : "s"} (${p.counts.attemptedWithHelp} with help)`);
      const graded = p.exerciseReports.length;
      if (graded) {
        const right = p.exerciseReports.filter((r) => r.correct).length;
        parts.push(`${graded} server-graded answer${graded === 1 ? "" : "s"}, ${right} graded correct`);
      }
      const revisits = p.evidence.filter((e) => e.kind === "needsRevisiting").length;
      if (revisits) parts.push(`${revisits} revisit mark${revisits === 1 ? "" : "s"} (learner asks and server-graded misses together)`);
    } else {
      parts.push("no reports or grades");
    }
    const taught = teachings.filter((t) => t.concept === concept).length;
    parts.push(`${taught} teaching${taught === 1 ? "" : "s"}`);
    out.push(`${concept}: ${parts.join("; ")}.`);
  }
  out.push(progress.note);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Glyphs: the intern and the wizard, read from the authored art files and checked line by line.

type Glyph = { width: number; height: number; palette: Record<string, string | null>; rows: string[] };

function parseGlyph(text: string, frameName: string): Glyph {
  if (text.length > 64 * 1024) throw new Error("art file is too large");
  const palette: Record<string, string | null> = {};
  let rows: string[] | null = null;
  let mode: "none" | "palette" | "frame" | "skip" = "none";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("#")) continue;
    if (line.trim() === "") {
      if (mode === "frame") mode = "none";
      if (mode === "skip") mode = "none";
      continue;
    }
    if (line === "palette") { mode = "palette"; continue; }
    if (line === "end" && mode === "palette") { mode = "none"; continue; }
    const frame = /^frame ([A-Za-z0-9_.-]{1,40})$/.exec(line);
    if (frame) {
      if (frame[1] === frameName && rows === null) { rows = []; mode = "frame"; } else mode = "skip";
      continue;
    }
    if (mode === "palette") {
      const m = /^(\S) (none|[0-9a-fA-F]{6})$/.exec(line);
      if (!m) throw new Error(`bad palette line: ${line}`);
      palette[m[1]!] = m[2] === "none" ? null : `#${m[2]!.toLowerCase()}`;
      continue;
    }
    if (mode === "frame" && rows) {
      if (line.length > 32 || rows.length >= 32) throw new Error("frame is larger than 32x32");
      for (const ch of line) if (!(ch in palette)) throw new Error(`frame uses "${ch}" which is not in the palette`);
      if (rows.length && rows[0]!.length !== line.length) throw new Error("frame rows differ in width");
      rows.push(line);
    }
  }
  if (!rows || rows.length === 0) throw new Error(`frame ${frameName} not found`);
  return { width: rows[0]!.length, height: rows.length, palette, rows };
}

function loadGlyphs(): { intern: Glyph; wizard: Glyph } | null {
  try {
    const art = new URL("../art/", import.meta.url);
    return {
      intern: parseGlyph(readFileSync(new URL("intern.txt", art), "utf8"), "idle"),
      wizard: parseGlyph(readFileSync(new URL("wizard.txt", art), "utf8"), "idle"),
    };
  } catch (err) {
    console.error("[workshop] glyphs unavailable:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The artifact server's file access: every component checked, nothing followed.

type Opened = { handle: FileHandle; size: number; type: string };

async function lstatNoSymlink(p: string): Promise<Stats | null> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return null;
    return st;
  } catch {
    return null;
  }
}

/** Opens root/segments... only if every ancestor (including the root's own) is a real directory and the leaf a real file. */
async function openArtifactFile(root: string, segments: string[]): Promise<Opened | null> {
  if (!isAbsolute(root)) return null;
  const parts = root.split(sep).filter((p) => p !== "");
  let current: string = sep;
  const dirs: string[] = [current];
  for (const p of parts) {
    current = current === sep ? `${sep}${p}` : `${current}${sep}${p}`;
    dirs.push(current);
  }
  for (const d of dirs) {
    const st = await lstatNoSymlink(d);
    if (!st || !st.isDirectory()) return null;
  }
  for (let i = 0; i < segments.length; i++) {
    current = `${current}${sep}${segments[i]}`;
    const st = await lstatNoSymlink(current);
    if (!st) return null;
    const last = i === segments.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) return null;
    if (last) {
      const type = MIME[extname(current).toLowerCase()];
      if (!type) return null;
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
      let handle: FileHandle;
      try {
        handle = await open(current, flags);
      } catch {
        return null;
      }
      try {
        const fst = await handle.stat();
        if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) {
          await handle.close();
          return null;
        }
        return { handle, size: fst.size, type };
      } catch {
        await handle.close().catch(() => {});
        return null;
      }
    }
  }
  return null;
}

/**
 * Takes the raw request target, before any URL parser gets to normalize "." or ".." away, and
 * returns [jobId, segments] or null. Every segment is percent-decoded exactly once and checked.
 */
function parseArtifactTarget(rawUrl: string | undefined): { jobId: string; segments: string[] } | null {
  if (!rawUrl || rawUrl.length > 2048 || !rawUrl.startsWith("/")) return null;
  const q = rawUrl.search(/[?#]/);
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  if (path.includes("\\") || path.includes("\0") || /%(?![0-9A-Fa-f]{2})/.test(path)) return null;
  const pieces = path.split("/");
  if (pieces.length < 4 || pieces[0] !== "" || pieces[1] !== "artifacts") return null;
  const decoded: string[] = [];
  for (const piece of pieces.slice(2)) {
    let d: string;
    try {
      d = decodeURIComponent(piece);
    } catch {
      return null;
    }
    if (d === "" || d === "." || d === ".." || d.startsWith(".")) return null;
    if (d.includes("/") || d.includes("\\") || d.includes("\0") || d.includes("%")) return null;
    if (!SAFE_SEGMENT.test(d)) return null;
    decoded.push(d);
  }
  const jobId = decoded[0]!;
  if (!UUID.test(jobId) || decoded.length < 2) return null;
  return { jobId, segments: decoded.slice(1) };
}

// ---------------------------------------------------------------------------------------------
// The page and its hashed inline script/style

function loadUi(): { html: Buffer; scriptHashes: string[]; styleHashes: string[] } {
  const text = readFileSync(new URL("ui.html", import.meta.url), "utf8");
  const hashes = (re: RegExp) => {
    const out: string[] = [];
    for (const m of text.matchAll(re)) out.push(`'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`);
    return out;
  };
  return {
    html: Buffer.from(text),
    scriptHashes: hashes(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
    styleHashes: hashes(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g),
  };
}

/** Job cards don't need the frozen snapshot; GET /api/jobs/:id still returns it whole. */
function summarizeJob(job: Job): Omit<Job, "snapshot"> {
  const { snapshot: _snapshot, ...rest } = job;
  return rest;
}

// ---------------------------------------------------------------------------------------------

export async function startWorkshopServer(options: WorkshopOptions = {}): Promise<WorkshopHandle> {
  const host = options.host ?? process.env.DUM_WORKSHOP_HOST ?? "127.0.0.1";
  const port = options.port ?? envInt("DUM_WORKSHOP_PORT", 8770);
  const artifactPort = options.artifactPort ?? envInt("DUM_WORKSHOP_ARTIFACT_PORT", 8771);
  const home = resolve(options.home ?? (process.env.DUM_WORKSHOP_HOME?.trim() || join(homedir(), ".local", "state", "dum-workshop")));
  const token = options.token ?? process.env.DUM_WORKSHOP_TOKEN ?? "";
  const publicNotesDir = (options.publicNotesDir ?? process.env.DUM_PUBLIC_NOTES_DIR ?? "").trim();
  if (port === artifactPort) throw new Error("The app port and artifact port must differ: they are separate origins on purpose.");
  if (!isLoopbackBind(host) && !token) {
    throw new Error(`DUM_WORKSHOP_HOST=${host} is not loopback, so DUM_WORKSHOP_TOKEN must be set.`);
  }
  if (token && token.length < 8) throw new Error("DUM_WORKSHOP_TOKEN must be at least 8 characters.");

  const ui = loadUi();
  const glyphs = loadGlyphs();
  const store = new WorkshopStore(home);
  const artifactRoot = join(store.home, "artifacts");
  let runner: WorkshopRunner;
  let notes: PublicNotes | null = null;
  try {
    runner = new WorkshopRunner(store, { artifactRoot });
    if (publicNotesDir) {
      // Roots are checked and the public projection rebuilt from the private revisions before we
      // listen, so a bad directory or a failed repair stops startup with the store lock released.
      notes = new PublicNotes({ home: store.home, publicRoot: publicNotesDir, reserved: [artifactRoot] });
      notes.rebuild();
    }
  } catch (err) {
    store.close();
    throw err;
  }
  const sessions = new Set<string>();
  const loginFailures = new Map<string, { count: number; resetAt: number }>();

  const artifactOrigin = (h: ParsedHost) => `http://${h.hostname}:${artifactPort}`;
  const appOrigin = (h: ParsedHost) => `http://${h.hostname}:${port}`;

  function appCsp(h: ParsedHost): string {
    const art = artifactOrigin(h);
    return [
      "default-src 'none'",
      `script-src ${ui.scriptHashes.join(" ") || "'none'"}`,
      `style-src ${ui.styleHashes.join(" ") || "'none'"}`,
      `img-src 'self' data: ${art}`,
      "connect-src 'self'",
      `frame-src ${art}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
  }

  function artifactCsp(h: ParsedHost): string {
    return [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${appOrigin(h)}`,
      "sandbox allow-scripts",
    ].join("; ");
  }

  type Auth = "open" | "bearer" | "cookie" | null;
  function authenticate(req: IncomingMessage): Auth {
    if (!token) return "open";
    const header = req.headers.authorization;
    if (typeof header === "string") {
      const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
      if (m && m[1]!.length <= 512 && sameSecret(m[1]!, token)) return "bearer";
      return null;
    }
    const sid = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (sid && /^[0-9a-f]{64}$/.test(sid) && sessions.has(sid)) return "cookie";
    return null;
  }

  function clientKey(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  function noteLoginFailure(key: string): void {
    const now = Date.now();
    const rec = loginFailures.get(key);
    if (!rec || rec.resetAt < now) loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    else rec.count++;
  }

  function loginBlocked(key: string): boolean {
    const rec = loginFailures.get(key);
    return !!rec && rec.resetAt >= Date.now() && rec.count >= LOGIN_FAILURES_PER_WINDOW;
  }

  function goalContextView(goalId: string) {
    const goal: Goal = store.getGoal(goalId);
    const teachings = store.listTeachings(goalId);
    const progress = store.progress(goalId);
    const attempts = store.listAttempts(goalId);
    return {
      goal,
      baseContext: goal.baseContext,
      context: goal.context,
      teachings,
      attempts,
      progress,
      observations: observe(progress, teachings, attempts),
    };
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, h: ParsedHost, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const path = url.pathname;
    const seg = path.split("/").filter(Boolean); // ["api", ...]
    const mutation = method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";

    // Open routes: config (no secrets), glyphs (authored art) and login.
    if (path === "/api/config" && method === "GET") {
      return sendJson(res, 200, { artifactOrigin: artifactOrigin(h), authRequired: !!token });
    }
    if (path === "/api/glyphs" && method === "GET") {
      if (!glyphs) throw new HttpError(503, "The glyph art could not be read at startup.");
      return sendJson(res, 200, glyphs, { "cache-control": "private, max-age=3600" });
    }

    if (path === "/api/login" && method === "POST") {
      if (!token) return sendJson(res, 200, { ok: true, note: "No token is configured; nothing to log in to." });
      const origin = req.headers.origin;
      if (typeof origin !== "string" || !originMatches(origin, h, port)) throw new HttpError(403, "Login must come from this page.");
      const key = clientKey(req);
      if (loginBlocked(key)) throw new HttpError(429, "Too many failed logins. Wait a few minutes and try again.");
      const body = await readJsonBody(req);
      const password = field(body, "password");
      if (password.length > 512 || !sameSecret(password, token)) {
        noteLoginFailure(key);
        throw new HttpError(401, "That is not the workshop token.");
      }
      const sid = randomBytes(32).toString("hex");
      sessions.add(sid);
      return sendJson(res, 200, { ok: true }, { "set-cookie": `${SESSION_COOKIE}=${sid}; Path=/api; HttpOnly; SameSite=Strict` });
    }

    const auth = authenticate(req);
    if (auth === null) throw new HttpError(401, "Log in with the workshop token first.");
    if (seg[1] === "notes" && !token) throw new HttpError(401, "Publishing notes needs a configured workshop token; the open loopback mode cannot publish.");

    if (mutation) {
      const origin = req.headers.origin;
      if (typeof origin === "string") {
        if (!originMatches(origin, h, port)) throw new HttpError(403, "Requests from other origins are refused.");
      } else if (auth !== "bearer") {
        throw new HttpError(403, "Cookie requests must carry an Origin header.");
      }
    }

    if (path === "/api/logout" && method === "POST") {
      const sid = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (sid) sessions.delete(sid);
      return sendJson(res, 200, { ok: true }, { "set-cookie": `${SESSION_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0` });
    }

    // -- public notes: explicit publication only, never without a configured token --
    if (seg[1] === "notes") {
      if (!notes) throw new HttpError(503, "Public notes are not configured on this workshop (DUM_PUBLIC_NOTES_DIR is unset).");
      const pub = notes;
      const publish = (status: number, run: () => ReturnType<PublicNotes["create"]>) => {
        try {
          return sendJson(res, status, { note: run() });
        } catch (err) {
          if (err instanceof NotesProjectionError) {
            console.error("[workshop] notes projection failed:", err.message);
            return sendJson(res, 500, {
              error: `The note was saved privately as revision ${err.note.revision}, but its public pages could not be written. The next create, revise or restart rebuilds them.`,
              note: err.note,
            });
          }
          throw err;
        }
      };
      if (seg.length === 2) {
        if (method === "GET") return sendJson(res, 200, { notes: pub.list() });
        if (method === "POST") {
          const body = await readJsonBody(req);
          return publish(201, () => pub.create(body));
        }
        throw new HttpError(405, "Method not allowed.");
      }
      if (seg.length === 3) {
        const noteId = requireUuid(seg[2], "note");
        if (method === "GET") return sendJson(res, 200, { note: pub.get(noteId) });
        if (method === "PUT") {
          const body = await readJsonBody(req);
          return publish(200, () => pub.revise(noteId, body));
        }
        throw new HttpError(405, "Method not allowed.");
      }
      throw new HttpError(404, "No such route.");
    }

    // -- global context --
    if (path === "/api/context") {
      if (method === "GET") return sendJson(res, 200, { global: store.getGlobalContext() });
      if (method === "PUT") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { global: store.updateGlobalContext(field(body, "context")) });
      }
      throw new HttpError(405, "Method not allowed.");
    }

    // -- material: the goal's study pages grouped by graded concept, with the exercises --
    if (path === "/api/material" && method === "GET") {
      const goalId = url.searchParams.get("goalId");
      const materials = goalId === null ? [] : store.getGoal(requireUuid(goalId, "goal")).materials;
      return sendJson(res, 200, { groups: studyGroups(materials) });
    }

    if (path === "/api/goals") {
      if (method === "GET") return sendJson(res, 200, { goals: store.listGoals() });
      if (method === "POST") {
        const body = await readJsonBody(req);
        const goal = store.createGoal({ title: field(body, "title"), ambition: field(body, "ambition") });
        return sendJson(res, 201, { goal });
      }
      throw new HttpError(405, "Method not allowed.");
    }

    if (seg[1] === "goals" && seg.length >= 3) {
      const goalId = requireUuid(seg[2], "goal");
      if (seg.length === 3 && method === "GET") return sendJson(res, 200, { goal: store.getGoal(goalId) });
      if (seg.length !== 4) throw new HttpError(404, "No such route.");
      const sub = seg[3];

      if (sub === "attempt" && method === "POST") {
        const body = await readJsonBody(req);
        const exerciseId = field(body, "exerciseId");
        const answer = normalizeAnswer(field(body, "answer"));
        if (!answer) throw new HttpError(400, "\"answer\" must not be empty.");
        if (answer.length > MAX_ANSWER_CHARS) throw new HttpError(400, `"answer" is too long (limit ${MAX_ANSWER_CHARS} characters).`);
        store.getGoal(goalId);
        const graded = gradeAttempt(exerciseId, answer);
        const attempt = store.recordAttempt(goalId, { concept: graded.concept, exerciseId, answer, correct: graded.correct, feedback: graded.feedback });
        return sendJson(res, 201, { attempt });
      }
      if (sub === "attempts" && method === "GET") return sendJson(res, 200, { attempts: store.listAttempts(goalId) });
      if (sub === "report" && method === "POST") {
        const body = await readJsonBody(req);
        const out = store.attempt(goalId, { concept: field(body, "concept"), text: field(body, "text"), helped: boolField(body, "helped") });
        return sendJson(res, 201, out);
      }
      if (sub === "studied" && method === "POST") {
        const body = await readJsonBody(req);
        return sendJson(res, 201, { evidence: store.markStudied(goalId, field(body, "concept")) });
      }
      if (sub === "revisit" && method === "POST") {
        const body = await readJsonBody(req);
        return sendJson(res, 201, { evidence: store.markRevisit(goalId, { concept: field(body, "concept"), note: field(body, "note") }) });
      }
      if (sub === "progress" && method === "GET") return sendJson(res, 200, { progress: store.progress(goalId) });
      if (sub === "teach" && method === "POST") {
        const body = await readJsonBody(req);
        return sendJson(res, 201, { teaching: store.teach(goalId, { concept: field(body, "concept"), text: field(body, "text") }) });
      }
      if (sub === "teachings" && method === "GET") return sendJson(res, 200, { teachings: store.listTeachings(goalId) });
      if (sub === "context") {
        if (method === "GET") return sendJson(res, 200, goalContextView(goalId));
        if (method === "PUT") {
          const body = await readJsonBody(req);
          store.updateGoal(goalId, { context: field(body, "context") });
          return sendJson(res, 200, goalContextView(goalId));
        }
        throw new HttpError(405, "Method not allowed.");
      }
      if (sub === "jobs" && method === "POST") {
        await readJsonBody(req, true);
        return sendJson(res, 202, { job: summarizeJob(store.enqueue(goalId, {})) });
      }
      if (sub === "schedule" && method === "POST") {
        const body = await readJsonBody(req);
        const v = body.intervalMinutes;
        if (v !== null && typeof v !== "number") throw new HttpError(400, "\"intervalMinutes\" must be a number or null.");
        const goal = store.setSchedule(goalId, { intervalMinutes: v });
        return sendJson(res, 200, { goal, schedule: goal.schedule });
      }
      throw new HttpError(404, "No such route.");
    }

    if (path === "/api/jobs" && method === "GET") {
      const goalId = url.searchParams.get("goalId");
      const jobs = store.listJobs(goalId === null ? undefined : requireUuid(goalId, "goal"));
      return sendJson(res, 200, { jobs: jobs.map(summarizeJob) });
    }

    if (seg[1] === "jobs" && seg.length >= 3) {
      const jobId = requireUuid(seg[2], "job");
      if (seg.length === 3 && method === "GET") return sendJson(res, 200, { job: store.getJob(jobId) });
      if (seg.length !== 4) throw new HttpError(404, "No such route.");
      const sub = seg[3];
      if (sub === "correction" && method === "POST") {
        const body = await readJsonBody(req);
        const parent = store.getJob(jobId);
        const job = store.enqueue(parent.goalId, { parentId: parent.id, correction: field(body, "correction") });
        return sendJson(res, 202, { job: summarizeJob(job) });
      }
      if (sub === "position") {
        if (method === "GET") return sendJson(res, 200, { panel: store.getPosition(jobId) });
        if (method === "PUT") {
          const body = await readJsonBody(req);
          const panel = body.panel;
          if (typeof panel !== "number") throw new HttpError(400, "\"panel\" must be a number.");
          return sendJson(res, 200, { panel: store.savePosition(jobId, panel) });
        }
        throw new HttpError(405, "Method not allowed.");
      }
      throw new HttpError(404, "No such route.");
    }

    throw new HttpError(404, "No such route.");
  }

  /** Errors to the wire: our own and the store's 4xx messages are safe to show; anything else is logged, not leaked. */
  function fail(res: ServerResponse, err: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    if (err instanceof WorkshopError && err.status !== 500) return sendJson(res, err.status, { error: err.message });
    console.error("[workshop] request failed:", err);
    sendJson(res, 500, { error: "Something went wrong on the server. The details are in its log." });
  }

  const appServer = createServer((req, res) => {
    (async () => {
      const h = requireHost(req, host, port);
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${h.hostname}:${h.port}`);
      if (url.pathname.startsWith("/api/") || url.pathname === "/api") return handleApi(req, res, h, url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed.");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(ui.html.length),
          "content-security-policy": appCsp(h),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        });
        return res.end(method === "HEAD" ? undefined : ui.html);
      }
      throw new HttpError(404, "Nothing lives at that path.");
    })().catch((err) => fail(res, err));
  });

  const artifactServer = createServer((req, res) => {
    (async () => {
      const h = requireHost(req, host, artifactPort);
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Only GET and HEAD are served here.");
      const target = parseArtifactTarget(req.url);
      if (!target) throw new HttpError(404, "Not found.");
      let job: Job;
      try {
        job = store.getJob(target.jobId);
      } catch (err) {
        if (err instanceof WorkshopError && err.status !== 500) throw new HttpError(404, "Not found.");
        throw err;
      }
      if (job.state !== "ready") throw new HttpError(404, "Not found.");
      const dir = job.artifactId ?? job.id;
      if (!UUID.test(dir)) throw new HttpError(404, "Not found.");
      const opened = await openArtifactFile(join(artifactRoot, dir), target.segments);
      if (!opened) throw new HttpError(404, "Not found.");
      res.writeHead(200, {
        "content-type": opened.type,
        "content-length": String(opened.size),
        "content-security-policy": artifactCsp(h),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "cross-origin",
        "cross-origin-opener-policy": "same-origin",
      });
      if (method === "HEAD") {
        await opened.handle.close();
        return res.end();
      }
      const stream = opened.handle.createReadStream({ autoClose: true });
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    })().catch((err) => fail(res, err));
  });

  const sockets = new Set<Socket>();
  for (const s of [appServer, artifactServer]) {
    s.requestTimeout = 30_000;
    s.headersTimeout = 15_000;
    s.keepAliveTimeout = 5_000;
    s.maxHeadersCount = 100;
    s.on("connection", (sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
    });
  }

  const listen = (s: Server, p: number) =>
    new Promise<void>((ok, bad) => {
      s.once("error", bad);
      s.listen(p, isWildcardBind(host) ? undefined : host, () => {
        s.off("error", bad);
        ok();
      });
    });

  try {
    runner.start();
    await listen(appServer, port);
    await listen(artifactServer, artifactPort);
  } catch (err) {
    appServer.close();
    artifactServer.close();
    try {
      await runner.stop();
    } catch {
      // The store is closed below regardless; the lock must not outlive a failed start.
    }
    store.close();
    throw err;
  }

  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      const close = (s: Server) => new Promise<void>((ok) => s.close(() => ok()));
      const closing = Promise.all([close(appServer), close(artifactServer)]);
      for (const sock of sockets) sock.destroy();
      await closing;
      try {
        await runner.stop();
      } finally {
        store.close();
      }
    })();
    return stopping;
  };

  return { appServer, artifactServer, store, runner, notes, stop };
}

// ---------------------------------------------------------------------------------------------
// Direct entry

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && entry === fileURLToPath(import.meta.url)) {
  startWorkshopServer()
    .then((ws) => {
      const show = (a: ReturnType<Server["address"]>) => (a && typeof a === "object" ? `${a.address}:${a.port}` : String(a));
      console.log(`[workshop] app      http://${show(ws.appServer.address())}`);
      console.log(`[workshop] artifact http://${show(ws.artifactServer.address())}`);
      console.log(`[workshop] home     ${ws.store.home}`);
      if (ws.notes) console.log(`[workshop] notes    ${ws.notes.publicRoot}`);
      let once = false;
      const bye = (signal: string) => {
        if (once) return;
        once = true;
        console.log(`[workshop] ${signal}, shutting down`);
        const guard = setTimeout(() => process.exit(1), 15_000);
        guard.unref();
        ws.stop().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
      };
      process.on("SIGINT", () => bye("SIGINT"));
      process.on("SIGTERM", () => bye("SIGTERM"));
    })
    .catch((err) => {
      console.error(`[workshop] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
