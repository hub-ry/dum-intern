// What the web page draws: every track as columns by depth, each skill with where it stands.
// Computed on the server with the same code the terminal uses, so the page can't disagree.

import * as skills from "../skills.ts";
import * as curriculum from "../curriculum.ts";

export type State = "built" | "recognized" | "open" | "locked";

export type NodeView = { name: string; state: State; level: skills.Level | null; needs: string[]; requires: string[]; depth: number };
export type TrackView = { name: string; lang: string; done: number; total: number; nodes: NodeView[] };
export type View = {
  tracks: TrackView[];
  /** Unlocked skills no track has: libraries, one-off ideas. */
  off: { name: string; lang: string; level: skills.Level }[];
  count: number;
};

function stateOf(t: skills.Tree, name: string, lang: string): { state: State; level: skills.Level | null; needs: string[] } {
  const level = skills.levelIn(t, name, lang);
  if (level && skills.rank(level) >= skills.rank("build")) return { state: "built", level, needs: [] };
  const st = curriculum.status(t, name, lang);
  if (level) return { state: "recognized", level, needs: st.state === "locked" ? st.missing : [] };
  return { state: st.state === "open" ? "open" : "locked", level: null, needs: st.state === "locked" ? st.missing : [] };
}

/** How many rungs sit under a skill inside its own track: 0 for the first ones. */
function depths(track: curriculum.Track): Map<string, number> {
  const byKey = new Map(track.skills.map((n) => [skills.key(n.name), n]));
  const memo = new Map<string, number>();
  const depth = (k: string, seen: Set<string>): number => {
    if (memo.has(k)) return memo.get(k)!;
    const n = byKey.get(k);
    if (!n || seen.has(k)) return 0;
    seen.add(k);
    const under = n.requires.map((r) => skills.key(r)).filter((r) => byKey.has(r));
    const d = under.length ? 1 + Math.max(...under.map((r) => depth(r, seen))) : 0;
    memo.set(k, d);
    return d;
  };
  return new Map(track.skills.map((n) => [n.name, depth(skills.key(n.name), new Set())]));
}

export function view(t: skills.Tree): View {
  const tracks = curriculum.tracks().map((tr) => {
    const d = depths(tr);
    const nodes = tr.skills.map((n) => ({ name: n.name, requires: n.requires, depth: d.get(n.name) ?? 0, ...stateOf(t, n.name, tr.lang) }));
    return { name: tr.name, lang: tr.lang, done: nodes.filter((n) => n.state === "built").length, total: nodes.length, nodes };
  });
  const off = t.skills
    .filter((s) => !curriculum.curated(s.name, s.lang))
    .map((s) => ({ name: s.name, lang: s.lang, level: s.level }))
    .sort((a, b) => (a.lang + a.name).localeCompare(b.lang + b.name));
  return { tracks, off, count: t.skills.length };
}
