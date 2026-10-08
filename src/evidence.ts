// The only way a session puts a skill on the tree, and what each unlock rests on. Recognition
// rests on their own words, quoted from what they just said. Build rests on files they shared,
// hashed from the full bytes, their word that they wrote them unaided, and a review that they do
// the job. A saved file alone proves nothing about who wrote it, so the record says exactly what
// was shown. One ledger for every zone, under H: a skill earned in one zone counts in all of them,
// and "not yet" holds across zone switches and restarts.

import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";
import * as web from "./web.ts";
import { withoutHeld } from "./gate.ts";
import { readState, writeState } from "./state-files.ts";
import { LEDGER_LIMITS, LedgerSchema } from "./evidence-types.ts";
import type { ExplanationInput, Ledger, Proof, Proof2, SubmissionInput } from "./evidence-types.ts";
import type { SourceSnapshot } from "./share-types.ts";
import type { SkillRef, ZoneId } from "./zone-types.ts";
import type { Store } from "./store.ts";

export type Result = { ok: boolean; why: string };
/** The zone a proof comes from. Passed per call: the service outlives any one zone. */
export type Origin = { zoneId: ZoneId; zoneName: string; store: Store };

const FILE = "evidence.json";
/** The shortest quote that can carry an explanation: "it loops" is not one. */
const MIN_QUOTE_CHARS = 12;
const MIN_QUOTE_WORDS = 3;
const MAX_QUOTE = 400;
const MAX_FEEDBACK = 400;
const MAX_WHY = 2000;
const MAX_SKILL = 200;

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
  return { name: clip(curriculum.canonical(skill, l), MAX_SKILL), lang: l };
}

/** Newest records only, within the count and byte limits. Holds are never trimmed. */
function serialize(ledger: Ledger): string {
  let records = ledger.records.slice(-LEDGER_LIMITS.records);
  for (;;) {
    const text = JSON.stringify(LedgerSchema.parse({ ...ledger, records }), null, 2) + "\n";
    if (Buffer.byteLength(text) <= LEDGER_LIMITS.bytes || !records.length) return text;
    records = records.slice(1);
  }
}

export class Evidence {
  /** Skills taken back with "not yet", by skills.id. Locked whatever the tree says, until rebuilt. */
  readonly held = new Set<string>();
  /** What each skill looked like before this run changed it, for undoing. */
  private readonly was = new Map<string, skills.Skill | null>();
  /** Put on the tree this run, newest last. What a bare "not yet" undoes. */
  private readonly checked: { name: string; lang: string }[] = [];
  private hinted = false;

  constructor(readonly home: string) {
    try {
      this.load();
    } catch {
      /* every action reloads it and refuses with the reason */
    }
  }

  /**
   * They explained a skill in their own words. `quote` must be in `userText`, what they said this
   * turn. Recognition needs its prerequisites recognized. `apply` is reasoning about using it here,
   * which counts as apply only on top of a build they already have; otherwise it's recognition.
   */
  explain(origin: Origin, e: ExplanationInput, userText: string): Result {
    const ledger = this.open(origin);
    if (!ledger.ok) return ledger.result;
    const { name, lang } = locate(e.skill, e.lang);
    const kind = e.apply ? "apply" : "recognize";
    const quote = clip(e.quote, MAX_QUOTE);
    const feedback = clip(e.feedback, MAX_FEEDBACK);
    const refuse = (why: string) => this.log(origin, { kind, skill: name, lang, ok: false, why, quote, feedback });
    if (!skills.key(name)) return refuse("no skill named");
    if (e.passed === false) return refuse("the explanation didn't hold yet - nothing recorded");
    if (!feedback) return refuse("a verdict needs a reason");
    if (!quoted(quote, userText)) return refuse("that quote isn't something they said just now, or it's too short to explain anything");
    const st = this.status(name, lang, "recognize");
    if (st.state === "locked") return refuse(`${skills.label({ name, lang })} builds on ${st.missing.join(", ")}, which they haven't shown yet`);
    const built = this.status(name, lang, "build").state === "unlocked";
    if (st.state === "unlocked" && !(e.apply && built && this.status(name, lang, "apply").state !== "unlocked")) {
      return this.log(origin, { kind, skill: name, lang, ok: true, why: `${skills.label({ name, lang })} is already ${skills.levelIn(skills.read(), name, lang)}`, quote });
    }
    // skills.unlock raises a reasoned skill to apply only over a build of this exact skill.
    const own = skills.find(skills.read(), name, lang);
    // Apply asked for without a build that stands today is recognition: "reasoned" would read an
    // older or held build straight off the raw note.
    const applies = !!e.apply && built && !!own && skills.rank(own.level) >= skills.rank("build");
    const why = applies
      ? "recorded apply: their reasoning, on top of a build"
      : e.apply
        ? "recorded recognition only: apply needs a build of it first"
        : "recorded recognition: an explanation isn't a build";
    return this.unlock(
      origin,
      {
        name,
        lang,
        how: applies ? "reasoned" : "explained",
        level: applies ? "apply" : "recognize",
        requires: curriculum.prereqs(name, lang),
        why: applies ? "reasoned about when and why to use it, after building it" : "explained what it is and what it's for, in their own words",
      },
      { kind: applies ? "apply" : "recognize", skill: name, lang, ok: true, why, quote, feedback },
      refuse,
    );
  }

