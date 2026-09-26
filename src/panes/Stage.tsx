// The wide pane: whatever you are meant to be reading right now.

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Code } from "./Code.tsx";
import { collapse, format, markdown, c } from "../lines.ts";
import { scrolls } from "../mouse.ts";
import type { Entry, Stage as StageT, CodeView } from "../store.ts";

export function Stage({
  stage,
  code,
  reply,
  transcript,
  width,
  height,
  focused,
  onSave,
  onReload,
  onLeave,
  onTyping,
  onCommand,
  onPage,
}: {
  stage: StageT;
  code: CodeView | null;
  reply: StageT | null;
  transcript: Entry[];
  width: number;
  height: number;
  focused: boolean;
  onSave: (path: string, body: string) => string | null;
  onReload: (path: string) => void;
  onLeave: () => void;
  onTyping: (typing: boolean) => void;
  onCommand: (effect: string) => void;
  onPage: (step: 1 | -1) => void;
}) {
  const body = height - 1;
  const tabs = (
    <PageBar
      width={width}
      on={stage.kind === "code" ? "file" : stage.kind === "transcript" ? "log" : "reply"}
      has={{ file: !!code, reply: !!reply }}
      focused={focused}
    />
  );

  if (stage.kind === "code") {
    return (
      <Box flexDirection="column" width={width}>
        {tabs}
        <Code
          code={code}
          width={width}
          height={body}
          focused={focused}
          onSave={onSave}
          onReload={onReload}
          onLeave={onLeave}
          onTyping={onTyping}
          onCommand={onCommand}
        />
      </Box>
    );
  }

  const page = pageFor(stage, transcript, width);
  return (
    <Box flexDirection="column" width={width}>
      {tabs}
      <Reading {...page} width={width} height={body} focused={focused} onPage={onPage} />
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
  /** Start at the end rather than the beginning - right for a log, wrong for a spec. */
  tail?: boolean;
};

function pageFor(stage: Exclude<StageT, { kind: "code" }>, transcript: Entry[], width: number): Page {
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

/** file · reply · log, with the one you're on lit. Missing pages stay dim. */
function PageBar({
  width,
  on,
  has,
  focused,
}: {
  width: number;
  on: "file" | "reply" | "log";
  has: { file: boolean; reply: boolean };
  focused: boolean;
}) {
  const tab = (name: "file" | "reply" | "log", there: boolean) =>
    name === on ? (
      <Text key={name} bold inverse={focused} color={focused ? undefined : "#87afd7"}>
        {` ${name} `}
      </Text>
    ) : (
      <Text key={name} dimColor={!there}>{` ${name} `}</Text>
    );
  return (
    <Box width={width} paddingX={1}>
      <Text wrap="truncate-end">
        {tab("file", has.file)}
        {tab("reply", has.reply)}
        {tab("log", true)}
        <Text dimColor>{"   ⇧tab back" + (focused ? "  ←/→ pages" : "")}</Text>
      </Text>
    </Box>
  );
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
  onPage,
}: Page & { width: number; height: number; focused: boolean; onPage: (step: 1 | -1) => void }) {
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
    scrolls.on("code", f);
    return () => void scrolls.off("code", f);
  });

  useInput(
    (ch, key) => {
      if (key.leftArrow || ch === "h" || ch === "[") return onPage(-1);
      if (key.rightArrow || ch === "l" || ch === "]") return onPage(1);
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
    <Box width={width} flexDirection="column" paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color={color}>
          {title}
        </Text>
        <Text dimColor>{where}</Text>
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
