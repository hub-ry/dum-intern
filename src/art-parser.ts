// The pixel art format, with no file or terminal access: the terminal and the desktop renderer share it.

export type Frame = { name: string; rows: string[] };
export type Sprite = { palette: Map<string, string | null>; frames: Frame[] };

/** Parse the art format. Blank rows inside a frame are significant; trailing ones are trimmed. */
export function parse(text: string): Sprite {
  const palette = new Map<string, string | null>();
  const frames: Frame[] = [];
  let mode: "none" | "palette" | "frame" = "none";
  let current: Frame | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;

    if (trimmed === "palette") {
      mode = "palette";
      continue;
    }
    if (trimmed === "end" && mode === "palette") {
      mode = "none";
      continue;
    }
    if (mode === "palette") {
      if (!trimmed) continue;
      const ch = line[0]!;
      const hex = trimmed.slice(1).trim().toLowerCase();
      palette.set(ch, hex === "none" ? null : hex);
      continue;
    }
    const head = /^frame\s+(\S+)$/.exec(trimmed);
    if (head) {
      current = { name: head[1]!, rows: [] };
      frames.push(current);
      mode = "frame";
      continue;
    }
    if (mode === "frame" && current) current.rows.push(line);
  }

  for (const f of frames) while (f.rows.length && !f.rows[f.rows.length - 1]!.trim()) f.rows.pop();
  return { palette, frames };
}

/** The frames belonging to a state: `idle` plus any `idle.something`. */
export function framesFor(sprite: Sprite, state: string): Frame[] {
  const hit = sprite.frames.filter((f) => f.name === state || f.name.startsWith(state + "."));
  return hit.length ? hit : sprite.frames.slice(0, 1);
}

/** The widest and tallest any frame gets, in art pixels. */
export function bounds(sprite: Sprite): { cols: number; rows: number } {
  let cols = 0;
  let rows = 0;
  for (const f of sprite.frames) {
    rows = Math.max(rows, f.rows.length);
    for (const r of f.rows) cols = Math.max(cols, r.length);
  }
  return { cols, rows };
}
