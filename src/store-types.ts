// The conversation's data, without the Store: protocol and renderer import these, never the Store itself.

import type { Mode } from "./gate.ts";
import type { BackendId, Role } from "./agent/types.ts";
import type { ZoneId } from "./zone-types.ts";

export type Outcome = "ran" | "held" | "refused";

/** A model, the backend that runs it and the effort level it runs at. */
export type ModelLabel = { backend: BackendId; model: string; effort: string | null };

/** A course card from older sessions, kept readable as history. */
export type CourseCard = {
  skill: string;
  lang: string;
  lesson: string;
  example: string;
  wizard: string;
  task: string;
  path: string;
  run: string;
};

/**
 * One thing that happened, in order. The transcript is append-only. `plan`, `course`, `fill`,
 * `result` and empty `question` entries come from older sessions and stay readable history.
 */
export type Entry =
  | { kind: "say"; id: number; text: string; lead?: boolean }
  | { kind: "question"; id: number; question: string; why: string; answer: string | null }
  | { kind: "quip"; id: number; text: string }
  | { kind: "plan"; id: number; plan: string; approved: boolean | null; paused?: boolean }
  | { kind: "course"; id: number; card: CourseCard; passed: boolean | null }
  | { kind: "tool"; id: number; name: string; detail: string; outcome: Outcome; why?: string }
  | { kind: "fill"; id: number; path: string; concept: string; code: string }
  | { kind: "note"; id: number; text: string }
  /** A focused, numbered piece of a file: shared by you, or read by dum. `from` is 1-based. */
  | { kind: "excerpt"; id: number; path: string; from: number; text: string; by: "you" | "dum"; note?: string }
  /** A change: `applied` was written directly and can be reverted by `changeId`; older outcomes are history. */
  | {
    kind: "diff"; id: number; path: string; diff: string;
    outcome: "proposed" | "created" | "refused" | "applied" | "reverted"; changeId?: string; artifact?: string;
  }
  | { kind: "user"; id: number; text: string }
  | { kind: "result"; id: number; label: string; output: string; code: number }
  /** A picture they chose to share, as one separate look described it; `sha` names it, the picture isn't kept. */
  | { kind: "shot"; id: number; label: string; observation: string; sha: string };

/** A yes/no that only they can give, about their own work or their own files. Never answered by default. */
export type Purpose = "attest" | "share";

/** What the agent is blocked on, if anything. No plan approval (rule 6) and no course (rule 9). */
export type Prompt =
  | { type: "question"; question: string; why: string; intern?: boolean; purpose?: Purpose }
  | { type: "next" }
  | null;

export type Stage = { kind: "info"; title: string; body: string } | { kind: "conversation" };

export type State = {
  zoneId: ZoneId;
  zoneName: string;
  mode: Mode;
  transcript: Entry[];
  prompt: Prompt;
  busy: boolean;
  status: string;
  stage: Stage;
  unlocked: number;
  models: Record<Role, ModelLabel | null>;
};

/** A picture they chose to share with one request: base64 PNG, held only until that turn is sent. */
export type SharedImage = { data: string; mimeType: "image/png"; label: string };
