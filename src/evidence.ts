// The only way a session puts a skill on the tree, and what each unlock rests on. Recognition
// rests on their own words, quoted from what they just said. Build rests on a file they shared,
// hashed, their word that they wrote it unaided, and a review that it does the job. A saved file
// alone proves nothing about who wrote it, so the record says exactly what was shown.

import { basename } from "node:path";
import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";
import * as web from "./web.ts";
import { withoutHeld } from "./gate.ts";
import { readState, writeState, type Artifact } from "./workspace.ts";
import type { Store } from "./store.ts";

export type Result = { ok: boolean; why: string };

/** One thing the tree heard, kept in the project's .dum/evidence.json for :evidence. */
export type Proof = {
  at: string;
  kind: "recognize" | "apply" | "build" | "course" | "undo";
  skill: string;
  lang: string;
  ok: boolean;
  why: string;
  /** Their words the recognition rests on. Local only: never in the note, which may sync. */
  quote?: string;
  files?: { path: string; sha: string }[];
  unaided?: boolean;
  feedback?: string;
};

/** Ledger entries kept per project. */
export const MAX_RECORDS = 200;
const FILE = "evidence.json";
const MAX_FILE = 512 * 1024;
/** The shortest quote that can carry an explanation: "it loops" is not one. */
const MIN_QUOTE_CHARS = 12;
const MIN_QUOTE_WORDS = 3;
const MAX_QUOTE = 400;
const MAX_FEEDBACK = 400;

/** Words only, lower case, one space between: how a quote is found in what they said. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").trim();
}

/** Whether `quote` is something they said in `userText`, and long enough to explain anything. */
export function quoted(quote: string, userText: string): boolean {
  const q = normalize(quote);
  if (q.length < MIN_QUOTE_CHARS || q.split(" ").length < MIN_QUOTE_WORDS) return false;
  return ` ${normalize(userText)} `.includes(` ${q} `);
}

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** "http" asked for from python is the builder track's; spelled the tracks' way. */
function locate(skill: string, lang = ""): { name: string; lang: string } {
  const l = curriculum.locate(skill, lang).lang;
  return { name: curriculum.canonical(skill, l), lang: l };
}

export class Evidence {
  /** Taken back this session with "not yet", by skills.id. Locked, whatever the tree says. */
  readonly held = new Set<string>();
  /** What each skill looked like before this session changed it, for undoing. */
  private readonly was = new Map<string, skills.Skill | null>();
  /** Put on the tree this session, newest last. What a bare "not yet" undoes. */
  private readonly checked: { name: string; lang: string }[] = [];
  private hinted = false;

  constructor(
    readonly root: string,
    readonly store: Store,
  ) {}

