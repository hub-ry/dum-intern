// The wide pane: whatever you are meant to be reading right now.
//
// The conversation used to have a column of its own. It does not any more -
// the intern says one thing at a time, under its own face, and this pane shows
// the artefact being discussed instead. Which means this pane inherits the
// spec, and the spec is the one screen in the program that gates anything, so
// it gets the room rather than a box wedged under a sprite.

import React from "react";
import { Box, Text } from "ink";
import { Code } from "./Code.tsx";
import { collapse, format, markdown, c } from "../lines.ts";
import type { Entry, Stage as StageT, CodeView } from "../store.ts";

export function Stage({
  stage,
  code,
  transcript,
  width,
  height,
}: {
  stage: StageT;
  code: CodeView | null;
  transcript: Entry[];
  width: number;
  height: number;
}) {
  if (stage.kind === "code") return <Code code={code} width={width} height={height} />;

  if (stage.kind === "answer") {
    return (
      <Reading
        title={stage.question}
        subtitle={stage.pending ? "looking it up…" : "nobody said this - it is a reference"}
        color="#b0b0b0"
        lines={stage.pending ? [] : wrapAt(stage.body, width - 4)}
        width={width}
        height={height}
      />
    );
  }

  if (stage.kind === "spec") {
    return (
      <Reading
        title="spec"
        subtitle="approve it below, or say what to change"
        color="#87af87"
        lines={markdown(stage.spec, width - 4)}
        width={width}
        height={height}
      />
    );
  }

  if (stage.kind === "lesson") {
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
    return (
      <Reading
        title="wizard"
        subtitle="dum will ask again - it will not answer for you"
        color="#d7a55f"
        lines={lines}
        width={width}
        height={height}
      />
    );
  }

  const lines: string[] = [];
  for (const e of transcript) lines.push(...format(e, width - 4));
  return (
    <Reading
      title="everything said so far"
      subtitle="ctrl-t to go back"
      color="#87afd7"
      lines={collapse(lines)}
      width={width}
      height={height}
      tail
    />
  );
}

function Reading({
  title,
  subtitle,
  color,
  lines,
  width,
  height,
  tail,
}: {
  title: string;
  subtitle: string;
  color: string;
  lines: string[];
  width: number;
  height: number;
  /** Show the end rather than the beginning - right for a log, wrong for a spec. */
  tail?: boolean;
}) {
  const room = Math.max(1, height - 2);
  const shown = tail ? lines.slice(Math.max(0, lines.length - room)) : lines.slice(0, room);
  const cut = lines.length > room;

  return (
    <Box width={width} flexDirection="column" paddingX={1}>
      <Text bold color={color}>
        {title}
      </Text>
      <Text dimColor>{cut && !tail ? `${subtitle}  (${lines.length - room} more below)` : subtitle}</Text>
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
  // Paragraph by paragraph, so an answer with a list or a blank line between
  // thoughts does not arrive as one wall.
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
