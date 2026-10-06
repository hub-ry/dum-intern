// The skill tree as text, for any surface: the terminal's :tree and --skills, the desktop panel.

import { homedir } from "node:os";
import { readRepo } from "./repo.ts";
import { mainLang } from "./session.ts";
import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";

/** The languages worth drawing: whatever has something on the tree, plus where they're standing. */
function langsToShow(t: skills.Tree, root: string): string[] {
  const here = root ? mainLang(readRepo(root)) : "";
  return [...new Set([here, ...t.skills.map((s) => s.lang)].filter(Boolean))];
}

/**
 * The tree as text: what you know, then each track with its levels, prerequisites and what's open
 * next. `arg` picks a language or "all"; with nothing chosen and nothing to go on, every track's
 * summary, so an empty tree still shows where to start.
 */
export function treeText(t: skills.Tree, root: string, arg = ""): string {
  const want = arg.trim().toLowerCase().replace(/^in\s+/, "");
  const known = curriculum.languages();
  const lang = want && want !== "all" ? skills.langName(want) : "";
  if (lang && !known.includes(lang)) return `no curated track for "${arg.trim()}". tracks: ${known.join(", ")}.\n:tree <language> picks one; :tree all shows every track.`;
  const langs = lang ? [lang] : want === "all" ? [] : langsToShow(t, root);
  const built = t.skills.filter((s) => skills.rank(s.level) >= skills.rank("build")).length;
  const out = [t.skills.length ? `you know: ${built} built, ${t.skills.length - built} recognized only` : "you know: nothing on the tree yet", ""];
  if (want !== "all" && !langs.length) {
    for (const tr of curriculum.tracks()) {
      const p = curriculum.progress(t, tr);
      const next = curriculum.frontier(t, tr);
      out.push(`${tr.lang && tr.name !== tr.lang ? `${tr.lang} · ${tr.name}` : tr.name}  ${curriculum.bar(p.done, p.total)}  ${p.done}/${p.total}`);
      out.push(`  ○ next: ${next.slice(0, 4).join(", ") || "nothing open yet"}${next.length > 4 ? ` (+${next.length - 4})` : ""}`);
    }
    out.push("", ":tree <language> shows a track's skills, levels and prerequisites; :tree all shows them all.");
  } else out.push(...curriculum.view(t, langs, want === "all"));
  out.push(
    "",
    "● built   ◐ recognized   ○ open: its prerequisites are built   · locked",
    "AI writes a concept once you've built it, and uses a tool once you recognize it. Core algorithms follow the same prerequisites.",
    ":practice <skill> suggests a task for your own editor; :submit it when it's done. :skill x adds what you can already write.",
    `one note per skill in ${`${skills.folder()}/`.replace(homedir(), "~")}`,
  );
  return out.join("\n");
}
