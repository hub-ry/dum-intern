// The characters' side: their faces on top, and the conversation under them.
// Everything said stays in the thread, so looking at the shell never loses it.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import { load, framesFor, draw, type Sprite } from "../sprite.ts";
import { wrap, voiceName, c } from "../lines.ts";
import { scrolls } from "../mouse.ts";
import type { Entry, State } from "../store.ts";

const ART = new URL("../art/", import.meta.url).pathname;

/** Characters per tick. Fast enough not to be a wait, slow enough to notice. */
const SPEED = 3;
const TICK = 40;

const DUM = "#87afd7";
const WIZARD = "#d7a55f";

export function Cast({ state, width, height }: { state: State; width: number; height: number }) {
  const sprites = useMemo(() => {
    try {
      return { intern: load(ART + "intern.txt"), wizard: load(ART + "wizard.txt") };
    } catch {
      // Missing art is a cosmetic failure and must stay one.
      return null;
    }
  }, []);

  const inner = Math.max(16, width - 4);
  const lines = thread(state, inner);
  // The newest message types itself out, so you can tell something was just said.
  const fresh = lines.filter((l) => l.fresh);
  const typed = useTypewriter(fresh.map((l) => l.text).join("\n"));
  let left = typed.shown.length;
  const shown = lines.map((l) => {
    if (!l.fresh) return l;
    const part = l.text.slice(0, Math.max(0, left));
    left -= l.text.length + 1;
    return { ...l, text: part };
  });
  const talking = typed.typing ? fresh[0]?.who : undefined;

  // Face (4), name, model, then the rule.
  const top = sprites ? 7 : 1;
  const room = Math.max(3, height - top);
  // Follows the newest line unless you've scrolled up to read.
  const [back, setBack] = useState(0);
  const most = Math.max(0, shown.length - room);
  useEffect(() => {
    const f = (delta: number) => setBack((b) => Math.max(0, Math.min(most, b - delta)));
    scrolls.on("cast", f);
    return () => void scrolls.off("cast", f);
  }, [most]);
  useEffect(() => setBack(0), [lines.length]);
  const end = shown.length - Math.min(back, most);
  const view = shown.slice(Math.max(0, end - room), end);

  return (
    <Box width={width} height={height} flexDirection="column" paddingX={2}>
      {sprites ? (
        <Box height={top - 1} flexShrink={0}>
          <Portrait sprite={sprites.wizard} state={talking === "wizard" ? "talking" : "idle"} speaking={talking === "wizard"} name="wizard" color={WIZARD} model={voiceName(state.models.wizard.model, state.models.wizard.effort)} width={Math.floor(inner / 2)} />
          <Portrait sprite={sprites.intern} state={talking === "dum" ? "talking" : internState(state)} speaking={talking === "dum"} name="dum" color={DUM} model={voiceName(state.models.intern.model, state.models.intern.effort)} width={Math.ceil(inner / 2)} />
        </Box>
      ) : null}
      <Text dimColor>{back ? `↑ ${back} more below - scroll down` : "─".repeat(inner)}</Text>
      {view.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l.text || " "}
        </Text>
      ))}
    </Box>
  );
}

function Portrait({ sprite, state, speaking, name, color, model, width }: { sprite: Sprite; state: string; speaking: boolean; name: string; color: string; model: string; width: number }) {
  return (
    <Box flexDirection="column" width={width}>
      <Face sprite={sprite} state={state} speaking={speaking} />
      <Text bold color={color} wrap="truncate-end">
        {name}
      </Text>
      <Text dimColor wrap="truncate-end">
        {model || " "}
      </Text>
    </Box>
  );
}

export type Line = { text: string; who?: "dum" | "wizard"; fresh?: boolean };

/**
 * The conversation as lines to draw, oldest first. dum and the wizard by name,
 * your replies after a ›, and dum's own notes (skills, fills, holes) dim. The
 * open question comes last, with its why and the ways to answer.
 */
