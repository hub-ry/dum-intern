// The workshop's persistent records and its background builder.
//
// WorkshopStore owns one private home (DUM_WORKSHOP_HOME or ~/.local/state/dum-workshop) for a
// single process at a time. Every mutation is one synchronous transaction: validate the input,
// change the in-memory state, serialize, write atomically; if the write fails the in-memory state
// is restored from the last text that reached disk. Callers get JSON clones, never internals.
//
// WorkshopRunner takes queued jobs one at a time, hands each snapshot to the publisher with an
// abort signal and a bounded timeout, validates what comes back, and records ready or failed
// durably. Stopping aborts the current build and leaves its job queued; a restart does the same
// for jobs found running, so an interrupted attempt never overwrites files the next run writes.

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildCreation } from "./publisher.ts";
import { openArtifactFile } from "./artifacts.ts";
import { WorkshopError } from "./errors.ts";
import { acquireOwnerLock, ensurePrivateDir, intendedRealPath, isWithin, LockHeldError, readPrivateFile, writePrivateFile } from "./files.ts";
import { loopsAndConditionsMaterials } from "./materials.ts";
import type {
  Attempt,
  BuildInput,
  BuildResult,
  ConceptProgress,
  Evidence,
  EvidenceKind,
  ExerciseConcept,
  ExerciseReport,
  GlobalContext,
  GlobalEventType,
  Goal,
  GoalRecord,
  GradedAttempt,
  Job,
  JobSnapshot,
  PositionsFile,
  Progress,
  State,
  Teaching,
} from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";
import {
  boundedError,
  MAX_AMBITION,
  MAX_ANSWER,
  MAX_ATTEMPTS_PER_GOAL,
  MAX_CONCEPT,
  MAX_CONTEXT,
  MAX_EVIDENCE_PER_GOAL,
  MAX_EXERCISE_ID,
  MAX_FEEDBACK,
  MAX_GLOBAL_EVENTS,
  MAX_GOALS,
  MAX_JOBS_PER_GOAL,
  MAX_POSITIONS_BYTES,
  MAX_QUEUE_LENGTH,
  MAX_STATE_BYTES,
  MAX_TEACHINGS_PER_GOAL,
  MAX_TEXT,
  MAX_TITLE,
  parsePositions,
  parseState,
  requireBoolean,
  requireBoundedString,
  requireExerciseConcept,
  requireId,
  requireIntervalMinutes,
  requireObject,
  requirePanelIndex,
  requireText,
  validateBuildResult,
} from "./validate.ts";

export { WorkshopError } from "./errors.ts";
export type { WorkshopErrorStatus } from "./errors.ts";
export type {
  Attempt,
  BuildInput,
  BuildOptions,
  BuildPanel,
  BuildResult,
  BuildVerification,
  ConceptProgress,
  Evidence,
  EvidenceKind,
  EvidenceSource,
  ExerciseConcept,
  ExerciseReport,
  GlobalContext,
  GlobalEvent,
  GlobalEventType,
  Goal,
  GradedAttempt,
  Job,
  JobSnapshot,
  JobState,
  Material,
  Progress,
  Schedule,
  Teaching,
} from "./types.ts";

const STATE_FILE = "workshop.json";
const POSITIONS_FILE = "positions.json";
const LOCK_FILE = "owner.lock";

/** How many of a goal's most recent interactions its computed context quotes. */
const CONTEXT_RECENT_INTERACTIONS = 12;
/** How much of each quoted interaction the context carries; longer texts are cut with a marker. */
const CONTEXT_EXCERPT_CHARS = 400;
/** How many global events the rendered global context lists. */
const CONTEXT_RECENT_EVENTS = 20;

export type WorkshopRunnerOptions = {
  artifactRoot: string;
  /** Called with errors the runner survived (store failures, publisher throws). Defaults to stderr. */
  onError?: (err: unknown) => void;
};

type Listener = () => void;

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > CONTEXT_EXCERPT_CHARS ? `${flat.slice(0, CONTEXT_EXCERPT_CHARS)} […cut, ${flat.length} characters in full]` : flat;
}

function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A persisted attempt the server graded; parseState guarantees the graded fields come together. */
function isGraded(a: Attempt): a is GradedAttempt {
  return a.exerciseId !== undefined && a.answer !== undefined && a.correct !== undefined && a.feedback !== undefined && a.helped === undefined;
}

/** The directory of the checked-out repository this module lives in, by walking up to package.json. */
function repositoryRoot(): string {
  let dir = import.meta.dirname;
  for (;;) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return import.meta.dirname;
    dir = parent;
  }
}

function defaultHome(): string {
  const fromEnv = process.env.DUM_WORKSHOP_HOME;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return join(homedir(), ".local", "state", "dum-workshop");
}

function emptyState(): State {
  return {
    schemaVersion: SCHEMA_VERSION,
    goals: [],
    teachings: [],
    attempts: [],
    evidence: [],
    jobs: [],
    global: { baseContext: "", events: [], updatedAt: nowIso() },
  };
}

// ---------------------------------------------------------------------------------------------

export class WorkshopStore {
  readonly home: string;
  private readonly statePath: string;
  private readonly positionsPath: string;
  private state: State;
  private stateText: string;
  private positions: PositionsFile;
  private positionsText: string;
  private releaseLock: (() => void) | null;
  private readonly listeners = new Set<Listener>();
  private closed = false;

