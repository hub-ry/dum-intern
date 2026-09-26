// The right panel's board: what's too big to say under a face - the spec, a
// lesson, a long reply, help, the log. The characters step aside while it's up.

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { collapse, format, markdown, c } from "../lines.ts";
import { scrolls } from "../mouse.ts";
import type { Entry, Stage as StageT } from "../store.ts";

export type BoardStage = Exclude<StageT, { kind: "code" | "shell" }>;

export function isBoard(s: StageT): s is BoardStage {
  return s.kind !== "code" && s.kind !== "shell";
}

export function Board({
  stage,
  transcript,
  width,
  height,
  focused,
}: {
  stage: BoardStage;
  transcript: Entry[];
  width: number;
  height: number;
  focused: boolean;
}) {
  const page = pageFor(stage, transcript, width);
  return <Reading {...page} width={width} height={height} focused={focused} />;
}

type Page = {
  /** Changes when the content does, so a new page starts at its top. */
  id: unknown;
  title: string;
  subtitle: string;
  color: string;
  lines: string[];
  /** Start at the end rather than the beginning - right for a log, wrong for a spec. */
  tail?: boolean;
};

function pageFor(stage: BoardStage, transcript: Entry[], width: number): Page {
  switch (stage.kind) {
    case "answer":
      return {
        id: stage,
        title: stage.question,
        subtitle: stage.pending ? "looking it up…" : "nobody said this - it is a reference",
        color: "#b0b0b0",
        lines: stage.pending ? [] : wrapAt(stage.body, width - 4),
      };
    case "reply":
      return { id: stage, title: "dum", subtitle: "", color: "#87afd7", lines: markdown(stage.text, width - 4) };
    case "info":
      // Laid out by whoever wrote it - columns stay columns.
      return { id: stage, title: stage.title, subtitle: "", color: "#87afd7", lines: stage.body.split("\n") };
    case "spec":
      return {
        id: stage,
        title: "spec",
        subtitle: "approve it below, or say what to change",
        color: "#87af87",
        lines: markdown(stage.spec, width - 4),
      };
    case "lesson": {
      const l = stage.lesson;
      const lines: string[] = [];
      const section = (label: string, text: string) => {
        lines.push(c.dim(label));
        for (const w of wrapAt(text, width - 6)) lines.push("  " + w);
        lines.push("");
      };
      lines.push(c.bold(l.concept), "");
      section("what it is", l.what_it_is);
      section("why it exists", l.why_it_exists);
      section("in industry", l.in_industry);
      section("here", l.here);
      return { id: stage, title: "wizard", subtitle: "dum will ask again - it will not answer for you", color: "#d7a55f", lines };
    }
    case "transcript": {
      const lines: string[] = [];
      for (const e of transcript) lines.push(...format(e, width - 4));
      return { id: transcript.length, title: "everything said so far", subtitle: "", color: "#87afd7", lines: collapse(lines), tail: true };
    }
  }
}

function Reading({
  id,
  title,
  subtitle,
  color,
  lines,
  width,
  height,
  tail,
  focused,
}: Page & { width: number; height: number; focused: boolean }) {
  const head = subtitle ? 2 : 1;
  const room = Math.max(1, height - head);
  const last = Math.max(0, lines.length - room);
  // Where the window starts. A log starts at its end, anything else at its top.
  const [top, setTop] = useState(tail ? last : 0);
  // A new page (or a log that grew while you were at its bottom) resets it.
  const [was, setWas] = useState<{ id: unknown; last: number }>({ id, last });
  if (was.id !== id || was.last !== last) {
    const following = tail && top >= was.last;
    setWas({ id, last });
    setTop(was.id !== id ? (tail ? last : 0) : following ? last : Math.min(top, last));
  }
  const by = (n: number) => setTop((t) => Math.max(0, Math.min(last, t + n)));

  useEffect(() => {
    const f = (delta: number) => by(delta);
    scrolls.on("cast", f);
    return () => void scrolls.off("cast", f);
  });

  useInput(
    (ch, key) => {
      if (key.downArrow || ch === "j") return by(1);
      if (key.upArrow || ch === "k") return by(-1);
      if (ch === " " || key.pageDown || (key.ctrl && ch === "d")) return by(Math.max(1, Math.floor(room / 2)));
      if (ch === "b" || key.pageUp || (key.ctrl && ch === "u")) return by(-Math.max(1, Math.floor(room / 2)));
      if (ch === "g" || key.home) return setTop(0);
      if (ch === "G" || key.end) return setTop(last);
    },
    { isActive: focused },
  );

  const shown = lines.slice(top, top + room);
  const below = lines.length - top - shown.length;
  const where = lines.length > room ? `  ${top + 1}-${top + shown.length} of ${lines.length}${below ? "  ↓" : ""}` : "";

  return (
    <Box width={width} flexDirection="column" paddingX={2}>
      <Text wrap="truncate-end">
        <Text bold color={color}>
          {title}
        </Text>
        <Text dimColor>{where || "   ⇧tab: back to the characters"}</Text>
      </Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      {shown.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}

function wrapAt(text: string, width: number): string[] {
  const out: string[] = [];
  // Paragraph by paragraph, so an answer with a list or a blank line between thoughts does not
  // arrive as one wall.
  for (const para of text.split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if ((line + " " + w).trim().length > width) {
        out.push(line.trim());
        line = w;
      } else line += " " + w;
    }
    if (line.trim()) out.push(line.trim());
  }
  return out;
}
