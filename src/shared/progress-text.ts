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

export type ProgressLinesOptions = {
  /** Clip concept names longer than this (Discord keeps lines short). Unset means no clipping. */
  maxConceptLength?: number;
};

/** One line per concept that has evidence or teaching, alphabetical by concept. Counts and dates only; never a score. */
export function progressLines(
  concepts: ConceptProgress[],
  teachings: Pick<Teaching, "concept">[],
  options: ProgressLinesOptions = {},
): string[] {
  const taught = new Map<string, number>();
  for (const t of teachings) taught.set(t.concept, (taught.get(t.concept) ?? 0) + 1);

  const rows = new Map<string, { counts: Record<string, number>; latestAt: string | null }>();
  for (const c of concepts) rows.set(c.concept, { counts: c.counts, latestAt: c.latestAt });
  // Concepts Ryan has only taught: no evidence yet, so no date.
  for (const name of taught.keys()) if (!rows.has(name)) rows.set(name, { counts: {}, latestAt: null });

  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, row]) => line(clip(name, options.maxConceptLength), row.counts, taught.get(name) ?? 0, row.latestAt));
}

function clip(text: string, max: number | undefined): string {
  return max === undefined || text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function line(concept: string, counts: Record<string, number>, taught: number, latestAt: string | null): string {
  const marks = MARKS.filter(([kind]) => counts[kind] > 0).map(([kind, label]) => `${label} ${counts[kind]}`);
  const parts = [marks.length ? marks.join(", ") : "no evidence", `taught ${taught}`];
  if (latestAt) parts.push(`last record ${localDay(new Date(latestAt))}`);
  return `${concept}: ${parts.join(" · ")}`;
}
