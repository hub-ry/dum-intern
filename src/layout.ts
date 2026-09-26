// Where the panes go.

import { z } from "zod";
import { readFileSync } from "node:fs";

export const PANES = ["tree", "chat", "code", "cast"] as const;
export type Pane = (typeof PANES)[number];

const Leaf = z.object({
  pane: z.enum(PANES),
  /** Exact columns (in a row) or rows (in a column). Wins over `flex`. */
  size: z.number().int().positive().optional(),
  /** Share of whatever is left over. Defaults to 1. */
  flex: z.number().positive().optional(),
});

type LeafT = z.infer<typeof Leaf>;
export type Split = { direction: "row" | "column"; children: Node[] };
export type Node = LeafT | Split;

const Node: z.ZodType<Node> = z.lazy(() =>
  z.union([
    Leaf,
    z.object({
      direction: z.enum(["row", "column"]),
      children: z.array(Node).min(1),
    }),
  ]),
);

/** Three columns, not four. */
export const DEFAULT: Node = {
  direction: "row",
  children: [
    { pane: "tree", size: 22 },
    { pane: "code", flex: 1 },
    // Wide enough to hold a sentence under a face.
    { pane: "cast", size: 38 },
  ],
};

export function read(root: string): Node {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(`${root}/.dum/layout.json`, "utf8"));
  } catch {
    return DEFAULT;
  }
  const parsed = Node.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT;
}

export type Placed = { pane: Pane; x: number; y: number; width: number; height: number };

export function isLeaf(n: Node): n is LeafT {
  return "pane" in n;
}

/** Give every pane a concrete box. */
export type Box = { x: number; y: number; width: number; height: number };

export function allocate(node: Node, box: Box, gap = 1): Placed[] {
  if (isLeaf(node)) return [{ pane: node.pane, ...box }];
  return split(node, box, gap).flatMap((c) => allocate(c.child, c.box, gap));
}

/** One split's children, each with the box it was given. */
export function split(
  node: Split,
  box: Box,
  gap = 1,
): { child: Node; box: Box }[] {
  const row = node.direction === "row";
  const total = row ? box.width : box.height;
  const gaps = gap * (node.children.length - 1);
  let free = Math.max(0, total - gaps);

  // Fixed sizes come out first; they are a promise, not a suggestion.
  const sizes = new Array<number>(node.children.length).fill(0);
  node.children.forEach((child, i) => {
    const fixed = isLeaf(child) ? child.size : undefined;
    if (fixed === undefined) return;
    sizes[i] = Math.min(fixed, free);
    free -= sizes[i]!;
  });

  const flexed = node.children
    .map((child, i) => ({ i, flex: isLeaf(child) ? (child.size ? 0 : (child.flex ?? 1)) : (("flex" in child ? 0 : 1) as number) }))
    .filter((f) => f.flex > 0);
  const weight = flexed.reduce((a, f) => a + f.flex, 0) || 1;

  let handed = 0;
  flexed.forEach((f, n) => {
    // The last one absorbs the rounding, so the panes always fill the row exactly and no column
    // of dead space appears on the right.
    const share = n === flexed.length - 1 ? free - handed : Math.floor((free * f.flex) / weight);
    sizes[f.i] = share;
    handed += share;
  });

  const out: { child: Node; box: Box }[] = [];
  let at = row ? box.x : box.y;
  node.children.forEach((child, i) => {
    const size = sizes[i]!;
    out.push({
      child,
      box: row
        ? { x: at, y: box.y, width: size, height: box.height }
        : { x: box.x, y: at, width: box.width, height: size },
    });
    at += size + gap;
  });
  return out;
}