  /**
   * They explained a skill in their own words. `quote` must be in `userText`, what they said this
   * turn. Recognition needs its prerequisites recognized. `apply` is reasoning about using it here,
   * which counts as apply only on top of a build they already have; otherwise it's recognition.
   */
  explain(e: { skill: string; lang?: string; quote: string; feedback: string; apply?: boolean; passed?: boolean }, userText: string): Result {
    const { name, lang } = locate(e.skill, e.lang);
    const kind = e.apply ? "apply" : "recognize";
    const quote = clip(e.quote, MAX_QUOTE);
    const refuse = (why: string) => this.log({ kind, skill: name, lang, ok: false, why, quote, feedback: clip(e.feedback, MAX_FEEDBACK) });
    if (!skills.key(name)) return refuse("no skill named");
    if (e.passed === false) return refuse("the explanation didn't hold yet - nothing recorded");
    if (!e.feedback.trim()) return refuse("a verdict needs a reason");
    if (!quoted(quote, userText)) return refuse("that quote isn't something they said just now, or it's too short to explain anything");
    const st = this.status(name, lang, "recognize");
    if (st.state === "locked") return refuse(`${skills.label({ name, lang })} builds on ${st.missing.join(", ")}, which they haven't shown yet`);
    const built = this.status(name, lang, "build").state === "unlocked";
    if (st.state === "unlocked" && !(e.apply && built && this.status(name, lang, "apply").state !== "unlocked")) {
      return this.log({ kind, skill: name, lang, ok: true, why: `${skills.label({ name, lang })} is already ${skills.levelIn(skills.read(), name, lang)}`, quote });
    }
    // skills.unlock raises a reasoned skill to apply only over a build of this exact skill here.
    const own = skills.find(skills.read(), name, lang);
    const applies = !!e.apply && built && !!own && skills.rank(own.level) >= skills.rank("build");
    // Apply asked for without a build that stands today is recognition: "reasoned" would read an
    // older or held build straight off the raw note.
    const held = this.unlock({
      name,
      lang,
      how: applies ? "reasoned" : "explained",
      level: applies ? "apply" : "recognize",
      requires: curriculum.prereqs(name, lang),
      why: applies ? "reasoned about when and why to use it, after building it" : "explained what it is and what it's for, in their own words",
    });
    if (held) return refuse(held);
    const why = applies
      ? "recorded apply: their reasoning, on top of a build"
      : e.apply
        ? "recorded recognition only: apply needs a build of it first"
        : "recorded recognition: an explanation isn't a build";
    return this.log({ kind: applies ? "apply" : "recognize", skill: name, lang, ok: true, why, quote, feedback: clip(e.feedback, MAX_FEEDBACK) });
  }

  /**
   * They submitted files as their own implementation. Builds only with all of: their unaided
   * self-report, a passing review with a reason, hashed artifacts matching the named paths and
   * the skill's language, and every prerequisite built.
   */
  submit(
    s: { skill: string; lang?: string; paths: string[]; unaided: boolean; feedback: string; passed: boolean; requires?: string[] },
    artifacts: Artifact[],
  ): Result {
    const { name, lang } = locate(s.skill, s.lang);
    const files = artifacts.map((a) => ({ path: a.path, sha: a.sha }));
    const feedback = clip(s.feedback, MAX_FEEDBACK);
    const refuse = (why: string) => this.log({ kind: "build", skill: name, lang, ok: false, why, files, unaided: s.unaided === true, feedback });
    if (!skills.key(name)) return refuse("no skill named");
    if (!artifacts.length) return refuse("no files were shared, so there's nothing to count");
    for (const a of artifacts) {
      if (!s.paths.includes(a.path)) return refuse(`${a.path} wasn't among the files submitted`);
      if (!/^[0-9a-f]{64}$/.test(a.sha)) return refuse(`${a.path} has no content hash`);
      if (!a.text.trim()) return refuse(`${a.path} is empty`);
    }
    if (lang && !artifacts.some((a) => skills.langOf(a.path) === lang)) return refuse(`none of these files is ${lang}`);
    if (!s.passed) return refuse("the review didn't pass it yet - nothing recorded");
    if (feedback.length < 8) return refuse("a passing review needs a reason");
    if (s.unaided !== true) return refuse("reviewed, not counted: building needs their word that they wrote it without AI help");
    const requires = curriculum.curated(name, lang) || curriculum.mapped(name, lang) ? curriculum.prereqs(name, lang) : (s.requires ?? []).slice(0, 3);
    const st = this.status(name, lang, "build", requires);
    if (st.state === "locked") return refuse(`${skills.label({ name, lang })} builds on ${st.missing.join(", ")}, which they haven't built yet`);
    if (st.state === "unlocked") return this.log({ kind: "build", skill: name, lang, ok: true, why: `${skills.label({ name, lang })} is already built`, files, unaided: true, feedback });
    // The note may sync to the web: a file's own name and its hash, never a path outside the repo.
    const shown = files.slice(0, 3).map((f) => `${basename(f.path)} sha256:${f.sha}`).join(", ");
    const held = this.unlock({
      name,
      lang,
      how: "typed",
      level: "build",
      requires,
      why: `implemented it: submitted ${shown}${files.length > 3 ? ` and ${files.length - 3} more` : ""}; self-reported unaided; reviewed as working`,
    });
    if (held) return refuse(held);
    return this.log({ kind: "build", skill: name, lang, ok: true, why: "recorded build: reviewed files plus their unaided self-report", files, unaided: true, feedback });
  }

