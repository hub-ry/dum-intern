// The screen.
//
// A header, the panes, and the field. Everything below the header is a pure
// function of store state and the layout tree, so adding or moving a pane
// never means adding another way for the agent to be heard - there is exactly
// one, and it is the store.

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { Chat } from "./Chat.tsx";
import { Stage } from "./Stage.tsx";
import { Tree } from "./Tree.tsx";
import { Cast } from "./Cast.tsx";
import { Panes } from "./Panes.tsx";
import { Field } from "./Field.tsx";
import type { Box as Rect, Node, Pane } from "../layout.ts";
import type { Prompt, Store } from "../store.ts";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function App({ store, layout }: { store: Store; layout: Node }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { stdout } = useStdout();
  const [tick, setTick] = useState(0);
  // Only two things want the keyboard: the tree and the field. Tab is the
  // whole focus model, which is as much as four panes should need.
  const [focus, setFocus] = useState<"input" | "tree">("input");

  useInput((ch, key) => {
    if (key.tab) return setFocus((f) => (f === "input" ? "tree" : "input"));
    // A chord, because the field owns every plain key while you are typing.
    if (key.ctrl && ch === "t") return store.toggleTranscript();
  });

  useEffect(() => {
    if (!state.busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(t);
  }, [state.busy]);

  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const body = Math.max(3, rows - 3);
  const box: Rect = { x: 0, y: 0, width: cols, height: body };

  const render = (pane: Pane, at: Rect): React.ReactNode => {
    switch (pane) {
      case "tree":
        return (
          <Tree
            files={state.files}
            width={at.width}
            height={at.height}
            focused={focus === "tree"}
            showing={state.code?.tool === "open" ? state.code.path : undefined}
            onOpen={(p) => store.openFile(p)}
          />
        );
      case "chat":
        return <Chat transcript={state.transcript} width={at.width} height={at.height} />;
      case "code":
        return (
          <Stage
            stage={state.stage}
            code={state.code}
            transcript={state.transcript}
            width={at.width}
            height={at.height}
          />
        );
      case "cast":
        return <Cast state={state} width={at.width} />;
    }
  };

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box paddingX={1}>
        <Text color="#d7a55f" bold>
          ▛▚▘{" "}
        </Text>
        <Text bold>dum-intern</Text>
        <Text dimColor>{"  " + state.repo + "  "}</Text>
        <Text color="#87afd7">{state.mode}</Text>
        <Text dimColor>{"  "}</Text>
        <Text color="#87af87">{`${state.skills.known} known`}</Text>
        {state.skills.shaky ? <Text dimColor>{`  ${state.skills.shaky} shaky`}</Text> : null}
        <Box flexGrow={1} />
        <Text dimColor>
          {focus === "tree" ? "tab: back   j/k   h/l   ⏎ open" : "tab: files   ? asks anything   ctrl-t: transcript"}
        </Text>
      </Box>

      <Box height={body}>
        <Panes node={layout} box={box} render={render} />
      </Box>

      <Box paddingX={1}>
        {state.busy && !state.prompt ? (
          <Text>
            <Text color="#d7a55f">{SPIN[tick % SPIN.length]} </Text>
            <Text dimColor>{state.status || "thinking"}</Text>
          </Text>
        ) : (
          <Field
            prompt={promptFor(state.prompt)}
            color={state.prompt?.type === "spec" ? "#87af87" : undefined}
            active={focus === "input"}
            onSubmit={(v) => store.submit(v.trim())}
          />
        )}
      </Box>
    </Box>
  );
}

function promptFor(p: Prompt): string {
  if (p?.type === "spec") return "build this? [y/N] ";
  if (p?.type === "next") return "› ";
  return "> ";
}