  constructor(home?: string) {
    const chosen = home === undefined ? defaultHome() : resolve(home);
    const real = intendedRealPath(chosen);
    const repo = intendedRealPath(repositoryRoot());
    if (isWithin(real, repo)) {
      throw WorkshopError.invalid(`workshop home ${chosen} is inside the repository ${repo}; choose a directory outside it`);
    }
    ensurePrivateDir(real);
    this.home = real;
    this.statePath = join(real, STATE_FILE);
    this.positionsPath = join(real, POSITIONS_FILE);

    try {
      this.releaseLock = acquireOwnerLock(join(real, LOCK_FILE));
    } catch (err) {
      if (err instanceof LockHeldError) throw WorkshopError.conflict(err.message);
      throw err;
    }

    try {
      const stateText = readPrivateFile(this.statePath, MAX_STATE_BYTES);
      if (stateText === null) {
        this.state = emptyState();
        this.stateText = JSON.stringify(this.state, null, 2);
        writePrivateFile(this.statePath, this.stateText);
      } else {
        // Keep the canonical form of the validated state as the rollback text, not the raw file.
        this.state = parseState(stateText, this.statePath);
        this.stateText = JSON.stringify(this.state, null, 2);
      }
      const positionsText = readPrivateFile(this.positionsPath, MAX_POSITIONS_BYTES);
      if (positionsText === null) {
        this.positions = { schemaVersion: SCHEMA_VERSION, positions: {} };
        this.positionsText = JSON.stringify(this.positions, null, 2);
        writePrivateFile(this.positionsPath, this.positionsText);
      } else {
        this.positions = parsePositions(positionsText, this.positionsPath);
        this.positionsText = JSON.stringify(this.positions, null, 2);
      }
      this.recoverInterruptedJobs();
    } catch (err) {
      this.releaseLock();
      this.releaseLock = null;
      throw err;
    }
  }

  /** Jobs left running by a previous process go back to the queue; their artifact id is kept so the next run picks a new one. */
  private recoverInterruptedJobs(): void {
    if (!this.state.jobs.some((j) => j.state === "running")) return;
    this.commit((s) => {
      for (const job of s.jobs) {
        if (job.state === "running") {
          job.state = "queued";
          delete job.startedAt;
        }
      }
    });
  }

  // -- transactions ---------------------------------------------------------------------------

  private ensureOpen(): void {
    if (this.closed) throw WorkshopError.conflict("the workshop store is closed");
  }

