// Every boundary checked in one place: caller input before it touches state, persisted files
// before they become state, and a publisher's result before a job is marked ready. Limits are
// named constants so the numbers are documented where they're enforced.

import { WorkshopError } from "./errors.ts";
import type {
  Attempt,
  BuildResult,
  Evidence,
  EvidenceKind,
  ExerciseConcept,
  GlobalContextRecord,
  GlobalEvent,
  GlobalEventType,
  GoalRecord,
  Job,
  JobSnapshot,
  JobState,
  Material,
  PositionsFile,
  Schedule,
  State,
  Teaching,
} from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";

// Input limits.
export const MAX_TITLE = 160;
export const MAX_AMBITION = 4000;
export const MAX_CONCEPT = 160;
export const MAX_TEXT = 12000; // teaching, attempt, correction, revisit note
export const MAX_CONTEXT = 24000;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 525600; // one year
export const MAX_ERROR_LENGTH = 4000;

// Server-graded exercise attempt limits.
export const MAX_EXERCISE_ID = 100;
export const MAX_ANSWER = 2000;
export const MAX_FEEDBACK = 2000;
export const EXERCISE_CONCEPTS: readonly ExerciseConcept[] = ["loops", "conditions"];

// Record counts. Each is a hard ceiling; crossing it is a 409 so nothing is dropped silently.
export const MAX_GOALS = 200;
export const MAX_TEACHINGS_PER_GOAL = 500;
export const MAX_ATTEMPTS_PER_GOAL = 1000;
export const MAX_EVIDENCE_PER_GOAL = 2000;
export const MAX_JOBS_PER_GOAL = 300;
export const MAX_QUEUE_LENGTH = 100; // queued jobs across all goals
export const MAX_MATERIALS_PER_GOAL = 50;
export const MAX_GLOBAL_EVENTS = 50;

// Build result limits.
export const MAX_RESULT_TITLE = 200;
export const MAX_PANELS = 200;
export const MAX_CAPTION = 4000;
export const MAX_CODE_EXCERPT = 20000;
export const MAX_RELATIVE_PATH = 512;
export const MAX_VERIFICATION_COMMAND = 2000;
export const MAX_VERIFICATION_OUTPUT = 64000;
export const MAX_MACHINERY_ITEMS = 100;
export const MAX_MACHINERY_ITEM = 400;
export const MAX_TEACHING_IDS_PER_PANEL = 50;

// Persisted file ceilings. Generous relative to the record limits above.
export const MAX_STATE_BYTES = 256 * 1024 * 1024;
export const MAX_POSITIONS_BYTES = 4 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVIDENCE_KINDS: readonly EvidenceKind[] = ["introduced", "attemptedWithHelp", "usedIndependently", "needsRevisiting"];
const JOB_STATES: readonly JobState[] = ["queued", "running", "ready", "failed"];
const EVENT_TYPES: readonly GlobalEventType[] = [
  "goalCreated", "goalUpdated", "taught", "attempted", "studied", "revisit", "buildQueued", "buildReady", "buildFailed",
];

// ---------------------------------------------------------------------------------------------
// Caller input

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function requireId(value: unknown, what: string): string {
  if (!isUuid(value)) throw WorkshopError.invalid(`${what} must be a lowercase UUID`);
  return value;
}

/** A non-empty string within `max` characters, surrounding whitespace removed. */
export function requireText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") throw WorkshopError.invalid(`${what} must be a string`);
  const text = value.trim();
  if (!text) throw WorkshopError.invalid(`${what} must not be empty`);
  if (text.length > max) throw WorkshopError.invalid(`${what} must be at most ${max} characters`);
  return text;
}

/** A string within `max` characters, possibly empty. */
export function requireBoundedString(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") throw WorkshopError.invalid(`${what} must be a string`);
  if (value.length > max) throw WorkshopError.invalid(`${what} must be at most ${max} characters`);
  return value;
}

export function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw WorkshopError.invalid(`${what} must be an object`);
  return value as Record<string, unknown>;
}

export function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw WorkshopError.invalid(`${what} must be true or false`);
  return value;
}

/** Exactly one of the concepts the server grades exercises for. */
export function requireExerciseConcept(value: unknown): ExerciseConcept {
  if (typeof value !== "string" || !(EXERCISE_CONCEPTS as readonly string[]).includes(value)) {
    throw WorkshopError.invalid(`concept must be one of ${EXERCISE_CONCEPTS.join(", ")}`);
  }
  return value as ExerciseConcept;
}

