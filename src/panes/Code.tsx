// The file, while it is being written.
//
// Follows the tail rather than the head: the interesting end of a file that is
// still arriving is the end. The header carries the gate's verdict, because
// this pane is the only place a held write has anything to show - the code the
// intern wanted to write, sitting there unwritten.

import React from "react";
import { Box, Text } from "ink";
import { clip } from "../lines.ts";
import { highlight } from "../highlight.ts";
import type { CodeView } from "../store.ts";

export function Code({
  code,
  width,
  height,
}: {
  code: CodeView | null;
  width: number;
  height: number;
}) {
  const inner = Math.max(12, width - 2);

  if (!code) {
    return (
      <Box width={width} flexDirection="column" paddingX={1}>
        <Text dimColor>nothing being written</Text>
      </Box>
    );
  }

  const lines = highlight(code.body, code.path);
  const shown = lines.slice(Math.max(0, lines.length - (height - 2)));
  const first = lines.length - shown.length + 1;
  const gutter = String(lines.length).length;

  return (
    <Box width={width} flexDirection="column" paddingX={1}>
      <Text wrap="truncate-start">
        <Text bold color={tint(code)}>
          {code.path || "…"}
        </Text>
      </Text>
      <Text dimColor>{status(code)}</Text>
      {shown.map((line, i) => (
        <Text key={i}>
          <Text dimColor>{String(first + i).padStart(gutter)} </Text>
          {clip(line.replace(/\t/g, "  "), Math.max(4, inner - gutter - 1))}
        </Text>
      ))}
    </Box>
  );
}

function tint(c: CodeView): string | undefined {
  if (c.outcome === "held") return "#d7a55f";
  if (c.outcome === "refused") return "#d75f5f";
  if (c.outcome === "ran") return "#87af87";
  return undefined;
}

/** Tool names are nouns; the pane needs the verb. */
const VERB: Record<string, string> = {
  Write: "writing",
  Edit: "editing",
  MultiEdit: "editing",
  NotebookEdit: "editing",
};

function status(c: CodeView): string {
  if (c.live) return `${VERB[c.tool] ?? "writing"}…`;
  if (c.outcome === "held") return "held - no spec yet, this was not written";
  if (c.outcome === "refused") return "refused - outside the repo, this was not written";
  if (c.outcome === "ran") return "written";
  return "";
}