  /**
   * A guided course finished. A tiny gap typed next to a worked example is recognition, not a
   * build: this records recognition whatever the course asked for.
   */
  course(u: skills.Unlock): Result {
    const { name, lang } = locate(u.name, u.lang);
    const st = this.status(name, lang, "recognize");
    if (st.state === "locked") {
      return this.log({ kind: "course", skill: name, lang, ok: false, why: `${skills.label({ name, lang })} builds on ${st.missing.join(", ")}` });
    }
    if (st.state === "unlocked") return this.log({ kind: "course", skill: name, lang, ok: true, why: "already recognized" });
    const held = this.unlock({ name, lang, how: "explained", level: "recognize", requires: curriculum.prereqs(name, lang), why: "finished a guided course on it; implementing it unaided is what builds it" });
    if (held) return this.log({ kind: "course", skill: name, lang, ok: false, why: held });
    return this.log({ kind: "course", skill: name, lang, ok: true, why: "recorded recognition from a guided course", feedback: clip(u.why, MAX_FEEDBACK) });
  }

  /** "not yet": take back a skill put on the tree this session, or the last one. */
  undo(name = ""): boolean {
    const target = name.trim()
      ? this.checked.find((c) => skills.key(c.name) === skills.key(name)) ?? skills.named(skills.read(), name)[0]
      : this.checked[this.checked.length - 1];
    if (!target) return false;
    const k = skills.id(target.name, target.lang);
    this.held.add(k);
    const i = this.checked.findIndex((c) => skills.id(c.name, c.lang) === k);
    if (i >= 0) this.checked.splice(i, 1);
    const prev = this.was.get(k);
    // Stamped now, so a sync treats the step back as the newest word on it. A skill from before
    // this session comes off the tree, as "not yet" always did: the tree is theirs to correct.
    if (prev) skills.write({ skills: [{ ...prev, at: new Date().toISOString() }] });
    else skills.remove(target.name, target.lang);
    this.store.setUnlocked(skills.read().skills.length);
    web.soon();
    this.store.note(`not yet: ${skills.label(target)} stays locked this session.`);
    this.log({ kind: "undo", skill: target.name, lang: target.lang, ok: true, why: prev ? "put back as it was before this session" : "taken off the tree" });
    return true;
  }

  /** The project's evidence ledger, newest first, for :evidence. */
  describe(): string {
    let records: Proof[];
    try {
      records = this.records();
    } catch (err) {
      return `${(err as Error).message}. dum leaves it exactly as it is and records nothing new until you fix it or move it aside.`;
    }
    const out = [
      "how skills get on your tree here:",
      "  recognize  your own words, quoted from what you just said",
      "  build      files you shared and hashed, your word you wrote them unaided, and a passing review",
      "  apply      reasoning about using it, on top of a build",
      "  suggestions, plans and memory aren't evidence; guided courses record recognition only",
      "",
    ];
    if (!records.length) return [...out, "nothing recorded in this project yet."].join("\n");
    out.push(`last ${Math.min(records.length, 30)} of ${records.length}:`);
    for (const r of records.slice(-30).reverse()) {
      const files = r.files?.length ? ` · ${r.files.map((f) => `${f.path} sha256:${f.sha.slice(0, 12)}`).join(", ")}` : "";
      out.push(`${r.at.slice(0, 16).replace("T", " ")}  ${r.ok ? "✓" : "✗"} ${r.kind} ${skills.label({ name: r.skill, lang: r.lang })}: ${r.why}${files}`);
      if (r.quote) out.push(`    "${r.quote}"`);
      if (r.feedback) out.push(`    review: ${r.feedback}`);
    }
    return out.join("\n");
  }