export function requirePanelIndex(value: unknown, panelCount: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw WorkshopError.invalid("panel must be an integer of at least 0");
  }
  if (value >= panelCount) throw WorkshopError.invalid(`panel must be below ${panelCount}, the presentation's panel count`);
  return value;
}

export function requireIntervalMinutes(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_INTERVAL_MINUTES || value > MAX_INTERVAL_MINUTES) {
    throw WorkshopError.invalid(`intervalMinutes must be null or an integer from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}`);
  }
  return value;
}

/** Cut an error message down to what the store keeps. */
export function boundedError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const text = raw.replace(/\s+/g, " ").trim() || "unknown error";
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/**
 * A path the artifact server may resolve under an artifact's directory: relative, forward
 * slashes, no empty, "." or ".." segments, no NUL, no drive letter, nothing absolute.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_RELATIVE_PATH) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

// ---------------------------------------------------------------------------------------------
// Build results

/**
 * Accept a publisher's output only when every part is present, bounded, and refers to teachings
 * the job's snapshot actually contained. Returns a fresh, trimmed copy.
 */
function fail(message: string): never {
  throw new WorkshopError(400, `build result rejected: ${message}`);
}

export function validateBuildResult(raw: unknown, allowedTeachingIds: ReadonlySet<string>): BuildResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("not an object");
  const r = raw as Record<string, unknown>;

  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) fail("title is empty");
  if (title.length > MAX_RESULT_TITLE) fail(`title is longer than ${MAX_RESULT_TITLE} characters`);

  if (!Array.isArray(r.panels) || r.panels.length === 0) fail("panels is empty");
  if (r.panels.length > MAX_PANELS) fail(`more than ${MAX_PANELS} panels`);
  const panels = r.panels.map((p: unknown, i: number) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) fail(`panel ${i} is not an object`);
    const panel = p as Record<string, unknown>;
    const caption = typeof panel.caption === "string" ? panel.caption.trim() : "";
    if (!caption) fail(`panel ${i} has an empty caption`);
    if (caption.length > MAX_CAPTION) fail(`panel ${i} caption is longer than ${MAX_CAPTION} characters`);
    if (panel.image !== undefined && !isSafeRelativePath(panel.image)) fail(`panel ${i} image is not a safe relative path`);
    if (panel.code !== undefined) {
      if (typeof panel.code !== "string" || !panel.code.trim()) fail(`panel ${i} code is not a non-empty string`);
      if (panel.code.length > MAX_CODE_EXCERPT) fail(`panel ${i} code is longer than ${MAX_CODE_EXCERPT} characters`);
    }
    if (!Array.isArray(panel.teachingIds)) fail(`panel ${i} teachingIds is not an array`);
    if (panel.teachingIds.length > MAX_TEACHING_IDS_PER_PANEL) fail(`panel ${i} lists more than ${MAX_TEACHING_IDS_PER_PANEL} teachings`);
    const teachingIds: string[] = [];
    for (const id of panel.teachingIds as unknown[]) {
      if (!isUuid(id) || !allowedTeachingIds.has(id)) fail(`panel ${i} refers to a teaching that was not in the job's snapshot`);
      if (!teachingIds.includes(id)) teachingIds.push(id);
    }
    const out: BuildResult["panels"][number] = { caption, teachingIds };
    if (panel.image !== undefined) out.image = panel.image as string;
    if (panel.code !== undefined) out.code = panel.code as string;
    return out;
  });

  if (r.demoPath !== undefined && !isSafeRelativePath(r.demoPath)) fail("demoPath is not a safe relative path");

  if (!r.verification || typeof r.verification !== "object" || Array.isArray(r.verification)) fail("verification is missing");
  const v = r.verification as Record<string, unknown>;
  const command = typeof v.command === "string" ? v.command.trim() : "";
  const output = typeof v.output === "string" ? v.output.trim() : "";
  if (!command) fail("verification command is empty");
  if (command.length > MAX_VERIFICATION_COMMAND) fail(`verification command is longer than ${MAX_VERIFICATION_COMMAND} characters`);
  if (!output) fail("verification output is empty");
  if (output.length > MAX_VERIFICATION_OUTPUT) fail(`verification output is longer than ${MAX_VERIFICATION_OUTPUT} characters`);

  if (!Array.isArray(r.supportingMachinery)) fail("supportingMachinery is not an array");
  if (r.supportingMachinery.length > MAX_MACHINERY_ITEMS) fail(`more than ${MAX_MACHINERY_ITEMS} supportingMachinery items`);
  const supportingMachinery = r.supportingMachinery.map((item: unknown, i: number) => {
    const text = typeof item === "string" ? item.trim() : "";
    if (!text) fail(`supportingMachinery item ${i} is not a non-empty string`);
    if (text.length > MAX_MACHINERY_ITEM) fail(`supportingMachinery item ${i} is longer than ${MAX_MACHINERY_ITEM} characters`);
    return text;
  });

  const result: BuildResult = { title, panels, verification: { command, output }, supportingMachinery };
  if (r.demoPath !== undefined) result.demoPath = r.demoPath as string;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Persisted state

