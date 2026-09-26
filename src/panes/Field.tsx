// A one-line text field.

import React, { useState } from "react";
import { Text, useInput, usePaste } from "ink";
import { typed, pasted, readline } from "../typing.ts";

export function Field({
  prompt,
  onSubmit,
  color,
  active = true,
}: {
  prompt: string;
  onSubmit: (value: string) => void;
  color?: string;
  active?: boolean;
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

  const before = value.slice(0, at);
  const under = value[at] ?? " ";
  const after = value.slice(at + 1);

  return (
    <Text>
      <Text color={color} bold dimColor={!active}>
        {prompt}
      </Text>
      {before}
      {active ? <Text inverse>{under}</Text> : <Text dimColor>{under}</Text>}
      {after}
    </Text>
  );
}
