export type StepId = "brief" | "plan" | "attempt" | "check" | "reflect" | "teach" | "variation";

export type HintLevel = 0 | 1 | 2 | 3;

export type HintKind = "nudge" | "direction" | "fragment";

export type Hint = {
  level: 1 | 2 | 3;
  kind: HintKind;
  body: string;
  code?: string;
};

export type Session = {
  version: 1;
  step: StepId;
  plan: string;
  attempt: string;
  mainHints: HintLevel;
  exampleSeen: boolean;
  expectation: string;
  failed: string;
  why: string;
  fix: string;
  explanation: string;
  answer: string;
  lessonSaved: boolean;
  variationAttempt: string;
  variationNote: string;
  variationHints: HintLevel;
};

export type StepResult = {
  ok: boolean;
  session: Session;
  message: string;
};

export type HintResult = {
  session: Session;
  hint: Hint | null;
};

export declare const STORAGE_KEY: string;
export declare const STEPS: readonly StepId[];
export declare const STEP_LABEL: Record<StepId, string>;
export declare const RELATED_SKILLS: readonly { id: string; title: string }[];
export declare const TEACH_QUESTION: string;
export declare const LISTINGS_CSV: string;
export declare const RETURNS_CSV: string;
export declare const EXAMPLE_RUN: { command: string; stdout: string; disclaimer: string };
export declare const VARIATION_RUN: { command: string; stdout: string; disclaimer: string };
export declare const EXAMPLE_SCRIPT: { filename: string; label: string; code: string };
export declare const VARIATION_SCRIPT: { filename: string; label: string; code: string };
export declare const MAIN_HINTS: readonly Hint[];
export declare const VARIATION_HINTS: readonly Hint[];

export declare function createSession(): Session;
export declare function words(text: string): string[];
export declare function blockReason(session: Session, step?: StepId): string;
export declare function isStepComplete(session: Session, step: StepId): boolean;
export declare function allowedSteps(session: Session): StepId[];
export declare function firstIncomplete(session: Session): StepId | null;
export declare function normalize(session: Session): Session;
export declare function present(session: Session): Session;
export declare function enter(session: Session, step: StepId): StepResult;
export declare function advance(session: Session): StepResult;
export declare function revealHint(session: Session, track: "main" | "variation"): HintResult;
export declare function shownHints(session: Session, track: "main" | "variation"): Hint[];
export declare function hintButtonLabel(level: HintLevel): string;
export declare function continueLabel(step: StepId): string;
export declare function progress(session: Session): { id: string; label: string; done: boolean }[];
export declare function teachDraft(session: Session): string;
export declare function saveLesson(session: Session): StepResult;
export declare function lessonMarkdown(session: Session, taught?: string): string;
export declare function serialize(session: Session): Session;
export declare function parseSession(input: unknown): Session | null;