class Corrupt extends Error {}

function check(condition: unknown, where: string, message: string): asserts condition {
  if (!condition) throw new Corrupt(`${where}: ${message}`);
}

function obj(value: unknown, where: string): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value), where, "not an object");
  return value as Record<string, unknown>;
}

function str(value: unknown, where: string, max?: number): string {
  check(typeof value === "string", where, "not a string");
  if (max !== undefined) check((value as string).length <= max, where, `longer than ${max} characters`);
  return value as string;
}

function uuid(value: unknown, where: string): string {
  check(isUuid(value), where, "not a UUID");
  return value as string;
}

function iso(value: unknown, where: string): string {
  check(typeof value === "string" && Number.isFinite(Date.parse(value as string)), where, "not an ISO time");
  return value as string;
}

function list(value: unknown, where: string, max: number): unknown[] {
  check(Array.isArray(value), where, "not an array");
  check((value as unknown[]).length <= max, where, `more than ${max} entries`);
  return value as unknown[];
}

function oneOf<T extends string>(value: unknown, options: readonly T[], where: string): T {
  check(typeof value === "string" && (options as readonly string[]).includes(value as string), where, `not one of ${options.join(", ")}`);
  return value as T;
}

function knownKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(o)) check(allowed.includes(key), where, `unexpected field "${key}"`);
}

function material(value: unknown, where: string): Material {
  const m = obj(value, where);
  knownKeys(m, ["id", "concept", "title", "body", "url"], where);
  const out: Material = {
    id: uuid(m.id, `${where}.id`),
    concept: str(m.concept, `${where}.concept`, MAX_CONCEPT),
    title: str(m.title, `${where}.title`, MAX_TITLE),
    body: str(m.body, `${where}.body`),
  };
  if (m.url !== undefined) out.url = str(m.url, `${where}.url`, 2048);
  return out;
}

function schedule(value: unknown, where: string): Schedule | null {
  if (value === null) return null;
  const s = obj(value, where);
  knownKeys(s, ["intervalMinutes", "nextRunAt"], where);
  const interval = s.intervalMinutes;
  check(
    typeof interval === "number" && Number.isInteger(interval) && interval >= MIN_INTERVAL_MINUTES && interval <= MAX_INTERVAL_MINUTES,
    `${where}.intervalMinutes`,
    "out of range",
  );
  return { intervalMinutes: interval as number, nextRunAt: iso(s.nextRunAt, `${where}.nextRunAt`) };
}

function goalRecord(value: unknown, where: string): GoalRecord {
  const g = obj(value, where);
  knownKeys(g, ["id", "title", "ambition", "baseContext", "materials", "createdAt", "updatedAt", "schedule"], where);
  return {
    id: uuid(g.id, `${where}.id`),
    title: str(g.title, `${where}.title`, MAX_TITLE),
    ambition: str(g.ambition, `${where}.ambition`, MAX_AMBITION),
    baseContext: str(g.baseContext, `${where}.baseContext`, MAX_CONTEXT),
    materials: list(g.materials, `${where}.materials`, MAX_MATERIALS_PER_GOAL).map((m, i) => material(m, `${where}.materials[${i}]`)),
    createdAt: iso(g.createdAt, `${where}.createdAt`),
    updatedAt: iso(g.updatedAt, `${where}.updatedAt`),
    schedule: schedule(g.schedule, `${where}.schedule`),
  };
}