  /**
   * They submitted shared files as their own implementation. Builds only with all of: their
   * unaided self-report, a passing review with a reason, complete snapshots whose bytes hash to
   * their digest and match the named paths and the skill's language, and every prerequisite built.
   */
  submit(origin: Origin, s: SubmissionInput, snapshots: SourceSnapshot[]): Result {
    const ledger = this.open(origin);
    if (!ledger.ok) return ledger.result;
    const { name, lang } = locate(s.skill, s.lang);
    // Only well-formed digests go in the ledger; a malformed one is refused below anyway.
    const files = snapshots.filter((f) => /^[0-9a-f]{64}$/.test(f.sha)).slice(0, 16).map((f) => ({ path: f.path, sha: f.sha, sourcePath: f.sourcePath }));
    const feedback = clip(s.feedback, MAX_FEEDBACK);
    const refuse = (why: string) => this.log(origin, { kind: "build", skill: name, lang, ok: false, why, files, unaided: s.unaided === true, feedback });
    if (!skills.key(name)) return refuse("no skill named");
    if (!snapshots.length) return refuse("no files were shared, so there's nothing to count");
    if (snapshots.length > 16) return refuse("too many files in one submission");
    for (const f of snapshots) {
      if (!s.paths.includes(f.path)) return refuse(`${f.path} wasn't among the files submitted`);
      if (f.complete !== true) return refuse(`${f.path} is an excerpt, not the whole file`);
      if (createHash("sha256").update(f.text).digest("hex") !== f.sha) return refuse(`${f.path} doesn't match its content hash`);
      if (!f.text.trim()) return refuse(`${f.path} is empty`);
    }
    if (lang && !snapshots.some((f) => skills.langOf(f.path) === lang)) return refuse(`none of these files is ${lang}`);
    if (!s.passed) return refuse("the review didn't pass it yet - nothing recorded");
    if (feedback.length < 8) return refuse("a passing review needs a reason");
    if (s.unaided !== true) return refuse("reviewed, not counted: building needs their word that they wrote it without AI help");
    const requires = curriculum.curated(name, lang) || curriculum.mapped(name, lang) ? curriculum.prereqs(name, lang) : (s.requires ?? []).slice(0, 3);
    const st = this.status(name, lang, "build", requires);
    if (st.state === "locked") return refuse(`${skills.label({ name, lang })} builds on ${st.missing.join(", ")}, which they haven't built yet`);
    if (st.state === "unlocked") return this.log(origin, { kind: "build", skill: name, lang, ok: true, why: `${skills.label({ name, lang })} is already built`, files, unaided: true, feedback });
    // The note may sync to the web: a file's own name and its hash, never where it lives.
    const shown = files.slice(0, 3).map((f) => `${basename(f.path)} sha256:${f.sha}`).join(", ");
    return this.unlock(
      origin,
      {
        name,
        lang,
        how: "typed",
        level: "build",
        requires,
        why: `implemented it: submitted ${shown}${files.length > 3 ? ` and ${files.length - 3} more` : ""}; self-reported unaided; reviewed as working`,
      },
      { kind: "build", skill: name, lang, ok: true, why: "recorded build: reviewed files plus their unaided self-report", files, unaided: true, feedback },
      refuse,
    );
  }

  /**
   * They added a skill to the tree by hand, saying they can write it unaided. Prerequisites must
   * be built. The record and the note say it's their word, not a review.
   */
  selfReport(origin: Origin, skill: SkillRef, unaided: true): Result {
    const ledger = this.open(origin);
    if (!ledger.ok) return ledger.result;
    const { name, lang } = locate(skill.name, skill.lang);
    const refuse = (why: string) => this.log(origin, { kind: "build", skill: name, lang, ok: false, why, unaided: unaided === true });
    if (!skills.key(name)) return refuse("no skill named");
    if (unaided !== true) return refuse("adding a skill by hand needs their word that they can write it unaided");
    const st = this.status(name, lang, "build");
    if (st.state === "locked") return refuse(`${skills.label({ name, lang })} builds on ${st.missing.join(", ")}, which they haven't built yet`);
    if (st.state === "unlocked") return this.log(origin, { kind: "build", skill: name, lang, ok: true, why: `${skills.label({ name, lang })} is already built`, unaided: true });
    return this.unlock(
      origin,
      { name, lang, how: "added", level: "build", requires: curriculum.prereqs(name, lang), why: "self-reported: they can write it unaided; not reviewed" },
      { kind: "build", skill: name, lang, ok: true, why: "recorded their self-report: their word, not a review", unaided: true },
      refuse,
    );
  }

