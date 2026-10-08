// What Dum may do for you right now: the skills on your tree at the level you hold them today,
// and the files you've shared with this request or follow in this zone. Nothing is scanned or
// guessed: a focus skill or a shared folder never unlocks anything.

import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";
import { withoutHeld } from "./gate.ts";
import type { ShareGrant } from "./share-types.ts";
import type { SkillRef } from "./zone-types.ts";

export type Boundary = {
  skills: { skill: SkillRef; level: skills.Level; recognize: boolean; build: boolean; held: boolean }[];
  shares: ShareGrant[];
};

/**
 * Each skill's standing today: recognized means Dum may use it as a tool, built means Dum may
 * write it. A prerequisite taken back or a "not yet" closes both without touching the note.
 */
export function boundary(t: skills.Tree, shares: ShareGrant[], held: ReadonlySet<string>): Boundary {
  const live = withoutHeld(t, held);
  return {
    skills: t.skills
      .map((s) => {
        const isHeld = held.has(skills.id(s.name, s.lang));
        const at = (need: skills.Level) => !isHeld && curriculum.current(live, s.name, s.lang, need).state === "unlocked";
        return { skill: { name: s.name, lang: s.lang }, level: s.level, recognize: at("recognize"), build: at("build"), held: isHeld };
      })
      .sort((a, b) => a.skill.lang.localeCompare(b.skill.lang) || a.skill.name.localeCompare(b.skill.name)),
    shares,
  };
}

const MAX_SKILLS = 40;

/** The boundary as lines, for :boundary and the intern. */
export function lines(b: Boundary): string[] {
  const out: string[] = [];
  const built = b.skills.filter((s) => s.build);
  const tools = b.skills.filter((s) => s.recognize && !s.build);
  const closed = b.skills.filter((s) => !s.recognize);
  if (!b.skills.length) out.push("your tree is empty - Dum writes nothing for you yet; every line is yours");
  const section = (title: string, list: Boundary["skills"], note: (s: Boundary["skills"][number]) => string) => {
    if (!list.length) return;
    out.push(title);
    for (const s of list.slice(0, MAX_SKILLS)) out.push(`  ${skills.label(s.skill)}${note(s)}`);
    if (list.length > MAX_SKILLS) out.push(`  + ${list.length - MAX_SKILLS} more`);
  };
  section("Dum may write (you built it)", built, () => "");
  section("Dum may use as a tool (you recognize it; as a concept you still build it)", tools, () => "");
  section("closed for now", closed, (s) => (s.held ? " - you said not yet" : " - a prerequisite isn't yours today"));
  if (b.skills.length) out.push("core algorithms follow the same skill and prerequisite gates");
  out.push("");
  if (!b.shares.length) {
    out.push("nothing shared - share a file or folder with a message, or follow a folder in this zone, for Dum to read or change it");
    return out;
  }
  out.push("files Dum may read, and change on your command");
  for (const g of b.shares) {
    const scope = g.scope === "request" ? "shared with this request" : "followed in this zone";
    out.push(`  ${g.label}${g.kind === "folder" ? "/" : ""}  ${scope} · ${g.files.length} file${g.files.length === 1 ? "" : "s"}`);
  }
  return out;
}