function teaching(value: unknown, where: string): Teaching {
  const t = obj(value, where);
  knownKeys(t, ["id", "goalId", "concept", "text", "createdAt"], where);
  return {
    id: uuid(t.id, `${where}.id`),
    goalId: uuid(t.goalId, `${where}.goalId`),
    concept: str(t.concept, `${where}.concept`, MAX_CONCEPT),
    text: str(t.text, `${where}.text`, MAX_TEXT),
    createdAt: iso(t.createdAt, `${where}.createdAt`),
  };
}

/**
 * Either shape of attempt: a freeform learner report (`helped`, written before graded attempts
 * existed and still written by `attempt`) or a server-graded exercise attempt (all four graded
 * fields, no `helped`).
 */
function attempt(value: unknown, where: string): Attempt {
  const a = obj(value, where);
  knownKeys(a, ["id", "goalId", "concept", "text", "helped", "exerciseId", "answer", "correct", "feedback", "createdAt"], where);
  const out: Attempt = {
    id: uuid(a.id, `${where}.id`),
    goalId: uuid(a.goalId, `${where}.goalId`),
    concept: str(a.concept, `${where}.concept`, MAX_CONCEPT),
    text: str(a.text, `${where}.text`, MAX_TEXT),
    createdAt: iso(a.createdAt, `${where}.createdAt`),
  };
  const graded = a.exerciseId !== undefined || a.answer !== undefined || a.correct !== undefined || a.feedback !== undefined;
  if (!graded) {
    check(typeof a.helped === "boolean", `${where}.helped`, "not a boolean");
    out.helped = a.helped as boolean;
    return out;
  }
  check(a.helped === undefined, `${where}.helped`, "not allowed on a server-graded exercise attempt");
  out.concept = oneOf(a.concept, EXERCISE_CONCEPTS, `${where}.concept`);
  out.exerciseId = str(a.exerciseId, `${where}.exerciseId`, MAX_EXERCISE_ID);
  check(out.exerciseId.trim() !== "", `${where}.exerciseId`, "empty");
  out.answer = str(a.answer, `${where}.answer`, MAX_ANSWER);
  check(out.answer.trim() !== "", `${where}.answer`, "empty");
  check(typeof a.correct === "boolean", `${where}.correct`, "not a boolean");
  out.correct = a.correct as boolean;
  out.feedback = str(a.feedback, `${where}.feedback`, MAX_FEEDBACK);
  check(out.feedback.trim() !== "", `${where}.feedback`, "empty");
  return out;
}

function evidence(value: unknown, where: string): Evidence {
  const e = obj(value, where);
  knownKeys(e, ["id", "goalId", "concept", "kind", "reportedBy", "source", "createdAt"], where);
  const s = obj(e.source, `${where}.source`);
  // Only an incorrect exercise grade is server-reported; everything else is the learner's own.
  const expectedReporter = s.type === "exercise" ? "server" : "learner";
  check(e.reportedBy === expectedReporter, `${where}.reportedBy`, `not "${expectedReporter}"`);
  let source: Evidence["source"];
  switch (s.type) {
    case "exercise":
      knownKeys(s, ["type", "attemptId"], `${where}.source`);
      check(e.kind === "needsRevisiting", `${where}.kind`, "a server-graded exercise only records needsRevisiting");
      source = { type: "exercise", attemptId: uuid(s.attemptId, `${where}.source.attemptId`) };
      break;
    case "studied":
      knownKeys(s, ["type"], `${where}.source`);
      source = { type: "studied" };
      break;
    case "attempt":
      knownKeys(s, ["type", "attemptId"], `${where}.source`);
      source = { type: "attempt", attemptId: uuid(s.attemptId, `${where}.source.attemptId`) };
      break;
    case "revisit":
      knownKeys(s, ["type", "note"], `${where}.source`);
      source = { type: "revisit", note: str(s.note, `${where}.source.note`, MAX_TEXT) };
      break;
    default:
      throw new Corrupt(`${where}.source.type: unknown`);
  }
  return {
    id: uuid(e.id, `${where}.id`),
    goalId: uuid(e.goalId, `${where}.goalId`),
    concept: str(e.concept, `${where}.concept`, MAX_CONCEPT),
    kind: oneOf(e.kind, EVIDENCE_KINDS, `${where}.kind`),
    reportedBy: expectedReporter,
    source,
    createdAt: iso(e.createdAt, `${where}.createdAt`),
  };
}

