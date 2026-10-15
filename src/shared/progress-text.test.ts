import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConceptProgress } from "../client/workshop.ts";
import { progressLines } from "./progress-text.ts";

const concept = (name: string, counts: Record<string, number>, latestAt: string | null): ConceptProgress => ({
  concept: name,
  counts,
  latest: latestAt ? Object.keys(counts).find((k) => counts[k] > 0) ?? null : null,
  latestAt,
});

test("one line per concept with its counts, taught count and the Indiana day of its latest record", () => {
  // 02:30 UTC on the 15th is still the evening of the 14th in Indiana.
  const concepts = [
    concept("arrays", { introduced: 2, attemptedWithHelp: 1, usedIndependently: 0, needsRevisiting: 0 }, "2026-10-15T02:30:00Z"),
    concept("loops", { introduced: 1, attemptedWithHelp: 0, usedIndependently: 3, needsRevisiting: 0 }, "2026-10-10T15:00:00Z"),
  ];
  const teachings = [{ concept: "arrays" }, { concept: "arrays" }, { concept: "recursion" }];

  const lines = progressLines(concepts, teachings);
  assert.equal(lines.length, 3);

  const arrays = lines.find((l) => l.startsWith("arrays"))!;
  const loops = lines.find((l) => l.startsWith("loops"))!;
  const recursion = lines.find((l) => l.startsWith("recursion"))!;
  assert.ok(arrays && loops && recursion);

  // Indiana day, not the UTC day.
  assert.match(arrays, /2026-10-14/);
  assert.doesNotMatch(arrays, /2026-10-15/);
  assert.match(loops, /2026-10-10/);

  // Each non-zero count shows as a number; a zero-count kind adds nothing.
  assert.match(arrays, /\b2\b/);
  assert.match(arrays, /\b1\b/);
  assert.match(loops, /\b1\b/);
  assert.match(loops, /\b3\b/);
  const withoutZeros = concept("loops", { introduced: 1, usedIndependently: 3 }, "2026-10-10T15:00:00Z");
  assert.deepEqual(progressLines([withoutZeros], []), [loops]);

  // Teaching is counted, never quoted.
  assert.match(arrays, /taught 2/);
  assert.match(recursion, /taught 1/);

  // Only taught: no evidence, so no date.
  assert.doesNotMatch(recursion, /\d{4}-\d{2}-\d{2}/);

  assert.deepEqual(progressLines([], []), []);
});