  /**
   * Apply `mutate` to the live state and write the result. If anything throws, including the
   * write, the in-memory state is rebuilt from the last text on disk, so memory never runs ahead
   * of the file.
   */
  private commit<T>(mutate: (state: State) => T): T {
    this.ensureOpen();
    let out: T;
    try {
      out = mutate(this.state);
      const text = JSON.stringify(this.state, null, 2);
      if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) throw WorkshopError.conflict(`workshop state exceeds its ${MAX_STATE_BYTES}-byte capacity; existing history is unchanged`);
      writePrivateFile(this.statePath, text);
      this.stateText = text;
    } catch (err) {
      this.state = JSON.parse(this.stateText) as State;
      throw err;
    }
    this.notify();
    return out;
  }

  private commitPositions(mutate: (positions: PositionsFile) => void): void {
    this.ensureOpen();
    try {
      mutate(this.positions);
      const text = JSON.stringify(this.positions, null, 2);
      if (Buffer.byteLength(text, "utf8") > MAX_POSITIONS_BYTES) throw WorkshopError.conflict(`reading positions exceed their ${MAX_POSITIONS_BYTES}-byte capacity`);
      writePrivateFile(this.positionsPath, text);
      this.positionsText = text;
    } catch (err) {
      this.positions = JSON.parse(this.positionsText) as PositionsFile;
      throw err;
    }
  }

  /** Called after every successful state transaction. Listeners run on a later microtask. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        try {
          listener();
        } catch {
          // A listener's failure is its own; the transaction already succeeded.
        }
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.releaseLock?.();
    this.releaseLock = null;
  }

  // -- lookups ---------------------------------------------------------------------------------

  private goalRecord(id: string): GoalRecord {
    const goal = this.state.goals.find((g) => g.id === id);
    if (!goal) throw WorkshopError.notFound(`goal ${id} not found`);
    return goal;
  }

  private jobRecord(id: string): Job {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job) throw WorkshopError.notFound(`job ${id} not found`);
    return job;
  }

  private interactionsFor(goalId: string): { at: string; line: string }[] {
    const s = this.state;
    const lines: { at: string; line: string }[] = [];
    for (const t of s.teachings) {
      if (t.goalId === goalId) lines.push({ at: t.createdAt, line: `[teaching ${t.id} at ${t.createdAt}] ${t.concept}: ${excerpt(t.text)}` });
    }
    for (const a of s.attempts) {
      if (a.goalId !== goalId) continue;
      if (isGraded(a)) {
        const graded = a.correct ? "server graded correct" : "server graded incorrect";
        lines.push({
          at: a.createdAt,
          line: `[exercise attempt ${a.id} at ${a.createdAt}, ${graded}] ${a.concept} ${a.exerciseId}: answer ${excerpt(a.answer)}; feedback: ${excerpt(a.feedback)}`,
        });
      } else {
        const how = a.helped ? "with help" : "reported independent";
        lines.push({ at: a.createdAt, line: `[attempt ${a.id} at ${a.createdAt}, ${how}] ${a.concept}: ${excerpt(a.text)}` });
      }
    }
    for (const e of s.evidence) {
      if (e.goalId !== goalId) continue;
      if (e.source.type === "studied") lines.push({ at: e.createdAt, line: `[studied ${e.id} at ${e.createdAt}] ${e.concept}` });
      else if (e.source.type === "revisit") lines.push({ at: e.createdAt, line: `[revisit ${e.id} at ${e.createdAt}] ${e.concept}: ${excerpt(e.source.note)}` });
    }
    for (const j of s.jobs) {
      if (j.goalId === goalId && j.correction !== undefined) {
        lines.push({ at: j.createdAt, line: `[correction on job ${j.id} at ${j.createdAt}] ${excerpt(j.correction)}` });
      }
    }
    lines.sort((a, b) => compareIso(a.at, b.at));
    return lines.slice(-CONTEXT_RECENT_INTERACTIONS);
  }

  /** The editable base text followed by the goal's actual recent interactions, quoted from the records. */
  private renderGoalContext(goal: GoalRecord): string {
    const recent = this.interactionsFor(goal.id);
    const head = goal.baseContext.trim();
    if (recent.length === 0) return head;
    const body = `Recent interactions (quoted from records, oldest first):\n${recent.map((r) => `- ${r.line}`).join("\n")}`;
    return head ? `${head}\n\n${body}` : body;
  }

  private toGoal(goal: GoalRecord): Goal {
    return clone({ ...goal, context: this.renderGoalContext(goal) });
  }

  private renderGlobalContext(): GlobalContext {
    const g = this.state.global;
    const events = g.events.slice(-CONTEXT_RECENT_EVENTS);
    const head = g.baseContext.trim();
    const body = events.length
      ? `Recent events (from records, oldest first):\n${events.map((e) => `- [${e.type} at ${e.at}] goal "${e.goalTitle}": ${e.detail}`).join("\n")}`
      : "";
    const context = head && body ? `${head}\n\n${body}` : head || body;
    return clone({ ...g, context });
  }

  private pushEvent(s: State, type: GlobalEventType, goal: GoalRecord, detail: string, at: string): void {
    s.global.events.push({ id: randomUUID(), type, goalId: goal.id, goalTitle: goal.title, detail, at });
    if (s.global.events.length > MAX_GLOBAL_EVENTS) s.global.events.splice(0, s.global.events.length - MAX_GLOBAL_EVENTS);
    s.global.updatedAt = at;
  }

  // -- goals -----------------------------------------------------------------------------------

  listGoals(): Goal[] {
    this.ensureOpen();
    return this.state.goals.map((g) => this.toGoal(g));
  }

  createGoal(input: { title: string; ambition: string }): Goal {
    this.ensureOpen();
    const o = requireObject(input, "goal");
    const title = requireText(o.title, "title", MAX_TITLE);
    const ambition = requireText(o.ambition, "ambition", MAX_AMBITION);
    if (this.state.goals.length >= MAX_GOALS) throw WorkshopError.conflict(`at most ${MAX_GOALS} goals are kept`);
    const at = nowIso();
    const goal: GoalRecord = {
      id: randomUUID(),
      title,
      ambition,
      baseContext: "",
      materials: loopsAndConditionsMaterials(),
      createdAt: at,
      updatedAt: at,
      schedule: null,
    };
    this.commit((s) => {
      s.goals.push(goal);
      this.pushEvent(s, "goalCreated", goal, `created with ${goal.materials.length} study materials`, at);
    });
    return this.toGoal(goal);
  }

  getGoal(id: string): Goal {
    this.ensureOpen();
    return this.toGoal(this.goalRecord(requireId(id, "goal id")));
  }

  updateGoal(id: string, patch: { title?: string; ambition?: string; context?: string }): Goal {
    this.ensureOpen();
    const goalId = requireId(id, "goal id");
    const o = requireObject(patch, "goal update");
    const title = o.title === undefined ? undefined : requireText(o.title, "title", MAX_TITLE);
    const ambition = o.ambition === undefined ? undefined : requireText(o.ambition, "ambition", MAX_AMBITION);
    const context = o.context === undefined ? undefined : requireBoundedString(o.context, "context", MAX_CONTEXT);
    if (title === undefined && ambition === undefined && context === undefined) {
      throw WorkshopError.invalid("goal update needs at least one of title, ambition, context");
    }
    const goal = this.goalRecord(goalId);
    const at = nowIso();
    this.commit((s) => {
      const g = s.goals.find((x) => x.id === goalId)!;
      if (title !== undefined) g.title = title;
      if (ambition !== undefined) g.ambition = ambition;
      if (context !== undefined) g.baseContext = context;
      g.updatedAt = at;
      const changed = [title !== undefined && "title", ambition !== undefined && "ambition", context !== undefined && "context"].filter(Boolean);
      this.pushEvent(s, "goalUpdated", g, `changed ${changed.join(", ")}`, at);
    });
    return this.toGoal(goal);
  }

  // -- teachings -------------------------------------------------------------------------------

  teach(goalId: string, input: { concept: string; text: string }): Teaching {
    this.ensureOpen();
    const gid = requireId(goalId, "goal id");
    const o = requireObject(input, "teaching");
    const concept = requireText(o.concept, "concept", MAX_CONCEPT);
    const text = requireText(o.text, "text", MAX_TEXT);
    const goal = this.goalRecord(gid);
    if (this.state.teachings.filter((t) => t.goalId === gid).length >= MAX_TEACHINGS_PER_GOAL) {
      throw WorkshopError.conflict(`goal ${gid} already holds ${MAX_TEACHINGS_PER_GOAL} teachings`);
    }
    const at = nowIso();
    const teaching: Teaching = { id: randomUUID(), goalId: gid, concept, text, createdAt: at };
    this.commit((s) => {
      s.teachings.push(teaching);
      s.goals.find((g) => g.id === gid)!.updatedAt = at;
      this.pushEvent(s, "taught", goal, concept, at);
    });
    return clone(teaching);
  }

  listTeachings(goalId: string): Teaching[] {
    this.ensureOpen();
    const gid = requireId(goalId, "goal id");
    this.goalRecord(gid);
    return clone(this.state.teachings.filter((t) => t.goalId === gid));
  }

  // -- attempts and evidence -------------------------------------------------------------------

  private addEvidence(s: State, evidence: Evidence): void {
    if (s.evidence.filter((e) => e.goalId === evidence.goalId).length >= MAX_EVIDENCE_PER_GOAL) {
      throw WorkshopError.conflict(`goal ${evidence.goalId} already holds ${MAX_EVIDENCE_PER_GOAL} evidence records`);
    }
    s.evidence.push(evidence);
  }

  /**
   * Record the learner's own attempt and their report of whether they needed help. The report
   * becomes evidence as stated: attemptedWithHelp or usedIndependently. Nothing else infers it.
   */
  attempt(goalId: string, input: { concept: string; text: string; helped: boolean }): { attempt: Attempt; evidence: Evidence } {
    this.ensureOpen();
    const gid = requireId(goalId, "goal id");
    const o = requireObject(input, "attempt");
    const concept = requireText(o.concept, "concept", MAX_CONCEPT);
    const text = requireText(o.text, "text", MAX_TEXT);
    const helped = requireBoolean(o.helped, "helped");
    const goal = this.goalRecord(gid);
    if (this.state.attempts.filter((a) => a.goalId === gid).length >= MAX_ATTEMPTS_PER_GOAL) {
      throw WorkshopError.conflict(`goal ${gid} already holds ${MAX_ATTEMPTS_PER_GOAL} attempts`);
    }
    const at = nowIso();
    const attempt: Attempt = { id: randomUUID(), goalId: gid, concept, text, helped, createdAt: at };
    const evidence: Evidence = {
      id: randomUUID(),
      goalId: gid,
      concept,
      kind: helped ? "attemptedWithHelp" : "usedIndependently",
      reportedBy: "learner",
      source: { type: "attempt", attemptId: attempt.id },
      createdAt: at,
    };
    this.commit((s) => {
      this.addEvidence(s, evidence);
      s.attempts.push(attempt);
      s.goals.find((g) => g.id === gid)!.updatedAt = at;
      this.pushEvent(s, "attempted", goal, `${concept} (${helped ? "with help" : "reported independent"})`, at);
    });
    return clone({ attempt, evidence });
  }

  /**
   * Record one server-graded exercise attempt exactly as the server supplied it: the raw answer,
   * the server's verdict and its feedback. The grade is the server's outcome for one answer. An
   * incorrect grade is recorded as needsRevisiting evidence reported by the server; a correct grade
   * writes no evidence, because answering an exercise is not a report of independent use.
   */
  recordAttempt(
    goalId: string,
    input: { concept: ExerciseConcept; exerciseId: string; answer: string; correct: boolean; feedback: string },
  ): GradedAttempt {
    this.ensureOpen();
    const gid = requireId(goalId, "goal id");
    const o = requireObject(input, "attempt");
    const concept = requireExerciseConcept(o.concept);
    const exerciseId = requireText(o.exerciseId, "exerciseId", MAX_EXERCISE_ID);
    const answer = requireText(o.answer, "answer", MAX_ANSWER);
    const correct = requireBoolean(o.correct, "correct");
    const feedback = requireText(o.feedback, "feedback", MAX_FEEDBACK);
    const goal = this.goalRecord(gid);
    if (this.state.attempts.filter((a) => a.goalId === gid).length >= MAX_ATTEMPTS_PER_GOAL) {
      throw WorkshopError.conflict(`goal ${gid} already holds ${MAX_ATTEMPTS_PER_GOAL} attempts`);
    }
    const at = nowIso();
    const attempt: GradedAttempt = { id: randomUUID(), goalId: gid, concept, text: answer, exerciseId, answer, correct, feedback, createdAt: at };
    const gap: Evidence | null = correct
      ? null
      : {
          id: randomUUID(),
          goalId: gid,
          concept,
          kind: "needsRevisiting",
          reportedBy: "server",
          source: { type: "exercise", attemptId: attempt.id },
          createdAt: at,
        };
    this.commit((s) => {
      if (gap) this.addEvidence(s, gap);
      s.attempts.push(attempt);
      s.goals.find((g) => g.id === gid)!.updatedAt = at;
      this.pushEvent(s, "attempted", goal, `${concept}: exercise ${exerciseId} graded ${correct ? "correct" : "incorrect"} by the server`, at);
    });
    return clone(attempt);
  }

  /**
   * Every persisted server-graded exercise attempt for the goal, oldest first, as recorded. The
   * learner's freeform reports are not exercises; `progress` lists them as learner reports.
   */
  listAttempts(goalId: string): GradedAttempt[] {
    this.ensureOpen();
    const gid = requireId(goalId, "goal id");
    this.goalRecord(gid);
    return clone(this.state.attempts.filter((a): a is GradedAttempt => a.goalId === gid && isGraded(a)));
  }

  /** The learner says they read the material for a concept: that introduces it, nothing more. */
  markStudied(goalId: string, concept: string): Evidence {
    this.ensureOpen();
    const gid = requireId(goalId, "goal id");
    const name = requireText(concept, "concept", MAX_CONCEPT);
    const goal = this.goalRecord(gid);
    const at = nowIso();
    const evidence: Evidence = {
      id: randomUUID(), goalId: gid, concept: name, kind: "introduced", reportedBy: "learner", source: { type: "studied" }, createdAt: at,
    };
    this.commit((s) => {
      this.addEvidence(s, evidence);
      s.goals.find((g) => g.id === gid)!.updatedAt = at;
      this.pushEvent(s, "studied", goal, name, at);
    });
    return clone(evidence);
  }

  markRevisit(goalId: string, input: { concept: string; note: string }): Evidence {
    this.ensureOpen();
    const gid = requireId(goalId, "goal id");
    const o = requireObject(input, "revisit");
    const concept = requireText(o.concept, "concept", MAX_CONCEPT);
    const note = requireText(o.note, "note", MAX_TEXT);
    const goal = this.goalRecord(gid);
    const at = nowIso();
    const evidence: Evidence = {
      id: randomUUID(), goalId: gid, concept, kind: "needsRevisiting", reportedBy: "learner", source: { type: "revisit", note }, createdAt: at,
    };
    this.commit((s) => {
      this.addEvidence(s, evidence);
      s.goals.find((g) => g.id === gid)!.updatedAt = at;
      this.pushEvent(s, "revisit", goal, concept, at);
    });
    return clone(evidence);
  }

  /**
   * What is on record per concept: every evidence record by id, counts per kind, the learner's
   * freeform attempts labeled as self reports, and server-graded exercise outcomes labeled as
   * such with the evidence each wrote. Concepts with materials but no records are absent: creating
   * materials introduces nothing until the learner marks them studied.
   */
  progress(goalId: string): Progress {
    this.ensureOpen();
    const gid = requireId(goalId, "goal id");
    this.goalRecord(gid);
    const byConcept = new Map<string, ConceptProgress>();
    const emptyCounts = (): Record<EvidenceKind, number> => ({ introduced: 0, attemptedWithHelp: 0, usedIndependently: 0, needsRevisiting: 0 });
    const entry = (concept: string): ConceptProgress => {
      let c = byConcept.get(concept);
      if (!c) {
        c = { concept, counts: emptyCounts(), latest: null, latestAt: null, evidence: [], learnerReports: [], exerciseReports: [] };
        byConcept.set(concept, c);
      }
      return c;
    };
    const evidence = this.state.evidence.filter((e) => e.goalId === gid).sort((a, b) => compareIso(a.createdAt, b.createdAt));
    const gapByAttempt = new Map<string, string>();
    for (const e of evidence) {
      const c = entry(e.concept);
      c.evidence.push(e);
      c.counts[e.kind] += 1;
      c.latest = e.kind;
      c.latestAt = e.createdAt;
      if (e.source.type === "exercise") gapByAttempt.set(e.source.attemptId, e.id);
    }
    const attempts = this.state.attempts.filter((a) => a.goalId === gid).sort((a, b) => compareIso(a.createdAt, b.createdAt));
    for (const a of attempts) {
      if (isGraded(a)) {
        const report: ExerciseReport = {
          attemptId: a.id,
          label: "server-graded exercise",
          exerciseId: a.exerciseId,
          answer: a.answer,
          correct: a.correct,
          feedback: a.feedback,
          evidenceId: gapByAttempt.get(a.id) ?? null,
          createdAt: a.createdAt,
        };
        entry(a.concept).exerciseReports.push(report);
      } else {
        entry(a.concept).learnerReports.push({ attemptId: a.id, label: "learner report", helped: a.helped === true, text: a.text, createdAt: a.createdAt });
      }
    }
    return clone({
      goalId: gid,
      note:
        "Learner reports are the learner's own words. Exercise reports are the server's grade of one answer: an incorrect grade is recorded as a gap to revisit, a correct grade records nothing further and is not independent use. Teaching records and generated creations are not evidence, and no kind here means mastery.",
      concepts: [...byConcept.values()].sort((a, b) => a.concept.localeCompare(b.concept)),
    });
  }

  // -- global context --------------------------------------------------------------------------

  getGlobalContext(): GlobalContext {
    this.ensureOpen();
    return this.renderGlobalContext();
  }

  updateGlobalContext(context: string): GlobalContext {
    this.ensureOpen();
    const text = requireBoundedString(context, "context", MAX_CONTEXT);
    this.commit((s) => {
      s.global.baseContext = text;
      s.global.updatedAt = nowIso();
    });
    return this.renderGlobalContext();
  }

  // -- jobs ------------------------------------------------------------------------------------

  private snapshotFor(goal: GoalRecord): JobSnapshot {
    return clone({
      goal: this.toGoal(goal),
      teachings: this.state.teachings.filter((t) => t.goalId === goal.id),
      globalContext: this.renderGlobalContext(),
    });
  }

  private hasActiveJob(s: State, goalId: string): boolean {
    return s.jobs.some((j) => j.goalId === goalId && (j.state === "queued" || j.state === "running"));
  }

  private queueLength(s: State): number {
    return s.jobs.filter((j) => j.state === "queued").length;
  }

  /** Build a new queued job for `goal`, checking the limits that apply to every enqueue. */
  private newJob(s: State, goal: GoalRecord, at: string, extra: { correction?: string; parentId?: string }): Job {
    if (!s.teachings.some((t) => t.goalId === goal.id)) throw WorkshopError.conflict(`goal ${goal.id} has no teachings yet; teach something first`);
    if (this.queueLength(s) >= MAX_QUEUE_LENGTH) throw WorkshopError.conflict(`the build queue already holds ${MAX_QUEUE_LENGTH} jobs`);
    if (s.jobs.filter((j) => j.goalId === goal.id).length >= MAX_JOBS_PER_GOAL) {
      throw WorkshopError.conflict(`goal ${goal.id} already holds ${MAX_JOBS_PER_GOAL} jobs`);
    }
    const job: Job = {
      id: randomUUID(),
      goalId: goal.id,
      state: "queued",
      createdAt: at,
      snapshot: this.snapshotFor(goal),
      previousArtifactIds: [],
      attempts: 0,
    };
    if (extra.correction !== undefined) job.correction = extra.correction;
    if (extra.parentId !== undefined) job.parentId = extra.parentId;
    return job;
  }

  /**
   * Queue a build from the goal's current teachings and context, frozen in the job's snapshot.
   * A correction revises a ready parent job of the same goal and gets its own id, so the parent's
   * creation stays as it was shown.
   */
  enqueue(goalId: string, input: { correction?: string; parentId?: string } = {}): Job {
    this.ensureOpen();
    const gid = requireId(goalId, "goal id");
    const o = requireObject(input, "enqueue options");
    const correction = o.correction === undefined ? undefined : requireText(o.correction, "correction", MAX_TEXT);
    const parentId = o.parentId === undefined ? undefined : requireId(o.parentId, "parentId");
    if (correction !== undefined && parentId === undefined) throw WorkshopError.invalid("a correction needs the parentId of the ready job it revises");
    const goal = this.goalRecord(gid);
    if (parentId !== undefined) {
      const parent = this.jobRecord(parentId);
      if (parent.goalId !== gid) throw WorkshopError.invalid(`job ${parentId} belongs to another goal`);
      if (parent.state !== "ready") throw WorkshopError.conflict(`job ${parentId} is ${parent.state}; only a ready job can be revised`);
    }
    const at = nowIso();
    const job = this.commit((s) => {
      const created = this.newJob(s, goal, at, { correction, parentId });
      s.jobs.push(created);
      this.pushEvent(s, "buildQueued", goal, correction !== undefined ? `job ${created.id} (correction of ${parentId})` : `job ${created.id}`, at);
      return created;
    });
    return clone(job);
  }

  getJob(id: string): Job {
    this.ensureOpen();
    return clone(this.jobRecord(requireId(id, "job id")));
  }

  listJobs(goalId?: string): Job[] {
    this.ensureOpen();
    if (goalId === undefined) return clone(this.state.jobs);
    const gid = requireId(goalId, "goal id");
    this.goalRecord(gid);
    return clone(this.state.jobs.filter((j) => j.goalId === gid));
  }

  // -- schedules -------------------------------------------------------------------------------

  setSchedule(goalId: string, input: { intervalMinutes: number | null }): Goal {
    this.ensureOpen();
    const gid = requireId(goalId, "goal id");
    const o = requireObject(input, "schedule");
    const interval = requireIntervalMinutes(o.intervalMinutes);
    const goal = this.goalRecord(gid);
    const at = nowIso();
    this.commit((s) => {
      const g = s.goals.find((x) => x.id === gid)!;
      g.schedule = interval === null ? null : { intervalMinutes: interval, nextRunAt: new Date(Date.now() + interval * 60_000).toISOString() };
      g.updatedAt = at;
    });
    return this.toGoal(goal);
  }

  /**
   * Runner entry: advance every due schedule from `now` (missed intervals coalesce into one) and
   * queue a build for each goal that has teachings and no job queued or running. One transaction.
   */
  runDueSchedules(now: number = Date.now()): Job[] {
    this.ensureOpen();
    const due = this.state.goals.filter((g) => g.schedule !== null && Date.parse(g.schedule.nextRunAt) <= now);
    if (due.length === 0) return [];
    const at = new Date(now).toISOString();
    const created = this.commit((s) => {
      const jobs: Job[] = [];
      for (const goal of s.goals) {
        if (goal.schedule === null || Date.parse(goal.schedule.nextRunAt) > now) continue;
        goal.schedule.nextRunAt = new Date(now + goal.schedule.intervalMinutes * 60_000).toISOString();
        const hasTeaching = s.teachings.some((t) => t.goalId === goal.id);
        const room = this.queueLength(s) < MAX_QUEUE_LENGTH && s.jobs.filter((j) => j.goalId === goal.id).length < MAX_JOBS_PER_GOAL;
        if (!hasTeaching || this.hasActiveJob(s, goal.id) || !room) continue;
        const job = this.newJob(s, goal, at, {});
        s.jobs.push(job);
        this.pushEvent(s, "buildQueued", goal, `job ${job.id} (scheduled)`, at);
        jobs.push(job);
      }
      return jobs;
    });
    return clone(created);
  }

  /** Earliest nextRunAt among scheduled goals, in epoch ms, or null. Lets a runner sleep precisely. */
  nextScheduledAt(): number | null {
    this.ensureOpen();
    let next: number | null = null;
    for (const g of this.state.goals) {
      if (g.schedule === null) continue;
      const t = Date.parse(g.schedule.nextRunAt);
      if (next === null || t < next) next = t;
    }
    return next;
  }

  // -- runner transitions ----------------------------------------------------------------------

  /**
   * Runner entry: take the oldest queued job and mark it running. The first run writes under the
   * job's own id; any later run (after an interruption) gets a fresh artifact id so it never
   * touches what the earlier run left behind.
   */
  claimNextJob(): Job | null {
    this.ensureOpen();
    if (this.state.jobs.some((j) => j.state === "running")) return null;
    const next = this.state.jobs.filter((j) => j.state === "queued").sort((a, b) => compareIso(a.createdAt, b.createdAt))[0];
    if (!next) return null;
    const at = nowIso();
    const claimed = this.commit((s) => {
      const job = s.jobs.find((j) => j.id === next.id)!;
      job.state = "running";
      job.startedAt = at;
      job.attempts += 1;
      if (job.artifactId === undefined) {
        job.artifactId = job.id;
      } else {
        job.previousArtifactIds.push(job.artifactId);
        job.artifactId = randomUUID();
      }
      return job;
    });
    return clone(claimed);
  }

  /** Runner entry: a validated result makes the job ready. The publisher's files are not touched. */
  completeJob(jobId: string, raw: unknown): Job {
    this.ensureOpen();
    const id = requireId(jobId, "job id");
    const job = this.jobRecord(id);
    if (job.state !== "running") throw WorkshopError.conflict(`job ${id} is ${job.state}, not running`);
    const result: BuildResult = validateBuildResult(raw, new Set(job.snapshot.teachings.map((t) => t.id)));
    const at = nowIso();
    const done = this.commit((s) => {
      const j = s.jobs.find((x) => x.id === id)!;
      j.state = "ready";
      j.result = result;
      j.finishedAt = at;
      delete j.error;
      const goal = s.goals.find((g) => g.id === j.goalId);
      if (goal) this.pushEvent(s, "buildReady", goal, `job ${j.id}: ${result.title}`, at);
      return j;
    });
    return clone(done);
  }

  /** Runner entry: record a failure durably, with the message cut to a bounded length. */
  failJob(jobId: string, err: unknown): Job {
    this.ensureOpen();
    const id = requireId(jobId, "job id");
    const job = this.jobRecord(id);
    if (job.state !== "running") throw WorkshopError.conflict(`job ${id} is ${job.state}, not running`);
    const message = boundedError(err);
    const at = nowIso();
    const failed = this.commit((s) => {
      const j = s.jobs.find((x) => x.id === id)!;
      j.state = "failed";
      j.error = message;
      j.finishedAt = at;
      const goal = s.goals.find((g) => g.id === j.goalId);
      if (goal) this.pushEvent(s, "buildFailed", goal, `job ${j.id}: ${message.slice(0, 120)}`, at);
      return j;
    });
    return clone(failed);
  }

  /** Runner entry: a build interrupted by stop goes back to the queue, keeping its attempt history. */
  requeueJob(jobId: string): Job {
    this.ensureOpen();
    const id = requireId(jobId, "job id");
    const job = this.jobRecord(id);
    if (job.state !== "running") throw WorkshopError.conflict(`job ${id} is ${job.state}, not running`);
    const requeued = this.commit((s) => {
      const j = s.jobs.find((x) => x.id === id)!;
      j.state = "queued";
      delete j.startedAt;
      return j;
    });
    return clone(requeued);
  }

  // -- reading position ------------------------------------------------------------------------

  savePosition(jobId: string, panel: number): number {
    this.ensureOpen();
    const id = requireId(jobId, "job id");
    const job = this.jobRecord(id);
    if (job.state !== "ready" || !job.result) throw WorkshopError.conflict(`job ${id} is ${job.state}; positions are saved only for ready presentations`);
    const index = requirePanelIndex(panel, job.result.panels.length);
    this.commitPositions((p) => {
      p.positions[id] = index;
    });
    return index;
  }

  getPosition(jobId: string): number {
    this.ensureOpen();
    const id = requireId(jobId, "job id");
    const job = this.jobRecord(id);
    const saved = this.positions.positions[id];
    if (saved === undefined || !job.result) return 0;
    // A position past the end (a result replaced by a stricter validator, say) falls back to the start.
    return saved < job.result.panels.length ? saved : 0;
  }
}

