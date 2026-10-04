// Your tree as one value that can travel: every skill, and when each removed one went. Two copies
// merge by time, skill by skill, so the web page and the terminal can both change it.

import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";

export type Snapshot = { skills: skills.Skill[]; removed: Record<string, string> };

/** The tree on this machine. */
export function local(dir = skills.home()): Snapshot {
  return { skills: skills.read(dir).skills, removed: skills.removed(dir) };
}

const idOf = (s: { name: string; lang: string }) => skills.id(s.name, s.lang);

/**
 * Two copies into one. For each skill the newest word wins: a later unlock beats an earlier
 * removal and the other way round. A tie keeps the higher level.
 */
export function merge(a: Snapshot, b: Snapshot): Snapshot {
  const byId = new Map<string, skills.Skill>();
  for (const s of [...a.skills, ...b.skills]) {
    const k = idOf(s);
    const previous = byId.get(k);
    if (!previous || s.at > previous.at || (s.at === previous.at && (
      skills.rank(s.level) > skills.rank(previous.level) ||
      (s.level === previous.level && skillValue(s) > skillValue(previous))
    ))) byId.set(k, s);
  }
  const ids = new Set([...byId.keys(), ...Object.keys(a.removed), ...Object.keys(b.removed)]);
  const out: Snapshot = { skills: [], removed: {} };
  for (const k of ids) {
    const best = byId.get(k);
    const gone = [a.removed[k], b.removed[k]].filter((t): t is string => !!t).sort().pop();
    if (best && (!gone || best.at > gone)) out.skills.push(best);
    else if (gone) out.removed[k] = gone;
  }
  return out;
}

/** Make this machine's tree match a snapshot: write what's newer, delete what was removed. */
export function apply(snap: Snapshot, dir = skills.home()) {
  const here = skills.read(dir);
  const changed = snap.skills.filter((s) => {
    const mine = skills.find(here, s.name, s.lang);
    return !mine || skillValue(mine) !== skillValue(s);
  });
  if (changed.length) skills.write({ skills: changed }, dir);
  for (const s of here.skills) {
    if (snap.removed[idOf(s)]) skills.remove(s.name, s.lang, dir, snap.removed[idOf(s)]);
  }
  skills.writeRemoved(snap.removed, dir);
}

const skillValue = (s: skills.Skill) => JSON.stringify([idOf(s), s.name, s.lang, s.how, s.level, s.requires, s.why, s.at]);

/** Whether two snapshots say the same thing, for skipping a write that changes nothing. */
export function same(a: Snapshot, b: Snapshot): boolean {
  const key = (x: Snapshot) =>
    JSON.stringify([x.skills.map(skillValue).sort(), Object.entries(x.removed).sort()]);
  return key(a) === key(b);
}

export type Edit = { op: "add" | "remove"; name: string; lang: string };

/**
 * One edit from the web page, under the same rules as `:skill` in the terminal: a skill goes on
 * only above its prerequisites, and anything can come off. Returns the new snapshot, or why not.
 */
export function edit(snap: Snapshot, e: Edit, now = new Date()): Snapshot | { refused: string } {
  const lang = skills.langName(e.lang);
  const name = curriculum.canonical(e.name, lang);
  const t: skills.Tree = { skills: snap.skills };
  const label = skills.label({ name, lang });
  if (!skills.key(name)) return { refused: "a skill needs a name" };
  if (e.op === "remove") {
    const hit = skills.find(t, name, lang);
    if (!hit) return { refused: `${label} isn't on your tree` };
    return {
      skills: snap.skills.filter((s) => idOf(s) !== idOf(hit)),
      removed: { ...snap.removed, [idOf(hit)]: now.toISOString() },
    };
  }
  const st = curriculum.status(t, name, lang);
  if (st.state === "unlocked") return { refused: `${label} is already on your tree` };
  if (st.state === "locked") return { refused: `${label} builds on ${st.missing.join(", ")} - add ${st.missing.length === 1 ? "that" : "those"} first` };
  const next = skills.unlock(t, { name, lang, how: "added", requires: curriculum.prereqs(name, lang), why: "added on the web: can write it without AI" });
  const added = skills.find(next, name, lang)!;
  const { [idOf(added)]: _, ...removed } = snap.removed;
  return { skills: next.skills.map((s) => (idOf(s) === idOf(added) ? { ...s, at: now.toISOString() } : s)), removed };
}