  /**
   * "not yet": take back a skill put on the tree this run, or the last one. The hold is saved
   * before the note changes, so it outlives a zone switch or a restart.
   */
  undo(origin: Origin, name = ""): boolean {
    const target = name.trim()
      ? this.checked.find((c) => skills.key(c.name) === skills.key(name)) ?? skills.named(skills.read(), name)[0]
      : this.checked[this.checked.length - 1];
    if (!target) return false;
    const k = skills.id(target.name, target.lang);
    const prev = this.was.get(k);
    const why = prev ? "put back as it was before this run" : "taken off the tree";
    let ledger: Ledger;
    try {
      ledger = this.load();
      const held = [...new Set([...ledger.held, k])];
      this.save({ ...ledger, held, records: [...ledger.records, this.record(origin, { kind: "undo", skill: target.name, lang: target.lang, ok: true, why })] });
    } catch (err) {
      origin.store.note(`couldn't save "not yet" for ${skills.label(target)}: ${(err as Error).message}. nothing changed.`);
      return false;
    }
    this.held.add(k);
    const i = this.checked.findIndex((c) => skills.id(c.name, c.lang) === k);
    if (i >= 0) this.checked.splice(i, 1);
    // Stamped now, so a sync treats the step back as the newest word on it. A skill from before
    // this run comes off the tree: the tree is theirs to correct.
    try {
      if (prev) skills.write({ skills: [{ ...prev, at: new Date().toISOString() }] });
      else if (skills.find(skills.read(), target.name, target.lang) && !skills.remove(target.name, target.lang)) throw new Error("its note couldn't be removed");
    } catch (err) {
      origin.store.note(`${skills.label(target)} is held locked, but its note couldn't be changed: ${(err as Error).message}`);
      return true;
    }
    origin.store.setUnlocked(skills.read().skills.length);
    web.soon();
    origin.store.note(`not yet: ${skills.label(target)} stays locked until they build it again.`);
    return true;
  }

  /** The ledger, newest first, for :evidence. Only one zone's proof when `zoneId` is given. */
  describe(zoneId?: ZoneId): string {
    let records: Proof2[];
    try {
      records = this.load().records.filter((r) => !zoneId || r.zoneId === zoneId);
    } catch (err) {
      return `${(err as Error).message}. dum leaves it exactly as it is and records nothing new until you fix it or move it aside.`;
    }
    const out = [
      "how skills get on your tree:",
      "  recognize  your own words, quoted from what you just said",
      "  build      files you shared and hashed, your word you wrote them unaided, and a passing review",
      "  apply      reasoning about using it, on top of a build",
      "  suggestions, plans, screens and memory aren't evidence",
      "",
    ];
    if (!records.length) return [...out, zoneId ? "nothing recorded in this zone yet." : "nothing recorded yet."].join("\n");
    out.push(`last ${Math.min(records.length, 30)} of ${records.length}:`);
    for (const r of records.slice(-30).reverse()) {
      const files = r.files?.length ? ` · ${r.files.map((f) => `${f.path} sha256:${f.sha.slice(0, 12)}`).join(", ")}` : "";
      const where = zoneId ? "" : ` [${r.zoneName}]`;
      out.push(`${r.at.slice(0, 16).replace("T", " ")}  ${r.ok ? "✓" : "✗"} ${r.kind} ${skills.label({ name: r.skill, lang: r.lang })}${where}: ${r.why}${files}`);
      if (r.quote) out.push(`    "${r.quote}"`);
      if (r.feedback) out.push(`    review: ${r.feedback}`);
    }
    return out.join("\n");
  }