export function thread(s: State, width: number): Line[] {
  const out: Line[] = [];
  const say = (who: "dum" | "wizard", text: string, fresh = false) => {
    out.push({ text: c.bold(who === "dum" ? blue(who) : amber(who)), who });
    for (const l of wrap(text, "", width)) out.push({ text: l, who, fresh });
  };
  const note = (text: string) => {
    for (const l of wrap(text, "", width)) out.push({ text: c.dim(l) });
  };
  const you = (text: string) => {
    for (const [i, l] of wrap(text, "", width - 2).entries()) out.push({ text: (i ? "  " : c.dim("› ")) + l });
  };
  const gap = () => {
    if (out.length && out[out.length - 1]!.text) out.push({ text: "" });
  };

  const entries = s.transcript;
  entries.forEach((e: Entry, i) => {
    const newest = i === entries.length - 1;
    switch (e.kind) {
      case "say":
        gap();
        say("dum", e.text, newest);
        break;
      case "quip":
        gap();
        say("wizard", e.text, newest);
        break;
      case "review":
        gap();
        say("wizard", e.text, newest);
        break;
      case "question":
        if (e.question) {
          gap();
          say("dum", e.question, newest && e.answer === null);
          if (e.answer === null && s.prompt?.type === "question") {
            if (s.prompt.why) note(s.prompt.why);
            if (s.prompt.choices) out.push({ text: c.dim("answer it · idk · type it") });
          }
        }
        if (e.answer !== null && e.answer !== "") you(e.answer);
        break;
      case "lesson":
        gap();
        say("wizard", `${e.lesson.concept} - the whole lesson is up on the board.`, newest);
        break;
      case "spec":
        gap();
        say("dum", e.approved === null ? "the spec is up - build it?" : e.approved ? "spec approved - building." : "spec declined.", newest);
        break;
      case "answer":
        gap();
        note(`? ${e.question}`);
        for (const l of wrap(e.body, "", width).slice(0, 6)) out.push({ text: l });
        break;
      case "note":
        note(e.text);
        break;
      case "fill":
        note(`✓ filled ${e.path}: ${e.concept}`);
        break;
      case "tool":
        if (e.name === "hole") note(`▌ ${e.detail} - yours to type`);
        else if (e.outcome !== "ran") note(`${e.outcome}: ${e.name} ${e.detail}${e.why ? ` (${e.why})` : ""}`);
        break;
    }
  });

  // The turn is yours: say what's waiting, last, where the eye ends up. Wrapped, never cut.
  const turn = (text: string, hint = "") => {
    for (const l of wrap(text, "", width)) out.push({ text: blue(l) });
    if (hint) note(hint);
  };
  if (s.prompt?.type === "next") {
    const t = s.todos[0];
    gap();
    if (t) turn(`your turn: ${t.concept} in ${t.path}`, "type it and say done, or explain it here");
    else if (s.suggestion) turn(`next up: ${s.suggestion}`, "say go, or ask for something else");
    else note("what next?");
  }
  if (s.prompt?.type === "spec") {
    gap();
    turn("build this? y/n");
  }
  return out;
}

const blue = (t: string) => `\x1b[38;2;135;175;215m${t}\x1b[39m`;
const amber = (t: string) => `\x1b[38;2;215;165;95m${t}\x1b[39m`;

function Face({ sprite, state, speaking }: { sprite: Sprite; state: string; speaking: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Mouths move faster than idles blink.
    const t = setInterval(() => setTick((n) => n + 1), speaking ? 130 : 240);
    return () => clearInterval(t);
  }, [speaking]);

  const frames = framesFor(sprite, state);
  // A blink is an event, not a beat: alternating it evenly reads as a twitch.
  const rare = !speaking && frames[1]?.name.endsWith(".blink");
  const i = frames.length < 2 ? 0 : rare ? (tick % 11 === 10 ? 1 : 0) : tick % frames.length;

  return (
    <Box flexDirection="column">
      {draw(sprite, frames[i]!).map((row, n) => (
        <Text key={n}>{row}</Text>
      ))}
    </Box>
  );
}

/** Reveal text a few characters at a time, restarting whenever it changes. */
function useTypewriter(text: string): { shown: string; typing: boolean } {
  const [n, setN] = useState(0);
  const last = useRef(text);

  useEffect(() => {
    if (last.current !== text) {
      last.current = text;
      setN(0);
    }
  }, [text]);

  useEffect(() => {
    if (n >= text.length) return;
    const t = setInterval(() => setN((v) => Math.min(text.length, v + SPEED)), TICK);
    return () => clearInterval(t);
  }, [n, text]);

  return { shown: text.slice(0, n), typing: n < text.length };
}

function internState(s: State): string {
  if (s.code && s.code.outcome && s.code.outcome !== "ran") return "blocked";
  if (s.prompt) return "asking";
  if (s.busy && s.code?.live) return "building";
  if (s.busy) return "thinking";
  return "idle";
}
