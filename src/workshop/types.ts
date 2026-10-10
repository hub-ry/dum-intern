// Records the workshop store keeps and hands out. Everything here is plain JSON: callers get
// clones, so nothing they hold aliases the store's own state.

export type SchemaVersion = 1;
export const SCHEMA_VERSION: SchemaVersion = 1;

/** A study page the user reads beside the attempt and teaching box. */
export type Material = {
  id: string;
  concept: string;
  title: string;
  body: string;
  url?: string;
};

export type Schedule = {
  intervalMinutes: number;
  /** ISO time the next automatic build is due. */
  nextRunAt: string;
};

/** A goal as the store persists it. `baseContext` is the user's editable text. */
export type GoalRecord = {
  id: string;
  title: string;
  ambition: string;
  baseContext: string;
  materials: Material[];
  createdAt: string;
  updatedAt: string;
  schedule: Schedule | null;
};

/**
 * A goal as callers see it. `context` is computed: the editable `baseContext` followed by
 * bounded excerpts of the goal's actual recent interactions.
 */
export type Goal = GoalRecord & { context: string };

export type Teaching = {
  id: string;
  goalId: string;
  concept: string;
  text: string;
  createdAt: string;
};

/** The concepts the server grades exercises for. */
export type ExerciseConcept = "loops" | "conditions";

/**
 * One attempt record, in one of two shapes. A learner freeform report carries `text` and `helped`
 * and nothing else. A server-graded exercise attempt carries `exerciseId`, `answer`, `correct`
 * and `feedback` exactly as the server supplied them, with `text` holding the same raw answer, and
 * never `helped`: the grading is the server's outcome for one answer, not a learner report.
 */
export type Attempt = {
  id: string;
  goalId: string;
  concept: string;
  /** The learner's attempt text, or for a graded attempt the raw answer. */
  text: string;
  /** The learner's own report of whether help was needed. Only on freeform reports. */
  helped?: boolean;
  /** Graded exercise fields, present together only on server-graded attempts. */
  exerciseId?: string;
  answer?: string;
  correct?: boolean;
  feedback?: string;
  createdAt: string;
};

/** An attempt the server graded: every graded field present, no learner help report. */
export type GradedAttempt = Attempt & { exerciseId: string; answer: string; correct: boolean; feedback: string; helped?: undefined };

export type EvidenceKind = "introduced" | "attemptedWithHelp" | "usedIndependently" | "needsRevisiting";

export type EvidenceSource =
  | { type: "studied" }
  | { type: "attempt"; attemptId: string }
  | { type: "revisit"; note: string }
  /** A server-graded exercise answer the server marked incorrect; never written for a correct one. */
  | { type: "exercise"; attemptId: string };

/**
 * One fact about a concept. Learner evidence is written only from the learner's own actions:
 * marking material studied, reporting an attempt, or asking to revisit. Server evidence is written
 * only for an exercise answer the server graded incorrect, as a needsRevisiting gap; a correct
 * grade writes no evidence at all. Nothing is inferred from a teaching record or a generated
 * creation, and no kind means mastery.
 */
export type Evidence = {
  id: string;
  goalId: string;
  concept: string;
  kind: EvidenceKind;
  reportedBy: "learner" | "server";
  source: EvidenceSource;
  createdAt: string;
};

/** One server-graded exercise outcome as progress shows it: the raw record plus the evidence it wrote, if any. */
export type ExerciseReport = {
  attemptId: string;
  label: "server-graded exercise";
  exerciseId: string;
  answer: string;
  correct: boolean;
  feedback: string;
  /** The needsRevisiting evidence this attempt wrote, or null when the server graded it correct. */
  evidenceId: string | null;
  createdAt: string;
};

export type ConceptProgress = {
  concept: string;
  counts: Record<EvidenceKind, number>;
  latest: EvidenceKind | null;
  latestAt: string | null;
  /** Every evidence record for this concept, oldest first, each with its own id. */
  evidence: Evidence[];
  /** The learner's attempt texts and help reports, labeled as self reports. Freeform attempts only. */
  learnerReports: { attemptId: string; label: "learner report"; helped: boolean; text: string; createdAt: string }[];
  /** Server-graded exercise outcomes, oldest first. A correct grade is an outcome for one answer, not independent use. */
  exerciseReports: ExerciseReport[];
};

export type Progress = {
  goalId: string;
  note: string;
  concepts: ConceptProgress[];
};

export type GlobalEventType =
  | "goalCreated"
  | "goalUpdated"
  | "taught"
  | "attempted"
  | "studied"
  | "revisit"
  | "buildQueued"
  | "buildReady"
  | "buildFailed";

export type GlobalEvent = {
  id: string;
  type: GlobalEventType;
  goalId: string;
  goalTitle: string;
  /** The concept or job the event is about, taken from the record itself. */
  detail: string;
  at: string;
};

export type GlobalContextRecord = {
  baseContext: string;
  events: GlobalEvent[];
  updatedAt: string;
};

/** The global context as callers see it: editable text, the bounded events, and both rendered together. */
export type GlobalContext = GlobalContextRecord & { context: string };

export type JobState = "queued" | "running" | "ready" | "failed";

export type JobSnapshot = {
  goal: Goal;
  teachings: Teaching[];
  globalContext: GlobalContext;
};

export type BuildPanel = {
  image?: string;
  code?: string;
  caption: string;
  teachingIds: string[];
};

export type BuildVerification = {
  command: string;
  output: string;
};

/** What the publisher returns for one creation; validated before a job is marked ready. */
export type BuildResult = {
  title: string;
  panels: BuildPanel[];
  demoPath?: string;
  verification: BuildVerification;
  supportingMachinery: string[];
};

export type BuildInput = {
  id: string;
  goal: { id: string; title: string; ambition: string; context: string };
  teachings: { id: string; concept: string; text: string; createdAt: string }[];
  correction?: string;
  parentId?: string;
};

export type BuildOptions = {
  artifactRoot: string;
  signal?: AbortSignal;
};

export type Job = {
  id: string;
  goalId: string;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  parentId?: string;
  correction?: string;
  snapshot: JobSnapshot;
  result?: BuildResult;
  error?: string;
  /** Where the current or last run writes; the first run uses the job id, later runs a fresh id. */
  artifactId?: string;
  /** Artifact ids of earlier interrupted runs, oldest first. Their files are never reused. */
  previousArtifactIds: string[];
  /** How many times a runner has started this job. */
  attempts: number;
};

export type State = {
  schemaVersion: SchemaVersion;
  goals: GoalRecord[];
  teachings: Teaching[];
  attempts: Attempt[];
  evidence: Evidence[];
  jobs: Job[];
  global: GlobalContextRecord;
};

export type PositionsFile = {
  schemaVersion: SchemaVersion;
  positions: Record<string, number>;
};