  /**
   * The ledger as stored; a missing file is an empty one. A file that can't be read or parsed
   * throws, and nothing overwrites it: its reasons aren't dum's to drop. The message names the
   * file, never its contents, which hold their words. Holds are taken from it.
   */
  private load(): Ledger {
    let raw: string | null;
    try {
      raw = readState(this.home, FILE, LEDGER_LIMITS.bytes);
    } catch (err) {
      throw new Error(`${FILE} can't be read (${(err as Error).message})`);
    }
    let ledger: Ledger = { version: 2, held: [], records: [] };
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`${FILE} isn't valid JSON`);
      }
      const r = LedgerSchema.safeParse(parsed);
      if (!r.success) throw new Error(`${FILE} isn't an evidence ledger dum can read`);
      ledger = r.data;
    }
    this.held.clear();
    for (const k of ledger.held) this.held.add(k);
    return ledger;
  }

  private save(ledger: Ledger): void {
    writeState(this.home, FILE, serialize(ledger));
  }

  private record(origin: Origin, r: Omit<Proof, "at">): Proof2 {
    return { id: randomUUID(), zoneId: origin.zoneId, zoneName: origin.zoneName, at: new Date().toISOString(), ...r, why: clip(r.why, MAX_WHY) };
  }

  /** The ledger loaded, or a refusal naming it: nothing is recorded over a ledger dum can't read. */
  private open(origin: Origin): { ok: true; ledger: Ledger } | { ok: false; result: Result } {
    try {
      return { ok: true, ledger: this.load() };
    } catch (err) {
      const why = `${(err as Error).message} - nothing recorded, and it's left exactly as it is`;
      origin.store.note(`couldn't use the evidence ledger: ${why}`);
      return { ok: false, result: { ok: false, why } };
    }
  }

  /** Where a skill stands now, conservatively: held skills don't count and prerequisites are rechecked. */
  private status(name: string, lang: string, need: skills.Level, requires?: string[]): curriculum.Status {
    return curriculum.current(withoutHeld(skills.read(), this.held), name, lang, need, requires);
  }

  /** Add a record that grants nothing. A failed write is shown; the result stands. */
  private log(origin: Origin, r: Omit<Proof, "at">): Result {
    try {
      const ledger = this.load();
      this.save({ ...ledger, records: [...ledger.records, this.record(origin, r)] });
    } catch (err) {
      origin.store.note(`couldn't save the evidence ledger: ${(err as Error).message}`);
    }
    return { ok: r.ok, why: r.why };
  }

  /**
   * Put what they just showed, at `u.level`, on the tree. The proof is saved first: no credit
   * without a record of what it rests on. Credit is reported only once the note is saved; the
   * hold is cleared last. A held skill is lifted only by a build: an unaided reviewed rebuild or
   * their explicit self-report. Recognition, a zone switch or a restart never lifts it.
   */
  private unlock(origin: Origin, u: skills.Unlock & { level: skills.Level }, proof: Omit<Proof, "at">, refuse: (why: string) => Result): Result {
    const lang = skills.langName(u.lang ?? "");
    const k = skills.id(u.name, lang);
    const t = skills.read();
    const before = skills.find(t, u.name, lang);
    const held = this.held.has(k);
    const over = held && !!before && skills.rank(before.level) > skills.rank(u.level);
    if (held && u.level !== "build") {
      return refuse(`${skills.label({ name: u.name, lang })} was taken back with "not yet" - an explanation doesn't lift that; implementing it unaided and submitting it does`);
    }
    // Under a hold the older note proves nothing today: what's written is what was shown now.
    const base = over ? { skills: t.skills.map((s) => (s === before ? { ...s, level: u.level } : s)) } : t;
    const next = skills.unlock(base, { ...u, lang });
    let ledger: Ledger;
    try {
      ledger = this.load();
      ledger = { ...ledger, records: [...ledger.records, this.record(origin, proof)] };
      this.save(ledger);
    } catch (err) {
      const why = `couldn't save the evidence ledger (${(err as Error).message}) - nothing recorded`;
      origin.store.note(why);
      return { ok: false, why };
    }
    try {
      skills.write(next);
    } catch (err) {
      const why = `the review is kept in the evidence ledger, but the skill note couldn't be saved (${(err as Error).message}) - no credit yet`;
      origin.store.note(why);
      this.log(origin, { kind: proof.kind, skill: proof.skill, lang: proof.lang, ok: false, why });
      return { ok: false, why };
    }
    if (!this.was.has(k)) this.was.set(k, before ?? null);
    if (held) {
      try {
        this.save({ ...ledger, held: ledger.held.filter((h) => h !== k) });
        this.held.delete(k);
      } catch (err) {
        origin.store.note(`${skills.label({ name: u.name, lang })} is on the tree, but its "not yet" hold couldn't be cleared: ${(err as Error).message}`);
      }
    }
    origin.store.setUnlocked(next.skills.length);
    web.soon();
    const after = skills.find(next, u.name, lang)!;
    if (held || !before || skills.rank(after.level) > skills.rank(before.level)) {
      if (!this.checked.some((c) => skills.id(c.name, c.lang) === k)) this.checked.push({ name: after.name, lang });
      // Shown, so a wrong unlock can be disputed while it's fresh.
      const hint = this.hinted ? "" : " - not yet takes it back";
      this.hinted = true;
      origin.store.note(`+ skill: ${skills.label({ name: after.name, lang })} (${after.level})${hint}`);
    }
    return { ok: true, why: proof.why };
  }
}
