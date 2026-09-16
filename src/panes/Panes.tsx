// The layout tree, rendered.
//
// Walks the same structure `layout.ts` sized, so what is drawn and what was
// measured can never disagree. Dividers are drawn between siblings rather than
// around panes, because a border on every pane doubles every interior line.

import React from "react";
import { Box, Text } from "ink";
import { isLeaf, split, type Box as Rect, type Node, type Pane } from "../layout.ts";

export function Panes({
  node,
  box,
  render,
}: {
  node: Node;
  box: Rect;
  render: (pane: Pane, box: Rect) => React.ReactNode;
}) {
  if (isLeaf(node)) return <>{render(node.pane, box)}</>;

  const kids = split(node, box);
  const row = node.direction === "row";
  return (
    <Box flexDirection={row ? "row" : "column"}>
      {kids.map((kid, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Divider row={row} length={row ? box.height : box.width} /> : null}
          <Box width={kid.box.width} height={kid.box.height} flexShrink={0}>
            <Panes node={kid.child} box={kid.box} render={render} />
          </Box>
        </React.Fragment>
      ))}
    </Box>
  );
}

function Divider({ row, length }: { row: boolean; length: number }) {
  if (row) {
    return (
      <Box flexDirection="column" width={1} flexShrink={0}>
        {Array.from({ length }, (_, i) => (
          <Text key={i} dimColor>
            │
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box height={1} flexShrink={0}>
      <Text dimColor>{"─".repeat(Math.max(0, length))}</Text>
    </Box>
  );
}
