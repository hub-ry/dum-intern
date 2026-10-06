// A repo's saved coaching mode, shared by every surface that opens it.

import type { Mode } from "./gate.ts";
import { readState, writeState } from "./workspace.ts";

type Prefs = { mode?: Mode; explained?: boolean };

/** What the first anti-vibe start after the gates tightened says, once. Each surface adds how to switch back. */
export const ANTI_VIBE = [
  "anti-vibe uses the approach you give dum, with the same skill gates as understand.",
  "",
  "- Explaining a concept here counts as recognizing it. It no longer lets dum write that concept:",
  "  that needed only an explanation in earlier versions, and now it needs your build evidence",
  "  (your own unaided implementation, submitted with :submit and reviewed) in both modes.",
  "- Tools still need recognizing. The core algorithm follows the same skill and prerequisite gates.",
  "- Skills already on your tree keep the level they have.",
].join("\n");

function readPrefs(root: string): Prefs {
  try {
    const raw: unknown = JSON.parse(readState(root, "preferences.json", 16 * 1024) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const mode = "mode" in raw && (raw.mode === "understand" || raw.mode === "anti-vibe") ? raw.mode : undefined;
    return { ...(mode ? { mode } : {}), ...("explained" in raw && raw.explained === true ? { explained: true } : {}) };
  } catch {
    return {};
  }
}

/**
 * The mode a flag chose, saved for next time, or the one saved before; understand by default.
 * The first anti-vibe start after the gates tightened says what changed, once, as a board.
 */
export function chooseMode(root: string, flag: Mode | null): { mode: Mode; changed: boolean; explain: boolean } {
  const prefs = readPrefs(root);
  const mode = flag ?? prefs.mode ?? "understand";
  const explain = mode === "anti-vibe" && !prefs.explained;
  const next: Prefs = { ...prefs, mode, ...(explain ? { explained: true } : {}) };
  const changed = mode !== (prefs.mode ?? "understand");
  if (changed || explain || (flag && !prefs.mode)) writeState(root, "preferences.json", JSON.stringify(next, null, 2) + "\n");
  return { mode, changed, explain };
}