function globalEvent(value: unknown, where: string): GlobalEvent {
  const e = obj(value, where);
  knownKeys(e, ["id", "type", "goalId", "goalTitle", "detail", "at"], where);
  return {
    id: uuid(e.id, `${where}.id`),
    type: oneOf(e.type, EVENT_TYPES, `${where}.type`),
    goalId: uuid(e.goalId, `${where}.goalId`),
    goalTitle: str(e.goalTitle, `${where}.goalTitle`, MAX_TITLE),
    detail: str(e.detail, `${where}.detail`, MAX_TITLE + MAX_CONCEPT),
    at: iso(e.at, `${where}.at`),
  };
}

function globalRecord(value: unknown, where: string): GlobalContextRecord {
  const g = obj(value, where);
  knownKeys(g, ["baseContext", "events", "updatedAt"], where);
  return {
    baseContext: str(g.baseContext, `${where}.baseContext`, MAX_CONTEXT),
    events: list(g.events, `${where}.events`, MAX_GLOBAL_EVENTS).map((e, i) => globalEvent(e, `${where}.events[${i}]`)),
    updatedAt: iso(g.updatedAt, `${where}.updatedAt`),
  };
}

function snapshot(value: unknown, where: string): JobSnapshot {
  const s = obj(value, where);
  knownKeys(s, ["goal", "teachings", "globalContext"], where);
  const g = obj(s.goal, `${where}.goal`);
  const context = str(g.context, `${where}.goal.context`);
  const goalRest = { ...g };
  delete goalRest.context;
  const gc = obj(s.globalContext, `${where}.globalContext`);
  const globalText = str(gc.context, `${where}.globalContext.context`);
  const globalRest = { ...gc };
  delete globalRest.context;
  return {
    goal: { ...goalRecord(goalRest, `${where}.goal`), context },
    teachings: list(s.teachings, `${where}.teachings`, MAX_TEACHINGS_PER_GOAL).map((t, i) => teaching(t, `${where}.teachings[${i}]`)),
    globalContext: { ...globalRecord(globalRest, `${where}.globalContext`), context: globalText },
  };
}

