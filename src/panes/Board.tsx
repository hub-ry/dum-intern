// The right panel's board: what's too big to say under a face - the plan, a
// course, a long reply, help, the log. The characters step aside while it's up.

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { collapse, format, markdown, courseLines } from "../lines.ts";
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
  question,
}: {
  stage: BoardStage;
  transcript: Entry[];
  width: number;
  height: number;
  focused: boolean;
  /** dum's open question, kept in view at the foot of the board. */
  question?: string;
}) {
  const page = pageFor(stage, transcript, width);
  const foot = question ? wrapAt(question, width - 6) : [];
  const reserve = foot.length ? foot.length + 2 : 0;
  return (
    <Box flexDirection="column" width={width}>
      <Reading {...page} closes={stage.kind !== "plan"} width={width} height={height - reserve} focused={focused} />
      {foot.length ? (
        <Box flexDirection="column" paddingX={2} marginTop={1}>
          <Text bold color="#87afd7">
            dum
          </Text>
          {foot.map((l, i) => (
            <Text key={i} wrap="truncate-end">
              {l}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

type Page = {
  /** Changes when the content does, so a new page starts at its top. */
  id: unknown;
  title: string;
  subtitle: string;
  color: string;
  lines: string[];
  /** Start at the end rather than the beginning - right for a log, wrong for a plan. */
  tail?: boolean;
};

function pageFor(stage: BoardStage, transcript: Entry[], width: number): Page {
  switch (stage.kind) {
    case "reply":
      return { id: stage, title: "dum", subtitle: "", color: "#87afd7", lines: markdown(stage.text, width - 4) };
    case "info":
      // Laid out by whoever wrote it; long lines wrap under their own indent.
      return {
        id: stage,
        title: stage.title,
        subtitle: "",
        color: "#87afd7",
        lines: stage.body.split("\n").flatMap((l) => {
          const indent = /^\s*/.exec(l)![0];
          return l.trim() ? wrapAt(l.trim(), width - 6 - indent.length).map((w) => indent + w) : [""];
        }),
      };
    case "plan":
      return {
        id: stage,
        title: "plan",
        subtitle: "y builds it · course <skill> first",
        color: "#87af87",
        lines: markdown(stage.plan, width - 4),
      };
    case "course": {
      const k = stage.card;
      return {
        id: stage,
        title: `course: ${k.lang ? `${k.skill} (${k.lang})` : k.skill}`,
        subtitle: "dum and the wizard · quit leaves it",
        color: "#d7a55f",
        lines: courseLines(k, width - 4),
      };
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
  closes,
  focused,
}: Page & { closes: boolean; width: number; height: number; focused: boolean }) {
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
  // A plan is answered, not dismissed.
  const close = closes ? "   esc: close" : "";

  return (
    <Box width={width} flexDirection="column" paddingX={2}>
      <Text wrap="truncate-end">
        <Text bold color={color}>
          {title}
        </Text>
        <Text dimColor>
          {where}
          {close}
        </Text>
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
