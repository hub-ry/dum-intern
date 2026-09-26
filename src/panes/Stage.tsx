// The wide pane: whatever you are meant to be reading right now.

import React from "react";
import { Box, Text } from "ink";
import { Code } from "./Code.tsx";
import { Shell } from "./Shell.tsx";
import { isBoard } from "./Board.tsx";
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
  last,
  pins,
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
  /** Which of file or shell was last up, while a board is showing. */
  last: "file" | "shell";
  pins: Record<string, { line: number; text: string }[]>;
}) {
  const body = height - 1;
  const tabs = (
    <PageBar
      width={width}
      on={stage.kind === "shell" || (isBoard(stage) && last === "shell") ? "shell" : "file"}
      has={{ file: !!code }}
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
          pinned={pins}
        />
      </Box>
    );
  }

  if (stage.kind === "shell" || (isBoard(stage) && last === "shell")) {
    return (
      <Box flexDirection="column" width={width}>
        {tabs}
        <Shell width={width} height={body} focused={focused} />
      </Box>
    );
  }

  // Anything else is on the right panel's board; the middle keeps the code.
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
        pinned={pins}
      />
    </Box>
  );
}

/** file · reply · log, with the one you're on lit. Missing pages stay dim. */
function PageBar({
  width,
  on,
  has,
  focused,
}: {
  width: number;
  on: "file" | "shell";
  has: { file: boolean };
  focused: boolean;
}) {
  const tab = (name: "file" | "shell", there: boolean) =>
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
        {tab("shell", true)}
        <Text dimColor>{"   ⇧tab back" + (focused && on !== "shell" ? "  ←/→ pages" : "")}</Text>
      </Text>
    </Box>
  );
}

