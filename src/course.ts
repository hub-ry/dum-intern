// A short course, hosted by dum and the wizard: one idea, one worked example, one small gap to
// type. Passing unlocks the skill. It's only open once everything it builds on is unlocked.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { oneShot, json } from "./oneshot.ts";
import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";
import * as todos from "./todos.ts";
import * as wizard from "./wizard.ts";
import type { CourseCard, Store } from "./store.ts";

/** Sonnet at medium: a course has to land while they're still in the mood for it. */
export const MODEL = "claude-sonnet-5-5";
const EFFORT = "medium";

/** The most lines the gap may ask for. A course is minutes, not an evening. */
export const GAP_LINES = 3;

export type Course = CourseCard & {
  /** What the course builds on, as the model sees it. Only used off the curated tracks. */
  requires: string[];
  /** The scratch file as dum wrote it, gap and all. */
  starter: string;
};

/** `course recursion`, `:course for loops in python` - or null if it isn't one. */
export function parseCommand(text: string): { skill: string; lang: string } | null {
  const m = /^:?\s*(?:course|learn|unlock)\s+(.+?)(?:\s+in\s+([\w+#.]+))?\s*$/i.exec(text.trim());
  return m ? { skill: m[1]!.trim(), lang: m[2] ? skills.langName(m[2]) : "" } : null;
}

/** A file name for a skill: "range-based for" is range-based-for. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9+]+/g, "-").replace(/\+/g, "p").replace(/^-+|-+$/g, "") || "course";
}

/** What dum says when a course isn't open yet. */
export function lockedLine(name: string, lang: string, st: Extract<curriculum.Status, { state: "locked" }>): string {
  const what = skills.label({ name, lang });
  const first = st.next && st.next !== st.missing[0] ? ` start lower: course ${st.next}` : st.next ? ` course ${st.next} first.` : "";
  return `${what} is locked - it builds on ${st.missing.join(", ")}, and you don't have ${st.missing.length === 1 ? "that" : "those"} yet.${first}`;
}

function designPrompt(name: string, lang: string, t: skills.Tree, path: string): string {
  const held = t.skills.filter((s) => s.lang === lang || !s.lang).map((s) => s.name);
  const pool = curriculum.track(lang)?.skills.map((n) => n.name) ?? [];
  return `You are dum, an intern, writing a course that takes about three minutes. One idea,
taught to someone who has exactly the skills listed below and nothing more.

THE SKILL: ${name}
LANGUAGE: ${lang}
WHAT THEY HAVE IN ${lang.toUpperCase()}: ${held.length ? held.join(", ") : "nothing yet"}

Write it like a teammate typing in a terminal: contractions, short sentences, no
openers, no cheering, plain dashes only, never an em dash. Never use anything they
don't have except the skill itself.

Reply with one JSON object and nothing else:
{
  "requires": up to three skills ${name} builds on directly${pool.length ? `, using these names where they fit: ${pool.join(", ")}` : ""},
  "lesson": two to four short sentences - what it is, and what breaks or gets painful without it,
  "example": a worked example in ${lang}, at most 8 lines, that shows it working,
  "task": one line - what to type into the gap. what, never how,
  "starter": the whole file ${path}, ready to run, with exactly one gap for them.
             The gap is a comment block in ${lang}'s comment syntax whose first line is
             exactly "TODO(dum): ${name}", then one comment line saying what it must do,
             then one stub line so the file still runs where ${lang} allows it.
             Filling the gap takes 1 to ${GAP_LINES} lines. Everything else is already written.
             The gap must not be a copy of the example - same idea, a different case,
  "run": the shell command that runs ${path} from the repo root, compiling first if ${lang} needs it
}`;
}

/** The course, or null if the model didn't produce one worth showing. */
export async function design(name: string, lang: string, t: skills.Tree, path: string): Promise<Course | null> {
  const raw = json(await oneShot(designPrompt(name, lang, t, path), { model: MODEL, effort: EFFORT }), "{");
  return toCourse(raw, name, lang, path);
}

export function toCourse(raw: unknown, name: string, lang: string, path: string): Course | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.replace(/\s*—\s*/g, " - ").trim() : "");
  const starter = typeof r.starter === "string" ? r.starter.replace(/\s+$/, "") + "\n" : "";
  if (!s(r.lesson) || !s(r.task) || todos.hole(starter, name) < 0) return null;
  return {
    skill: name,
    lang,
    lesson: s(r.lesson),
    example: typeof r.example === "string" ? r.example.replace(/^\n+|\s+$/g, "") : "",
    task: s(r.task),
    wizard: "",
    path,
    run: s(r.run),
    requires: Array.isArray(r.requires) ? r.requires.filter((x): x is string => typeof x === "string").slice(0, 3) : [],
    starter,
  };
}

export type Verdict = { passed: boolean; feedback: string };

export function toVerdict(raw: unknown): Verdict | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.passed !== "boolean" || typeof r.feedback !== "string" || !r.feedback.trim()) return null;
  return { passed: r.passed, feedback: r.feedback.replace(/\s*—\s*/g, " - ").trim() };
}

