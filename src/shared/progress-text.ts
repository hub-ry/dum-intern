// The chat view of a goal's progression, shared by `/dum progress`, `dum_progress` and `dum_goal`.
// It shows the same thing the workshop card does: per concept, the evidence counts with the card's
// labels, how many times Ryan taught it, and the Indiana day of the last record. Counts and dates
// only. There is no threshold, no "stale" badge and no score: these are records, not mastery.

import type { ConceptProgress, Teaching } from "../client/workshop.ts";
import { localDay } from "./clock.ts";

/** Evidence kinds in the order the workshop card shows them, with its labels. */
const MARKS: ReadonlyArray<readonly [kind: string, label: string]> = [
  ["introduced", "studied"],
  ["attemptedWithHelp", "tried with help"],
  ["usedIndependently", "on your own"],
  ["needsRevisiting", "revisit"],
];

/** One line per concept that has evidence or teaching. Counts and dates only; never a score. */
export function progressLines(concepts: ConceptProgress[], teachings: Pick<Teaching, "concept">[]): string[] {
  const taught = new Map<string, number>();
  for (const t of teachings) taught.set(t.concept, (taught.get(t.concept) ?? 0) + 1);

  const lines: string[] = [];
  const seen = new Set<string>();
  for (const c of concepts) {
    seen.add(c.concept);
    lines.push(line(c.concept, c.counts, taught.get(c.concept) ?? 0, c.latestAt));
  }
  // Concepts Ryan has only taught: no evidence yet, so no date. Alphabetical, like the store's order.
  const onlyTaught = [...taught.keys()].filter((name) => !seen.has(name)).sort((a, b) => a.localeCompare(b));
  for (const name of onlyTaught) lines.push(line(name, {}, taught.get(name)!, null));
  return lines;
}

function line(concept: string, counts: Record<string, number>, taught: number, latestAt: string | null): string {
  const known = new Set(MARKS.map(([kind]) => kind));
  const marks = MARKS.filter(([kind]) => counts[kind] > 0).map(([kind, label]) => `${label} ${counts[kind]}`);
  // A kind the card doesn't know yet still shows, by its key, rather than vanishing.
  for (const [kind, n] of Object.entries(counts)) if (!known.has(kind) && n > 0) marks.push(`${kind} ${n}`);
  const parts = [marks.length ? marks.join(", ") : "no evidence", `taught ${taught}`];
  if (latestAt) parts.push(`last record ${localDay(new Date(latestAt))}`);
  return `${concept}: ${parts.join(" · ")}`;
}