// ---------------------------------------------------------------------------------------------

/** How long one build may take before it is aborted and recorded as failed. */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
/** How often the runner checks schedules and the queue on its own, between store change signals. */
const POLL_MS = 5_000;

type Current = { job: Job; done: Promise<void> };

export class WorkshopRunner {
  private readonly store: WorkshopStore;
  private readonly artifactRoot: string;
  private readonly onError: (err: unknown) => void;
  private started = false;
  private stopping = false;
  private unsubscribe: (() => void) | null = null;
  private poll: NodeJS.Timeout | null = null;
  private current: Current | null = null;
  private controller: AbortController | null = null;
  private tickQueued = false;

  constructor(store: WorkshopStore, options: WorkshopRunnerOptions) {
    if (!options || typeof options.artifactRoot !== "string" || !options.artifactRoot.trim()) {
      throw WorkshopError.invalid("runner needs an artifactRoot");
    }
    this.store = store;
    this.artifactRoot = WorkshopRunner.prepareArtifactRoot(store.home, options.artifactRoot);
    this.onError = options.onError ?? ((err) => console.error("[workshop runner]", err instanceof Error ? err.message : err));
  }

  /**
   * Make the artifact root a real, private directory before any build asks the publisher for it.
   * The root must sit strictly beneath the store's home, so nothing outside the workshop is
   * created or re-permissioned; it must already be canonical (no symlink in it or above it inside
   * the home), since the publisher binds it into Docker by its real path; and it must hold no
   * comma, which Docker's bind-mount syntax would misread. Nothing is touched until every check
   * passes, and the canonical path is checked again after creation.
   */
  private static prepareArtifactRoot(home: string, supplied: string): string {
    const root = resolve(supplied.trim());
    const canonical = (): string => {
      try {
        return intendedRealPath(root);
      } catch (err) {
        throw WorkshopError.invalid(`artifactRoot ${root} can't be resolved: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const real = canonical();
    if (real !== root) throw WorkshopError.invalid(`artifactRoot ${root} must be canonical; it resolves to ${real}`);
    if (!isWithin(root, home) || root === home) {
      throw WorkshopError.invalid(`artifactRoot ${root} must be a directory beneath the workshop home ${home}`);
    }
    if (root.includes(",")) throw WorkshopError.invalid(`artifactRoot ${root} must not contain a comma (Docker bind-mount syntax)`);
    try {
      ensurePrivateDir(root);
    } catch (err) {
      throw WorkshopError.invalid(`artifactRoot ${root} can't be prepared: ${err instanceof Error ? err.message : String(err)}`);
    }
    const after = canonical();
    if (after !== root) throw WorkshopError.invalid(`artifactRoot ${root} changed under the runner; it now resolves to ${after}`);
    return root;
  }

  /** Begin taking jobs. Calling it again while running does nothing. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.unsubscribe = this.store.subscribe(() => this.requestTick());
    this.poll = setInterval(() => this.requestTick(), POLL_MS);
    this.requestTick();
  }

  /** Stop taking jobs, abort the current build, and wait for it to settle. Its job stays queued. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.controller?.abort(new Error("workshop runner stopping"));
    if (this.current) await this.current.done;
    this.started = false;
  }

  /** True while a build is in flight. */
  get busy(): boolean {
    return this.current !== null;
  }

  /** Coalesce bursts of change signals into one tick on the next microtask. */
  private requestTick(): void {
    if (this.tickQueued || this.stopping || !this.started) return;
    this.tickQueued = true;
    queueMicrotask(() => {
      this.tickQueued = false;
      this.tick();
    });
  }

  private tick(): void {
    if (this.stopping || !this.started) return;
    try {
      this.store.runDueSchedules(Date.now());
    } catch (err) {
      this.onError(err);
    }
    if (this.current) return;
    let job: Job | null;
    try {
      job = this.store.claimNextJob();
    } catch (err) {
      this.onError(err);
      return;
    }
    if (!job) return;
    const done = this.run(job).catch((err) => this.onError(err));
    this.current = { job, done };
    void done.then(() => {
      this.current = null;
      this.requestTick();
    });
  }

  private async readParentCreation(id: string): Promise<NonNullable<BuildInput["parent"]>> {
    const parent = this.store.getJob(id);
    if (parent.state !== "ready" || !parent.result?.demoPath) throw new Error("Parent has no ready demo source to revise");
    const opened = await openArtifactFile(join(this.artifactRoot, parent.artifactId ?? parent.id), parent.result.demoPath.split("/"));
    if (!opened) throw new Error("Parent demo source is unavailable or unsafe");
    try {
      if (opened.size > 200000) throw new Error("Parent demo source exceeds the verified source limit");
      const source = await opened.handle.readFile();
      const verification = JSON.parse(parent.result.verification.output);
      const hash = createHash("sha256").update(source).digest("hex");
      if (source.length > 200000 || verification.report?.ok !== true || verification.report?.sourceHash !== hash) {
        throw new Error("Parent demo source does not match its verification evidence");
      }
      return { html: source.toString("utf8"), presentation: parent.result };
    } finally {
      await opened.handle.close();
    }
  }

  private async run(job: Job): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`build exceeded ${BUILD_TIMEOUT_MS / 60_000} minutes`));
    }, BUILD_TIMEOUT_MS);

    const { goal, teachings, globalContext } = job.snapshot;
    const input: BuildInput = {
      id: job.artifactId ?? job.id,
      goal: { id: goal.id, title: goal.title, ambition: goal.ambition, context: goal.context },
      globalContext: globalContext.context,
      teachings: teachings.map((t) => ({ id: t.id, concept: t.concept, text: t.text, createdAt: t.createdAt })),
    };
    if (job.correction !== undefined) input.correction = job.correction;
    if (job.parentId !== undefined) input.parentId = job.parentId;

    let outcome: { ok: true; result: unknown } | { ok: false; error: unknown };
    try {
      if (job.parentId !== undefined) input.parent = await this.readParentCreation(job.parentId);
      const result: unknown = await buildCreation(input, { artifactRoot: this.artifactRoot, signal: controller.signal });
      outcome = { ok: true, result };
    } catch (err) {
      outcome = { ok: false, error: err };
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }

    try {
      if (this.stopping && !timedOut) {
        // Interrupted on purpose: back to the queue, never failed. A result that arrived anyway
        // is kept if it validates, since the work is real and done.
        if (outcome.ok) {
          try {
            this.store.completeJob(job.id, outcome.result);
            return;
          } catch {
            // Fall through to requeue; a later run produces a fresh artifact.
          }
        }
        this.store.requeueJob(job.id);
        return;
      }
      if (outcome.ok) {
        try {
          this.store.completeJob(job.id, outcome.result);
        } catch (err) {
          if (err instanceof WorkshopError && err.status === 400) this.store.failJob(job.id, err);
          else throw err;
        }
      } else {
        this.store.failJob(job.id, timedOut ? new Error(`build exceeded ${BUILD_TIMEOUT_MS / 60_000} minutes`) : outcome.error);
      }
    } catch (err) {
      // The store refused the transition (closed, I/O failure). The job stays running on disk and
      // the next start requeues it; the next run writes under a fresh artifact id.
      this.onError(err);
    }
  }
}
