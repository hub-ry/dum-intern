// The floating companion's size, worked out from the art itself. Main sizes the window with it and the
// renderer lays the pair out with the same numbers, so neither guesses.

import { bounds, type Sprite } from "../art-parser.ts";

/** Screen points per art pixel. */
export const PIXEL = 6;
/** Space between Dum and the wizard: one art pixel. */
export const GAP = PIXEL;
/** Room above the pair for a short speech bubble. */
export const BUBBLE_HEIGHT = 64;
/** Clear space around everything, so the focus ring and the badge aren't clipped. */
export const PAD = 8;

export function companionSize(dum: Sprite, wizard: Sprite): { width: number; height: number } {
  const a = bounds(dum);
  const b = bounds(wizard);
  return {
    width: (a.cols + b.cols) * PIXEL + GAP + PAD * 2,
    height: Math.max(a.rows, b.rows) * PIXEL + BUBBLE_HEIGHT + PAD * 2,
  };
}
