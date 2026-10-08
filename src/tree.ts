// The skill tree as text, for the tree panel and the :tree command.

import { homedir } from "node:os";
import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";

/**
 * The tree as text: what you know, then each track with its levels, prerequisites and what's open
 * next. `language` is the active zone's language ("" for none); with nothing on the tree in any
 * language and no zone language, every track's summary, so an empty tree still shows where to
 * start. `filter` picks a language or "all".
 */
export function treeText(t: skills.Tree, language: string, filter = ""): string {
  const want = filter.trim().toLowerCase().replace(/^in\s+/, "");
  const known = curriculum.languages();
  const lang = want && want !== "all" ? skills.langName(want) : "";
  if (lang && !known.includes(lang)) return `no curated track for "${filter.trim()}". tracks: ${known.join(", ")}.\n:tree <language> picks one; :tree all shows every track.`;
  const langs = lang ? [lang] : want === "all" ? [] : [...new Set([skills.langName(language), ...t.skills.map((s) => s.lang)].filter(Boolean))];
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
    ":projects <skill> suggests projects that fit its scope; :submit your own work when it's done. :skill x adds what you can already write.",
    `one note per skill in ${`${skills.folder()}/`.replace(homedir(), "~")}`,
  );
  return out.join("\n");
}
