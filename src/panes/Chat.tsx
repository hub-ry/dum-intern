// The interrogation, as a scrolling column.
//
// Entries are flattened to styled lines by `lines.ts` and only the tail that
// fits is drawn. Full-screen rendering costs you the terminal's own
// scrollback, so a pane that overflows does not scroll - it silently loses the
// question you were answering. The viewport is the floor, not a feature.

import React from "react";
import { Box, Text } from "ink";
import { collapse, format } from "../lines.ts";
import type { Entry } from "../store.ts";

export function Chat({
  transcript,
  width,
  height,
}: {
  transcript: Entry[];
  width: number;
  height: number;
}) {
  const raw: string[] = [];
  for (const e of transcript) raw.push(...format(e, Math.max(24, width - 2)));
  const lines = collapse(raw);
  const shown = lines.slice(Math.max(0, lines.length - height));

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      {shown.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}