function job(value: unknown, where: string): Job {
  const j = obj(value, where);
  knownKeys(j, [
    "id", "goalId", "state", "createdAt", "startedAt", "finishedAt", "parentId", "correction",
    "snapshot", "result", "error", "artifactId", "previousArtifactIds", "attempts",
  ], where);
  const out: Job = {
    id: uuid(j.id, `${where}.id`),
    goalId: uuid(j.goalId, `${where}.goalId`),
    state: oneOf(j.state, JOB_STATES, `${where}.state`),
    createdAt: iso(j.createdAt, `${where}.createdAt`),
    snapshot: snapshot(j.snapshot, `${where}.snapshot`),
    previousArtifactIds: list(j.previousArtifactIds, `${where}.previousArtifactIds`, 10000).map((id, i) => uuid(id, `${where}.previousArtifactIds[${i}]`)),
    attempts: 0,
  };
  check(typeof j.attempts === "number" && Number.isInteger(j.attempts) && j.attempts >= 0, `${where}.attempts`, "not a non-negative integer");
  out.attempts = j.attempts as number;
  if (j.startedAt !== undefined) out.startedAt = iso(j.startedAt, `${where}.startedAt`);
  if (j.finishedAt !== undefined) out.finishedAt = iso(j.finishedAt, `${where}.finishedAt`);
  if (j.parentId !== undefined) out.parentId = uuid(j.parentId, `${where}.parentId`);
  if (j.correction !== undefined) out.correction = str(j.correction, `${where}.correction`, MAX_TEXT);
  if (j.error !== undefined) out.error = str(j.error, `${where}.error`, MAX_ERROR_LENGTH);
  if (j.artifactId !== undefined) out.artifactId = uuid(j.artifactId, `${where}.artifactId`);
  if (j.result !== undefined) {
    const allowed = new Set(out.snapshot.teachings.map((t) => t.id));
    try {
      out.result = validateBuildResult(j.result, allowed);
    } catch (err) {
      throw new Corrupt(`${where}.result: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  check(out.state !== "ready" || out.result !== undefined, where, "ready without a result");
  check(out.state !== "failed" || out.error !== undefined, where, "failed without an error");
  check(out.snapshot.goal.id === out.goalId, where, "snapshot belongs to another goal");
  return out;
}

/** Parse and structurally validate the state file. Throws a 500 WorkshopError on anything off. */
export function parseState(text: string, path: string): State {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw WorkshopError.corrupt(`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); the workshop won't start on it`);
  }
  try {
    const s = obj(raw, "state");
    knownKeys(s, ["schemaVersion", "goals", "teachings", "attempts", "evidence", "jobs", "global"], "state");
    check(s.schemaVersion === SCHEMA_VERSION, "state.schemaVersion", `expected ${SCHEMA_VERSION}, found ${String(s.schemaVersion)}`);
    const goals = list(s.goals, "state.goals", MAX_GOALS).map((g, i) => goalRecord(g, `state.goals[${i}]`));
    const goalIds = new Set<string>();
    for (const g of goals) {
      check(!goalIds.has(g.id), "state.goals", `duplicate goal id ${g.id}`);
      goalIds.add(g.id);
    }
    const belongs = (goalId: string, where: string) => check(goalIds.has(goalId), where, `unknown goal ${goalId}`);

    const teachings = list(s.teachings, "state.teachings", MAX_TEACHINGS_PER_GOAL * MAX_GOALS).map((t, i) => teaching(t, `state.teachings[${i}]`));
    const attempts = list(s.attempts, "state.attempts", MAX_ATTEMPTS_PER_GOAL * MAX_GOALS).map((a, i) => attempt(a, `state.attempts[${i}]`));
    const evidenceList = list(s.evidence, "state.evidence", MAX_EVIDENCE_PER_GOAL * MAX_GOALS).map((e, i) => evidence(e, `state.evidence[${i}]`));
    const jobs = list(s.jobs, "state.jobs", MAX_JOBS_PER_GOAL * MAX_GOALS).map((j, i) => job(j, `state.jobs[${i}]`));

    const seen = new Set<string>();
    const unique = (id: string, where: string) => {
      check(!seen.has(id), where, `duplicate id ${id}`);
      seen.add(id);
    };
    teachings.forEach((t, i) => { unique(t.id, `state.teachings[${i}]`); belongs(t.goalId, `state.teachings[${i}]`); });
    attempts.forEach((a, i) => { unique(a.id, `state.attempts[${i}]`); belongs(a.goalId, `state.attempts[${i}]`); });
    evidenceList.forEach((e, i) => { unique(e.id, `state.evidence[${i}]`); belongs(e.goalId, `state.evidence[${i}]`); });
    const jobIds = new Set(jobs.map((j) => j.id));
    jobs.forEach((j, i) => {
      unique(j.id, `state.jobs[${i}]`);
      belongs(j.goalId, `state.jobs[${i}]`);
      if (j.parentId !== undefined) check(jobIds.has(j.parentId), `state.jobs[${i}].parentId`, `unknown job ${j.parentId}`);
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      goals,
      teachings,
      attempts,
      evidence: evidenceList,
      jobs,
      global: globalRecord(s.global, "state.global"),
    };
  } catch (err) {
    if (err instanceof Corrupt) throw WorkshopError.corrupt(`${path} is malformed (${err.message}); the workshop won't start on it`);
    throw err;
  }
}

/** Parse and validate the reading-position file. */
export function parsePositions(text: string, path: string): PositionsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw WorkshopError.corrupt(`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    const p = obj(raw, "positions");
    knownKeys(p, ["schemaVersion", "positions"], "positions");
    check(p.schemaVersion === SCHEMA_VERSION, "positions.schemaVersion", `expected ${SCHEMA_VERSION}, found ${String(p.schemaVersion)}`);
    const entries = obj(p.positions, "positions.positions");
    const positions: Record<string, number> = {};
    for (const [key, value] of Object.entries(entries)) {
      check(isUuid(key), `positions.positions`, `key ${key} is not a UUID`);
      check(typeof value === "number" && Number.isInteger(value) && value >= 0, `positions.positions.${key}`, "not a non-negative integer");
      positions[key] = value as number;
    }
    return { schemaVersion: SCHEMA_VERSION, positions };
  } catch (err) {
    if (err instanceof Corrupt) throw WorkshopError.corrupt(`${path} is malformed (${err.message})`);
    throw err;
  }
}
