// The screen.

import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { Stage } from "./Stage.tsx";
import { Tree } from "./Tree.tsx";
import { Cast } from "./Cast.tsx";
import { Board, isBoard } from "./Board.tsx";
import { Panes } from "./Panes.tsx";
import { Field } from "./Field.tsx";
import { allocate, responsive, type Box as Rect, type Node, type Pane } from "../layout.ts";
import { mouse, scrolls, type Wheel } from "../mouse.ts";
import { debug } from "../debug.ts";
import type { Prompt, Store } from "../store.ts";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Focus = "input" | "tree" | "stage";

export function App({ store, layout: configuredLayout }: { store: Store; layout: Node }) {
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
  const inShell = state.middle === "shell" && !board ? true : state.stage.kind === "shell";
  // The shell never takes the keyboard: you type into it from the input. So
  // the middle is somewhere to go only when it's a file.
  const ring: Focus[] = inShell ? ["input", "tree"] : ["input", "stage", "tree"];

  useInput((ch, key) => {
    // ctrl-c stops what's running in the shell; with nothing running, it quits.
    if (key.ctrl && ch === "c") return store.onInterrupt?.();
    if (key.tab && !typing) {
      // shift-tab does one thing: the middle between file and shell.
      if (key.shift) {
        store.toggleMiddle();
        return setFocus("input");
      }
      return setFocus((f) => ring[(ring.indexOf(f) + 1) % ring.length]!);
    }
    // PageUp/PageDown scroll the right side (the thread or a board) from the keyboard.
    if (key.pageUp || key.pageDown) return void scrolls.emit("cast", key.pageUp ? -10 : 10);
    // esc from the input closes a board (help, a course, the log). A plan is answered instead.
    if (key.escape && focus === "input" && board && state.stage.kind !== "plan") return store.closeBoard();
  });

  useEffect(() => {
    store.onEditorCommand = (cmd) => void scrolls.emit("code-cmd", cmd);
    return () => void (store.onEditorCommand = null);
  }, [store]);

  // Showing the shell sends you to the input, which is where you type into it.
  useEffect(() => {
    if (inShell && focus === "stage") setFocus("input");
  }, [inShell, focus]);


  // The wheel scrolls whatever is under the pointer, not whatever has focus.
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const layout = useMemo(() => responsive(configuredLayout, cols), [configuredLayout, cols]);
  // The field grows with a long answer; the panes give it the room.
  const [fieldRows, setFieldRows] = useState(1);
  const body = Math.max(3, rows - 2 - fieldRows);
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

  // Clicks: a pane under the pointer takes focus; the file and shell tabs switch.
  useEffect(() => {
    const onClick = (w: Wheel) => {
      const x = w.x - 1;
      const y = w.y - 2;
      const hit = allocate(layout, { x: 0, y: 0, width: cols, height: body }).find(
        (p) => x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height,
      );
      if (!hit) return setFocus("input");
      if (hit.pane === "tree") return setFocus("tree");
      if (hit.pane === "code") {
        // The tab bar: " file " then " shell ", after a one-column margin.
        if (y === hit.y) {
          const at = x - hit.x - 1;
          if (at >= 0 && at < 6) return store.showMiddle("file");
          if (at >= 6 && at < 13) return store.showMiddle("shell");
        }
        return setFocus(state.middle === "shell" ? "input" : "stage");
      }
      setFocus("input");
    };
    mouse.on("click", onClick);
    return () => void mouse.off("click", onClick);
  }, [layout, cols, body, state.middle]);

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
      case "code":
        return (
          <Stage
            stage={state.stage}
            code={state.code}
            transcript={state.transcript}
            width={at.width}
            height={at.height}
            focused={focus === "stage"}
            last={state.middle}
            pins={state.pins}
            onSave={saveFile}
            onReload={reloadFile}
            onLeave={toInput}
            onTyping={setTyping}
            onCommand={onCommand}
          />
        );
      case "cast":
        return isBoard(state.stage) ? (
          <Board
            stage={state.stage}
            transcript={state.transcript}
            width={at.width}
            height={at.height}
            focused={false}
            question={state.prompt?.type === "question" ? state.prompt.question : undefined}
          />
        ) : (
          <Cast state={state} width={at.width} height={at.height} />
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
            <Text color="#87af87">{`  ${state.unlocked} unlocked`}</Text>
            {state.todos.length ? <Text color="#d7a55f">{`  ${state.todos.length} to ${state.mode === "anti-vibe" ? "explain" : "type"}`}</Text> : null}
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
            prompt={state.running ? `${state.running} › ` : store.inShell() ? "$ " : promptFor(state.prompt)}
            placeholder={placeholderFor(state, store.inShell())}
            color={state.prompt?.type === "plan" ? "#87af87" : state.prompt?.type === "course" ? "#d7a55f" : undefined}
            active={focus === "input"}
            onSubmit={(v) => store.submit(v.trim())}
            width={cols - 2}
            onRows={setFieldRows}
          />
        )}
      </Box>
    </Box>
  );
}

function hint(focus: Focus, typing: boolean, hasCode: boolean): string {
  if (focus === "tree") return "tab: back   j/k   h/l   ⏎ open";
  if (focus === "stage" && hasCode) {
    return typing ? "esc: done typing   ctrl-s: save" : "tab: files   j/k   i: edit   :w   :run   / find   esc: back";
  }
  return "tab: move · :skills · :help";
}

/** What typing does right now, shown grey in the empty input. */
function placeholderFor(s: ReturnType<Store["getSnapshot"]>, shell: boolean): string {
  if (s.running) return `input for ${s.running} · ctrl-c stops it`;
  if (shell) return "a command, like g++ guess.cpp -o guess · ⇧tab: back to dum";
  if (s.prompt?.type === "plan") return "y to build it · course <skill> first · or say what to change";
  if (s.prompt?.type === "course") return "done when the gap's typed · ask about it · quit leaves";
  if (s.prompt?.type === "question") return "answer dum";
  if (s.todos.length) {
    return s.mode === "anti-vibe" ? "explain it here · or course <skill> · ⇧tab: shell" : "done when it's typed · or course <skill> · ⇧tab: shell";
  }
  return "ask dum for something · course <skill> · ⇧tab: shell";
}

function promptFor(p: Prompt): string {
  if (p?.type === "plan") return "build this? [y/N] ";
  if (p?.type === "course") return "course › ";
  if (p?.type === "next") return "› ";
  return "> ";
}
