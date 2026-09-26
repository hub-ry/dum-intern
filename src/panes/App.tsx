// The screen.
//
// A header, the panes, and the field. Everything below the header is a pure
// function of store state and the layout tree, so adding or moving a pane
// never means adding another way for the agent to be heard - there is exactly
// one, and it is the store.

import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { Chat } from "./Chat.tsx";
import { Stage } from "./Stage.tsx";
import { Tree } from "./Tree.tsx";
import { Cast } from "./Cast.tsx";
import { Panes } from "./Panes.tsx";
import { Field } from "./Field.tsx";
import type { Box as Rect, Node, Pane } from "../layout.ts";
import type { Prompt, Store } from "../store.ts";
import { bar } from "../lines.ts";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Focus = "input" | "tree" | "code";

export function App({ store, layout }: { store: Store; layout: Node }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { stdout } = useStdout();
  const [tick, setTick] = useState(0);
  // Three things want the keyboard: the field, the tree, and the file. Tab
  // walks them in a ring and shift-tab walks it backwards, which is the whole
  // focus model and as much as four panes should need.
  const [focus, setFocus] = useState<Focus>("input");
  // While the editor is taking text, tab is two spaces and not a focus change.
  const [typing, setTyping] = useState(false);

  // The file is only somewhere to go while the stage is showing one.
  const hasCode = state.stage.kind === "code" && state.code !== null;
  const ring: Focus[] = hasCode ? ["input", "code", "tree"] : ["input", "tree"];

  useInput((ch, key) => {
    if (key.tab && !typing) {
      const step = key.shift ? -1 : 1;
      return setFocus((f) => ring[(ring.indexOf(f) + step + ring.length) % ring.length]!);
    }
    // A chord, because the field owns every plain key while you are typing.
    if (key.ctrl && ch === "t") return store.toggleTranscript();
    if (key.ctrl && ch === "g") return store.onGraph?.();
  });

  useEffect(() => {
    if (focus === "code" && !hasCode) setFocus("input");
  }, [focus, hasCode]);

  const toInput = useCallback(() => setFocus("input"), []);
  const openFile = useCallback(
    (p: string) => {
      store.openFile(p);
      setFocus("code");
    },
    [store],
  );
  const saveFile = useCallback((p: string, body: string) => store.saveFile(p, body), [store]);
  const reloadFile = useCallback((p: string) => store.openFile(p), [store]);

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
            showing={state.code?.path}
            onOpen={openFile}
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
            focused={focus === "code"}
            onSave={saveFile}
            onReload={reloadFile}
            onLeave={toInput}
            onTyping={setTyping}
          />
        );
      case "cast":
        return <Cast state={state} width={at.width} />;
    }
  };

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box paddingX={1}>
        {/* Where you are never shrinks; the key hints give way first. As
            separate flex items these all shrank together and read as
            "dum-inte  some-repoanti-vi". */}
        <Box flexShrink={0}>
          <Text>
            <Text color="#d7a55f" bold>
              ▛▚▘{" "}
            </Text>
            <Text bold>dum-intern</Text>
            <Text dimColor>{"  " + state.repo + "  "}</Text>
            <Text color="#87afd7">{state.mode}</Text>
            <Text color="#87af87">{`  ${state.skills.known} known`}</Text>
            {state.skills.claimed ? <Text color="#87afd7">{`  ${state.skills.claimed} claimed`}</Text> : null}
            {state.skills.shaky ? <Text dimColor>{`  ${state.skills.shaky} shaky`}</Text> : null}
            {state.todos.length ? <Text color="#d7a55f">{`  ${state.todos.length} to type`}</Text> : null}
            {state.progress ? (
              <>
                <Text dimColor>{`  ${state.progress.unit} ${Math.min(state.progress.done + 1, state.progress.total)}/${state.progress.total} `}</Text>
                <Text color="#87af87">{bar(state.progress.done, state.progress.total)}</Text>
              </>
            ) : null}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} justifyContent="flex-end" marginLeft={2}>
          <Text dimColor wrap="truncate-end">
            {hint(focus, typing, hasCode)}
          </Text>
        </Box>
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

function hint(focus: Focus, typing: boolean, hasCode: boolean): string {
  if (focus === "tree") return "tab: back   j/k   h/l   ⏎ open";
  if (focus === "code") {
    return typing ? "esc: done typing   ctrl-s: save" : "tab: files   j/k   i: edit   :w   / find   esc: back";
  }
  return `tab: ${hasCode ? "file" : "files"}   ? asks anything   ctrl-t: transcript   ctrl-g: graph`;
}

function promptFor(p: Prompt): string {
  if (p?.type === "spec") return "build this? [y/N] ";
  if (p?.type === "next") return "› ";
  return "> ";
}
