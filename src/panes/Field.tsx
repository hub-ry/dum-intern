// A one-line text field.

import React, { useEffect, useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { typed, pasted, readline } from "../typing.ts";

export function Field({
  prompt,
  onSubmit,
  color,
  active = true,
  width = 80,
  onRows,
}: {
  prompt: string;
  onSubmit: (value: string) => void;
  color?: string;
  active?: boolean;
  /** Columns to wrap at. */
  width?: number;
  /** How many rows it's taking, so the panes above can make room. */
  onRows?: (rows: number) => void;
}) {
  const [value, setValue] = useState("");
  const [at, setAt] = useState(0);

  useInput(
    (ch, key) => {
    if (key.return) {
      onSubmit(value);
      setValue("");
      setAt(0);
      return;
    }
    // The readline keys every shell has, so a sentence can be fixed the way your fingers
    // already fix one.
    if (key.ctrl) {
      const next = readline(ch, { value, at });
      if (next) {
        setValue(next.value);
        return setAt(next.at);
      }
      return;
    }
    if (key.leftArrow) return setAt(Math.max(0, at - 1));
    if (key.rightArrow) return setAt(Math.min(value.length, at + 1));
    // Ink tells the two apart: fn-delete on a Mac and the delete key on a PC keyboard remove
    // the character under the cursor, not the one before.
    if (key.delete) return setValue(value.slice(0, at) + value.slice(at + 1));
    if (key.backspace) {
      if (!at) return;
      setValue(value.slice(0, at - 1) + value.slice(at));
      return setAt(at - 1);
    }
    // ctrl/meta chords belong to the app (focus, quit), never to the text.
    if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow) return;
    if (!ch) return;
    // A chunk can carry an Enter inside it - see typing.ts.
    const r = typed({ value, at }, ch);
    for (const line of r.submit) onSubmit(line);
    setValue(r.field.value);
    setAt(r.field.at);
    },
    { isActive: active },
  );

  usePaste(
    (text) => {
      const f = pasted({ value, at }, text);
      setValue(f.value);
      setAt(f.at);
    },
    { isActive: active },
  );

  // Wrapped, not run off the edge: a long answer stays readable while you type.
  const rows = fieldRows(prompt, value, width);
  useEffect(() => onRows?.(Math.min(MAX_ROWS, rows.length)), [rows.length, onRows]);
  useEffect(() => () => onRows?.(1), [onRows]);
  const cursor = prompt.length + at;
  const where = Math.floor(cursor / width);
  const first = Math.max(0, Math.min(where - MAX_ROWS + 1, rows.length - MAX_ROWS));

  return (
    <Box flexDirection="column">
      {rows.slice(first, first + MAX_ROWS).map((line, i) => {
        const n = first + i;
        const start = n * width;
        const text = (s: string, from: number) => {
          // The prompt part of the first row keeps its colour.
          const cut = Math.max(0, Math.min(s.length, prompt.length - from));
          return (
            <>
              <Text color={color} bold dimColor={!active}>
                {s.slice(0, cut)}
              </Text>
              {s.slice(cut)}
            </>
          );
        };
        if (n !== where) return <Text key={n}>{text(line, start)}</Text>;
        const col = cursor - start;
        const under = line[col] ?? " ";
        return (
          <Text key={n}>
            {text(line.slice(0, col), start)}
            {active ? <Text inverse>{under}</Text> : <Text dimColor>{under}</Text>}
            {line.slice(col + 1)}
          </Text>
        );
      })}
    </Box>
  );
}

/** Most rows the field grows to; past that it scrolls with the cursor. */
const MAX_ROWS = 4;

/** Prompt and text cut into rows of `width`, with room for the cursor at the end. */
export function fieldRows(prompt: string, value: string, width: number): string[] {
  const all = prompt + value + " ";
  const w = Math.max(1, width);
  const out: string[] = [];
  for (let i = 0; i < all.length; i += w) out.push(all.slice(i, i + w));
  return out.length ? out : [""];
}
