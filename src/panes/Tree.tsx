// The repo, walkable.

import React, { useMemo, useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { scrolls } from "../mouse.ts";
import { build, rows as visible, initialOpen, type Row } from "../tree.ts";
import { clip } from "../lines.ts";

export function Tree({
  files,
  width,
  height,
  focused,
  showing,
  onOpen,
}: {
  files: string[];
  width: number;
  height: number;
  focused: boolean;
  /** Path currently in the code pane, so the tree can mark it. */
  showing?: string;
  onOpen: (path: string) => void;
}) {
  const root = useMemo(() => build(files), [files]);
  const [open, setOpen] = useState<Set<string>>(() => initialOpen(root));
  const [at, setAt] = useState(0);
  // `gg` is two keystrokes, so the first one has to be remembered.
  const [pendingG, setPendingG] = useState(false);

  const rows = visible(root, open);
  const here = rows[Math.min(at, rows.length - 1)];
  const span = Math.max(1, height - 1);

  const fold = (path: string, want: boolean) => {
    const next = new Set(open);
    if (want) next.add(path);
    else next.delete(path);
    setOpen(next);
  };

  const move = (to: number) => setAt(Math.max(0, Math.min(rows.length - 1, to)));

  // The wheel moves the selection, focused or not - it's the pointer's pane.
  useEffect(() => {
    const f = (delta: number) => setAt((a) => Math.max(0, Math.min(rows.length - 1, a + delta)));
    scrolls.on("tree", f);
    return () => void scrolls.off("tree", f);
  }, [rows.length]);

  /** Up to the containing directory, the way `h` behaves on a file in neo-tree. */
  const toParent = () => {
    const parent = here?.node.path.split("/").slice(0, -1).join("/");
    if (!parent) return;
    const i = rows.findIndex((r) => r.node.path === parent);
    if (i >= 0) move(i);
  };

  useInput(
    (ch, key) => {
      if (!rows.length) return;

      if (pendingG) {
        setPendingG(false);
        if (ch === "g") return move(0);
      }

      if (key.downArrow || ch === "j") return move(at + 1);
      if (key.upArrow || ch === "k") return move(at - 1);
      if (ch === "G") return move(rows.length - 1);
      if (ch === "g") return setPendingG(true);
      if (key.ctrl && ch === "d") return move(at + Math.floor(span / 2));
      if (key.ctrl && ch === "u") return move(at - Math.floor(span / 2));
      if (!here) return;

      const dir = here.node.dir;
      const isOpen = open.has(here.node.path);

      if (key.return || ch === "o") {
        return dir ? fold(here.node.path, !isOpen) : onOpen(here.node.path);
      }
      if (key.rightArrow || ch === "l") {
        if (dir && !isOpen) return fold(here.node.path, true);
        if (dir) return move(at + 1);
        return onOpen(here.node.path);
      }
      if (key.leftArrow || ch === "h") {
        if (dir && isOpen) return fold(here.node.path, false);
        return toParent();
      }
    },
    { isActive: focused },
  );

  // Keep the cursor on screen without letting it ride the very edge.
  const top = Math.max(0, Math.min(at - Math.floor(span / 2), rows.length - span));
  const shown = rows.slice(top, top + span);

  return (
    <Box width={width} flexDirection="column" paddingX={1}>
      <Text bold={focused} dimColor={!focused}>
        files
      </Text>
      {shown.map((row, i) => (
        <Line
          key={row.node.path}
          row={row}
          width={width - 2}
          open={open.has(row.node.path)}
          showing={row.node.path === showing}
          cursor={focused && top + i === at}
        />
      ))}
    </Box>
  );
}

function Line({
  row,
  width,
  open,
  showing,
  cursor,
}: {
  row: Row;
  width: number;
  open: boolean;
  showing: boolean;
  cursor: boolean;
}) {
  const mark = row.node.dir ? (open ? "▾ " : "▸ ") : "  ";
  const label = clip(`${"  ".repeat(row.depth)}${mark}${row.node.name}`, Math.max(6, width));
  return (
    <Text inverse={cursor} wrap="truncate-end">
      <Text
        color={showing ? "#87afd7" : undefined}
        bold={showing}
        dimColor={!row.node.dir && !showing}
      >
        {label}
      </Text>
    </Text>
  );
}