/** Did what they typed do what the gap asked? Judged like a reviewer, not against an answer key. */
export async function judge(c: Course, typed: string): Promise<Verdict | null> {
  const prompt = `You are dum, checking the one gap someone typed in a three-minute course on
${c.skill} in ${c.lang}.

THE GAP ASKED FOR: ${c.task}

THE FILE AS DUM LEFT IT:
${c.starter}

THE FILE NOW:
${typed}

Passing is the skill, so judge it like a reviewer: does their code in the gap do what it
asked, and would it run? Not whether it matches what you'd have written. A leftover
TODO comment doesn't matter.

Reply with one JSON object and nothing else:
{ "passed": true or false,
  "feedback": if it passed, one short line on what they got right. If it failed, ONE
              question that makes them run the failing case in their head - never the
              fix, never code. Contractions, no cheering, plain dashes. }`;
  return toVerdict(json(await oneShot(prompt, { model: MODEL, effort: EFFORT }), "{"));
}

/** A question asked mid-course, answered without doing the gap for them. */
export async function answer(c: Course, question: string, now: string | null): Promise<string> {
  const prompt = `You are dum, running a three-minute course on ${c.skill} in ${c.lang}.
The lesson: ${c.lesson}
The gap they're typing: ${c.task}
${now ? `Their file right now:\n${now}\n` : ""}
They asked: ${question}

Answer in two sentences at most, like a teammate. Never write the code for the gap
and never describe it line by line - a hint they can act on is fine. Plain dashes only.`;
  return (await oneShot(prompt, { model: MODEL, effort: EFFORT })).replace(/\s*—\s*/g, " - ").trim();
}

export type Ctx = {
  store: Store;
  root: string;
  /** Puts the skill on the tree, the session's way, so "not yet" can take it back. */
  unlock: (u: skills.Unlock) => void;
};

const QUIT = /^(quit|skip|exit|stop|leave|back|nevermind|never mind)[.!]*$/i;

/** Run a course start to finish. True when the skill ends up unlocked. */
export async function take(name: string, lang: string, ctx: Ctx): Promise<boolean> {
  const { store, root } = ctx;
  lang = skills.langName(lang);
  if (!lang) {
    store.say(`a course is in one language - say which: course ${name.trim()} in python`);
    return false;
  }
  const nm = curriculum.canonical(name, lang);
  const what = skills.label({ name: nm, lang });
  const st = curriculum.status(skills.read(), nm, lang);
  if (st.state === "unlocked") {
    store.note(`${what} is already unlocked.`);
    return true;
  }
  if (st.state === "locked") {
    store.say(lockedLine(nm, lang, st));
    return false;
  }

  store.working(`putting together a course on ${what}`);
  const path = `.dum/courses/${slug(nm)}.${skills.extFor(lang)}`;
  const [c, line] = await Promise.all([design(nm, lang, skills.read(), path), wizard.aside(nm, lang)]);
  if (!c) {
    store.say(`couldn't put a course on ${what} together. try again in a sec.`);
    return false;
  }
  // Off the curated tracks, the model's word on prerequisites is all there is. It's kept, and
  // the gate runs again on it before anything is shown.
  if (!curriculum.curated(nm, lang)) {
    curriculum.map(nm, lang, c.requires);
    const again = curriculum.status(skills.read(), nm, lang);
    if (again.state === "locked") {
      store.say(lockedLine(nm, lang, again));
      return false;
    }
  }
  const file = resolve(root, path);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, c.starter);
  } catch (err) {
    store.say(`couldn't write ${path}: ${(err as Error).message}`);
    return false;
  }
  const card: CourseCard = { ...c, wizard: line ?? "" };
  store.course(card);
  const at = () => Math.max(0, todos.hole(read() ?? "", nm));
  const read = () => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  store.openFile(path, at());

  for (;;) {
    const reply = (await store.askCourse(card)).trim();
    if (!reply || QUIT.test(reply)) {
      store.endCourse(card, false);
      return false;
    }
    if (/^done[.!]*$/i.test(reply)) {
      const body = read();
      if (body === null) {
        store.note(`${path} is gone - the course is over.`);
        store.endCourse(card, false);
        return false;
      }
      if (body === c.starter) {
        store.note(`${path} is still as dum left it - type the gap, :w, then done`);
        store.openFile(path, at());
        continue;
      }
      store.working("checking it");
      const v = await judge(c, body);
      if (!v) {
        store.note("couldn't check it just now - say done again.");
        continue;
      }
      store.say(v.feedback, true);
      if (!v.passed) continue;
      ctx.unlock({ name: nm, lang, how: "course", requires: curriculum.prereqs(nm, lang), why: `passed the course: ${v.feedback}` });
      store.endCourse(card, true);
      return true;
    }
    store.working("thinking");
    store.say((await answer(c, reply, read())) || "not sure - give the gap a go and say done.");
  }
}