  /**
   * The ledger as stored; a missing file is an empty one. A file that can't be read or parsed
   * throws, and nothing overwrites it: its reasons aren't dum's to drop. The message names the
   * file, never its contents, which hold their words.
   */
  records(): Proof[] {
    const raw = readState(this.root, FILE, MAX_FILE);
    if (!raw) return [];
    let parsed: { records?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`.dum/${FILE} isn't valid JSON`);
    }
    const records = parsed?.records;
    if (!Array.isArray(records) || !records.every((r) => r && typeof r === "object" && typeof (r as Proof).skill === "string")) {
      throw new Error(`.dum/${FILE} isn't an evidence ledger dum can read`);
    }
    return records;
  }

  /** Where a skill stands now, conservatively: held skills don't count and prerequisites are rechecked. */
  private status(name: string, lang: string, need: skills.Level, requires?: string[]): curriculum.Status {
    return curriculum.current(withoutHeld(skills.read(), this.held), name, lang, need, requires);
  }

  /** Add a record. An unreadable ledger is never overwritten: the failure is shown instead. */
  private log(r: Omit<Proof, "at">): Result {
    try {
      const records = [...this.records(), { at: new Date().toISOString(), ...r }].slice(-MAX_RECORDS);
      writeState(this.root, FILE, JSON.stringify({ version: 1, records }, null, 2) + "\n");
    } catch (err) {
      this.store.note(`couldn't save the evidence ledger: ${(err as Error).message}`);
    }
    return { ok: r.ok, why: r.why };
  }

  /**
   * Put what they just showed, at `u.level`, on the tree. A skill taken back with "not yet" is
   * lifted only by showing it again at the level its older note claims: an explanation of a held
   * build stays held, and a reviewed unaided build replaces whatever older note is underneath.
   * Returns why nothing was recorded, or null.
   */
  private unlock(u: skills.Unlock & { level: skills.Level }): string | null {
    // Nothing goes on the tree that the project's ledger can't then show: read it first.
    try {
      this.records();
    } catch (err) {
      return `${(err as Error).message} - nothing recorded, and it's left exactly as it is`;
    }
    const lang = skills.langName(u.lang ?? "");
    const k = skills.id(u.name, lang);
    const t = skills.read();
    const before = skills.find(t, u.name, lang);
    const held = this.held.has(k);
    const over = held && !!before && skills.rank(before.level) > skills.rank(u.level);
    if (over && u.level === "recognize") {
      return `${skills.label({ name: u.name, lang })} was taken back with "not yet" this session - an explanation doesn't restore its older ${before!.level}; implementing it unaided and submitting it does`;
    }
    if (!this.was.has(k)) this.was.set(k, before ?? null);
    // Under a hold the older note proves nothing today: what's written is what was shown now.
    const base = over ? { skills: t.skills.map((s) => (s === before ? { ...s, level: u.level } : s)) } : t;
    const next = skills.unlock(base, { ...u, lang });
    skills.write(next);
    this.held.delete(k);
    this.store.setUnlocked(next.skills.length);
    web.soon();
    const after = skills.find(next, u.name, lang)!;
    if (!held && before && skills.rank(after.level) <= skills.rank(before.level)) return null;
    if (!this.checked.some((c) => skills.id(c.name, c.lang) === k)) this.checked.push({ name: after.name, lang });
    // Shown, so a wrong unlock can be disputed while it's fresh.
    const hint = this.hinted ? "" : " - not yet takes it back";
    this.hinted = true;
    this.store.note(`+ skill: ${skills.label({ name: after.name, lang })} (${after.level})${hint}`);
    return null;
  }
}
