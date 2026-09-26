// The screen.

import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { Chat } from "./Chat.tsx";
import { Stage } from "./Stage.tsx";
import { Tree } from "./Tree.tsx";
import { Cast } from "./Cast.tsx";
import { Board, isBoard } from "./Board.tsx";
import { Panes } from "./Panes.tsx";
import { Field } from "./Field.tsx";
import { allocate, type Box as Rect, type Node, type Pane } from "../layout.ts";
import { mouse, scrolls, type Wheel } from "../mouse.ts";
import { debug } from "../debug.ts";
import type { Prompt, Store } from "../store.ts";
import { bar } from "../lines.ts";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Focus = "input" | "tree" | "stage" | "side";

export function App({ store, layout }: { store: Store; layout: Node }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { stdout } = useStdout();
  const [tick, setTick] = useState(0);
  // Three things want the keyboard: the field, the stage, and the tree.
  const [focus, setFocus] = useState<Focus>("input");
  // While the editor is taking text, tab is two spaces and not a focus change.
  const [typing, setTyping] = useState(false);

  const hasCode = state.stage.kind === "code" && state.code !== null;
  // The board is somewhere to go only while it's up.
  const board = isBoard(state.stage);
  const ring: Focus[] = board ? ["input", "side", "stage", "tree"] : ["input", "stage", "tree"];

  const inShell = focus === "stage" && state.stage.kind === "shell";

  useInput((ch, key) => {
    // In the shell every key is the shell's (it reads them raw), except
    // shift-tab, which is the way back out.
    if (inShell) {
      // Out of the shell lands you in the input, never in whatever page is
      // underneath - a file there would take your next keystrokes as vim.
      if (key.tab && key.shift) {
        store.flipStage();
        setFocus("input");
      }
      return;
    }
    if (key.tab && !typing) {
      if (key.shift) return store.flipStage();
      return setFocus((f) => ring[(ring.indexOf(f) + 1) % ring.length]!);
    }
    // No other global chords, on purpose.
  });

  useEffect(() => {
    store.onEditorCommand = (cmd) => void scrolls.emit("code-cmd", cmd);
    return () => void (store.onEditorCommand = null);
  }, [store]);

  // Opening the shell means you're about to type into it.
  useEffect(() => {
    if (state.stage.kind === "shell") setFocus("stage");
    if (focus === "side" && !board) setFocus("input");
  }, [state.stage.kind, board, focus]);

  // The wheel scrolls whatever is under the pointer, not whatever has focus.
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const body = Math.max(3, rows - 3);
  useEffect(() => {
    const onWheel = (w: Wheel) => {
      const x = w.x - 1;
      const y = w.y - 2;
      const hit = allocate(layout, { x: 0, y: 0, width: cols, height: body }).find(
        (p) => x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height,
      );
      debug("wheel", w, "->", hit?.pane ?? "nothing", "listeners", hit ? scrolls.listenerCount(hit.pane) : 0);
      if (hit) scrolls.emit(hit.pane, w.delta);
    };
    mouse.on("wheel", onWheel);
    return () => void mouse.off("wheel", onWheel);
  }, [layout, cols, body]);

  const toInput = useCallback(() => setFocus("input"), []);
  const openFile = useCallback(
    (p: string) => {
      store.openFile(p);
      setFocus("stage");
    },
    [store],
  );
  const onCommand = useCallback(
    (e: string) => {
      if (e.startsWith("shell:")) store.onShell?.(e.slice(6));
      else if (e.startsWith("cmd:")) store.command(e.slice(4));
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
            focused={focus === "stage"}
            reply={state.reply}
            last={state.middle}
            pins={state.pins}
            onPage={(step) => store.pageStage(step)}
            onSave={saveFile}
            onReload={reloadFile}
            onLeave={toInput}
            onTyping={setTyping}
            onCommand={onCommand}
          />
        );
      case "cast":
        return isBoard(state.stage) ? (
          <Board stage={state.stage} transcript={state.transcript} width={at.width} height={at.height} focused={focus === "side"} />
        ) : (
          <Cast state={state} width={at.width} />
        );
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
            {hint(focus, typing, hasCode, inShell)}
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

function hint(focus: Focus, typing: boolean, hasCode: boolean, inShell = false): string {
  if (inShell) return "every key goes to the shell   ⇧tab: back";
  if (focus === "tree") return "tab: back   j/k   h/l   ⏎ open";
  if (focus === "side") return "tab: next   j/k   space/b   g/G   ⇧tab: characters";
  if (focus === "stage" && hasCode) {
    return typing ? "esc: done typing   ctrl-s: save" : "tab: files   j/k   i: edit   :w   :run   / find   esc: back";
  }
  return `tab: stage   ⇧tab: last page   !shell   ?ask   :run   :graph   :help`;
}

function promptFor(p: Prompt): string {
  if (p?.type === "spec") return "build this? [y/N] ";
  if (p?.type === "next") return "› ";
  return "> ";
}
