// The repo as something you can walk.
//
// Built from the tracked-file list `repo.ts` already collects, so what you can
// navigate is exactly what the intern can see. Note that the MAX_FILES cap in
// repo.ts is about what the MODEL is shown and deliberately does not apply
// here - a tree that silently stops at 200 entries is a tree that lies about
// the repo.

export type Node = {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
};

export type Row = { node: Node; depth: number };

/** Nest a flat list of paths. */
export function build(files: string[]): Node {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  for (const file of files) {
    const parts = file.split("/").filter(Boolean);
    let at = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let next = at.children.find((c) => c.name === part && c.dir === !last);
      if (!next) {
        next = { name: part, path, dir: !last, children: [] };
        at.children.push(next);
      }
      at = next;
    });
  }
  sort(root);
  return root;
}

function sort(n: Node) {
  // Directories first, then alphabetical. The alternative is hunting for a
  // folder in among two hundred files.
  n.children.sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
  );
  for (const c of n.children) sort(c);
}

/** The rows currently visible, given which directories are expanded. */
export function rows(root: Node, open: ReadonlySet<string>): Row[] {
  const out: Row[] = [];
  const walk = (n: Node, depth: number) => {
    for (const c of n.children) {
      out.push({ node: c, depth });
      if (c.dir && open.has(c.path)) walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Directories to expand so that every top-level entry is visible at rest. */
export function initialOpen(root: Node, budget = 40): Set<string> {
  const open = new Set<string>();
  // Expand a chain of single-child directories - `src/main/java/...` shown
  // collapsed one level at a time is four keystrokes to reach the first file.
  for (const c of root.children) {
    let at = c;
    while (at.dir && at.children.length === 1 && at.children[0]!.dir && open.size < budget) {
      open.add(at.path);
      at = at.children[0]!;
    }
  }
  return open;
}
