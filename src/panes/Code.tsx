// The file: being written, or open under your hands.
//
// One pane for both, because they are the same thing at different moments.
// While the intern writes, this follows the tail with no cursor - the
// interesting end of a file that is still arriving is the end. Once the file
// is on disk it is a buffer you can scroll, search and edit, and a file you
// open from the tree is that from the start. What every key does lives in
// editor.ts; this draws it.
//
// Buffers outlive the view. The intern starting a new file pulls the pane
// onto it, and your unsaved edits to the last one must not go with it, so
// each path keeps its buffer here until the file is saved or reloaded.

import React, { useEffect, useReducer, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { printable, slice } from "../lines.ts";
import { highlight } from "../highlight.ts";
import { dirty, open, paste, press, saved, scroll, tell, text, vcol, type Buf, type View } from "../editor.ts";
import type { CodeView } from "../store.ts";

type Entry = { source: string; buf: Buf };

export function Code({
  code,
  width,
  height,
  focused,
  onSave,
  onReload,
  onLeave,
  onTyping,
}: {
  code: CodeView | null;
  width: number;
  height: number;
  focused: boolean;
  /** Write the file. Returns what went wrong, or null. */
  onSave: (path: string, body: string) => string | null;
  /** Read the file again from disk. */
  onReload: (path: string) => void;
  /** Hand the keyboard back to the input. */
  onLeave: () => void;
  /** True while every key is text - the app must not take tab from an insert. */
  onTyping: (typing: boolean) => void;
}) {
  const buffers = useRef(new Map<string, Entry>());
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // The gutter is sized off the text before the buffer exists, because the
  // buffer's width depends on it. A trailing newline is not a line.
  const count = code ? Math.max(1, code.body.split("\n").length - (code.body.endsWith("\n") ? 1 : 0)) : 0;
  const gutter = Math.max(2, String(count).length);
  // margin, gutter, space, text, space, scrollbar, margin
  const view: View = { rows: Math.max(1, height - 2), cols: Math.max(4, width - gutter - 5) };

  const entry = code ? buffer(buffers.current, code, view) : null;
  const buf = entry?.buf ?? null;
  const typing = focused && buf?.mode === "insert";

  useEffect(() => onTyping(!!typing), [typing, onTyping]);

  const commit = (next: Buf) => {
    entry!.buf = next;
    bump();
  };

  useInput(
    (ch, key) => {
      if (!entry || !code) return;
      const { buf: next, effects } = press(entry.buf, ch, key, view);
      let out = next;
      for (const e of effects) {
        if (e === "save") {
          const err = onSave(code.path, text(out));
          out = err ? tell(out, err) : tell(saved(out), `wrote ${code.path}`);
        }
        if (e === "leave") onLeave();
        if (e === "reload") {
          buffers.current.delete(keyOf(code));
          onReload(code.path);
          return;
        }
      }
      commit(out);
    },
    { isActive: focused },
  );

  usePaste((s) => entry && commit(paste(entry.buf, s)), { isActive: focused });

  if (!code || !buf) {
    return (
      <Box width={width} flexDirection="column" paddingX={1}>
        <Text dimColor>nothing being written</Text>
        <Text dimColor>tab to the files and open one</Text>
      </Box>
    );
  }

  // Without the trailing newline, or the highlighter hands back a 17th,
  // empty line for a 16-line file and the gutter counts it.
  const lines = highlight(buf.lines.join("\n"), code.path);
  const shown = lines.slice(buf.top, buf.top + view.rows);
  const bar = scrollbar(buf.lines.length, buf.top, view.rows);
  const where = `${buf.row + 1}:${vcol(buf.lines[buf.row]!, buf.col) + 1}`;

  return (
    <Box width={width} flexDirection="column" paddingX={1}>
      <Box>
        <Text wrap="truncate-start">
          <Text bold color={tint(code)}>
            {code.path || "…"}
          </Text>
          {dirty(buf) ? <Text color="#d7a55f"> +</Text> : null}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>{focused ? where : ""}</Text>
        {focused && buf.mode === "insert" ? <Text color="#87afd7"> insert</Text> : null}
      </Box>
      <Text wrap="truncate-end">
        {buf.cmd ? (
          <>
            <Text>{buf.cmd.kind + buf.cmd.text}</Text>
            <Text inverse> </Text>
          </>
        ) : (
          <Text dimColor>{buf.message || status(code, buf)}</Text>
        )}
      </Text>
      {shown.map((line, i) => (
        <Text key={i}>
          <Text dimColor={buf.top + i !== buf.row || !focused}>{String(buf.top + i + 1).padStart(gutter)} </Text>
          {row(line.replace(/\t/g, "  "), buf, buf.top + i, view.cols, focused && !buf.cmd)}
          <Text dimColor>{" " + bar[i]}</Text>
        </Text>
      ))}
    </Box>
  );
}

const keyOf = (c: CodeView) => (c.onDisk ? `disk:${c.path}` : `${c.tool}:${c.path}`);

function whyReadOnly(c: CodeView): string {
  if (c.onDisk) return "";
  if (c.live) return "still being written";
  if (c.outcome === "held" || c.outcome === "refused") return "this was never written";
  if (c.tool === "open") return "could not read it";
  return "not on disk yet";
}

/**
 * The buffer for what the pane is showing, made or refreshed.
 *
 * Rebuilt when the text under it changes and nothing of yours is in it: a
 * streaming write changes on every chunk, a landed write swaps the fragment
 * for the file. If you HAVE edited it and the disk moved anyway, the buffer
 * stays yours and says so - dropping edits over a race the intern started is
 * not a call this pane gets to make. `:e` is the explicit version.
 */
function buffer(map: Map<string, Entry>, code: CodeView, view: View): Entry {
  const key = keyOf(code);
  const readOnly = whyReadOnly(code);
  let entry = map.get(key);
  if (entry && entry.source !== code.body) {
    if (dirty(entry.buf)) {
      entry.source = code.body;
      entry.buf = tell(entry.buf, "changed on disk under you - :e reloads it and drops your edits");
    } else {
      const was = entry.buf;
      const fresh = open(code.body, { readOnly, at: code.live ? Infinity : was.row });
      entry.buf = code.live ? fresh : { ...fresh, col: Math.min(was.col, fresh.lines[fresh.row]!.length), top: was.top, search: was.search };
      entry.source = code.body;
    }
  }
  if (!entry) {
    entry = { source: code.body, buf: open(code.body, { readOnly, at: code.live ? Infinity : code.at }) };
    map.set(key, entry);
  }
  if (entry.buf.readOnly !== readOnly) entry.buf = { ...entry.buf, readOnly };
  entry.buf = scroll(entry.buf, view);
  return entry;
}

/** One line of the window, with the cursor drawn into it. */
function row(styled: string, buf: Buf, at: number, cols: number, cursor: boolean): React.ReactNode {
  const from = buf.left;
  if (!cursor || at !== buf.row) {
    const s = slice(styled, from, from + cols);
    return <Text>{s + " ".repeat(Math.max(0, cols - printable(s).length))}</Text>;
  }
  const v = vcol(buf.lines[at]!, buf.col);
  const before = slice(styled, from, v);
  const under = printable(slice(styled, v, v + 1)) || " ";
  const after = slice(styled, v + 1, from + cols);
  const used = printable(before).length + 1 + printable(after).length;
  return (
    <Text>
      {before}
      <Text inverse>{under}</Text>
      {after + " ".repeat(Math.max(0, cols - used))}
    </Text>
  );
}

/** One character per row: the thumb, or nothing. Blank when it all fits. */
function scrollbar(total: number, top: number, rows: number): string[] {
  if (total <= rows) return new Array<string>(rows).fill(" ");
  const size = Math.max(1, Math.round((rows * rows) / total));
  const start = Math.round((top / (total - rows)) * (rows - size));
  return Array.from({ length: rows }, (_, i) => (i >= start && i < start + size ? "█" : " "));
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

function status(c: CodeView, b: Buf): string {
  if (c.live) return `${VERB[c.tool] ?? "writing"}…`;
  if (c.outcome === "held") return "held - no spec yet, this was not written";
  if (c.outcome === "refused") return "refused - outside the repo, this was not written";
  if (c.outcome === "ran") return c.onDisk ? "written" : "writing…";
  if (b.readOnly) return b.readOnly;
  return "";
}
