// The shell page: a real shell in the middle. You type into it from the input.

import React, { useEffect, useReducer } from "react";
import { Box, Text } from "ink";
import { shell } from "../pty.ts";
import { scrolls } from "../mouse.ts";
import { slice, printable } from "../lines.ts";

export function Shell({ width, height }: { width: number; height: number; focused?: boolean }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const cols = Math.max(10, width - 2);
  const rows = Math.max(3, height);

  useEffect(() => {
    shell.resize(cols, rows);
    shell.start();
  }, [cols, rows]);

  useEffect(() => {
    shell.on("change", bump);
    return () => void shell.off("change", bump);
  }, []);

  useEffect(() => {
    const f = (delta: number) => shell.scroll(delta);
    scrolls.on("code", f);
    return () => void scrolls.off("code", f);
  }, []);

  const { rows: lines, cursor } = shell.screen();
  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      {Array.from({ length: rows }, (_, i) => {
        const line = lines[i] ?? "";
        // The cursor always shows: it's where what you type in the input lands.
        if (!cursor || cursor.y !== i) {
          return (
            <Text key={i} wrap="truncate-end">
              {line || " "}
            </Text>
          );
        }
        const before = slice(line, 0, cursor.x);
        const under = printable(slice(line, cursor.x, cursor.x + 1)) || " ";
        const after = slice(line, cursor.x + 1, cols);
        return (
          <Text key={i} wrap="truncate-end">
            {before}
            {" ".repeat(Math.max(0, cursor.x - printable(before).length))}
            <Text inverse>{under}</Text>
            {after}
          </Text>
        );
      })}
    </Box>
  );
}
