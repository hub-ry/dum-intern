// The two voices, with faces, and what they are saying underneath.
//
// This is the conversation now. The wizard sits on top because it speaks
// least: a voice that interrupts rarely reads as an aside, and putting it
// above the intern keeps it out of the path between a question and the answer
// you are typing.
//
// Lines type themselves out. That is not only decoration - a line that appears
// all at once is indistinguishable from a line that was already there, and the
// whole point of two speakers in one column is being able to tell that
// somebody just said something.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import { load, framesFor, draw, type Sprite } from "../sprite.ts";
import { wrap, voiceName } from "../lines.ts";
import type { State } from "../store.ts";

const ART = new URL("../art/", import.meta.url).pathname;

/** Characters per tick. Fast enough not to be a wait, slow enough to notice. */
const SPEED = 3;
const TICK = 40;

export function Cast({ state, width }: { state: State; width: number }) {
  const sprites = useMemo(() => {
    try {
      return { intern: load(ART + "intern.txt"), wizard: load(ART + "wizard.txt") };
    } catch {
      // Missing art is a cosmetic failure and must stay one.
      return null;
    }
  }, []);

  const wizardLine = lastQuip(state);
  const internLine = currentLine(state);

  const wizardSaid = useTypewriter(wizardLine);
  const internSaid = useTypewriter(internLine);

  if (!sprites) return <Box width={width} />;

  const inner = Math.max(16, width - 4);

  return (
    <Box width={width} flexDirection="column" paddingX={2}>
      <Speaker
        sprite={sprites.wizard}
        state={wizardSaid.typing ? "talking" : "idle"}
        speaking={wizardSaid.typing}
        name="wizard"
        model={voiceName(state.models.wizard.model, state.models.wizard.effort)}
        nameColor="#d7a55f"
        text={wizardSaid.shown}
        width={inner}
        dim
      />
      <Box height={1} />
      <Speaker
        sprite={sprites.intern}
        state={internState(state, internSaid.typing)}
        speaking={internSaid.typing}
        name="dum"
        model={voiceName(state.models.intern.model, state.models.intern.effort)}
        nameColor="#87afd7"
        text={internSaid.shown}
        width={inner}
        why={state.prompt?.type === "question" ? state.prompt.why : ""}
        choices={state.prompt?.type === "question" && state.prompt.choices ? "answer it · idk · type it" : ""}
      />
    </Box>
  );
}

function Speaker({
  sprite,
  state,
  speaking,
  name,
  model,
  nameColor,
  text,
  why,
  choices,
  width,
  dim,
}: {
  sprite: Sprite;
  state: string;
  speaking: boolean;
  name: string;
  /** Which model is speaking, so a voice is never a mystery box. */
  model?: string;
  nameColor: string;
  text: string;
  why?: string;
  /** The ways out of a question, so "type it" is discoverable without a manual. */
  choices?: string;
  width: number;
  dim?: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Face sprite={sprite} state={state} speaking={speaking} />
      <Box height={1} />
      <Text wrap="truncate-end">
        <Text color={nameColor} bold>
          {name}
        </Text>
        {model ? <Text dimColor>{"  " + model}</Text> : null}
      </Text>
      {(text ? wrap(text, "", width) : [""]).map((line, i) => (
        <Text key={i} dimColor={dim} wrap="truncate-end">
          {line || " "}
        </Text>
      ))}
      {why
        ? wrap(why, "", width).map((line, i) => (
            <Text key={`w${i}`} dimColor>
              {line}
            </Text>
          ))
        : null}
      {choices ? (
        <Text color="#5f8787" wrap="truncate-end">
          {choices}
        </Text>
      ) : null}
    </Box>
  );
}

function Face({
  sprite,
  state,
  speaking,
}: {
  sprite: Sprite;
  state: string;
  speaking: boolean;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Mouths move faster than idles blink.
    const t = setInterval(() => setTick((n) => n + 1), speaking ? 130 : 240);
    return () => clearInterval(t);
  }, [speaking]);

  const frames = framesFor(sprite, state);
  // A blink is an event, not a beat: alternating it evenly reads as a twitch.
  const rare = !speaking && frames[1]?.name.endsWith(".blink");
  const i =
    frames.length < 2 ? 0 : rare ? (tick % 11 === 10 ? 1 : 0) : tick % frames.length;

  return (
    <Box flexDirection="column">
      {draw(sprite, frames[i]!).map((row, n) => (
        <Text key={n}>{row}</Text>
      ))}
    </Box>
  );
}

/**
 * Reveal text a few characters at a time, restarting whenever it changes.
 *
 * Deliberately not animated per-render: the visible length lives in a ref so a
 * re-render caused by anything else - a keystroke, a sprite frame - does not
 * rewind or jump the reveal.
 */
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

function lastQuip(s: State): string {
  for (let i = s.transcript.length - 1; i >= 0; i--) {
    const e = s.transcript[i]!;
    if (e.kind === "quip") return e.text;
  }
  return "";
}

/**
 * What the intern is saying right now.
 *
 * A pending question wins over anything else: it is the thing blocking you,
 * and it must be the thing under its face.
 */
function currentLine(s: State): string {
  if (s.prompt?.type === "question") return s.prompt.question;
  if (s.prompt?.type === "spec") return "that is the spec. build it?";
  if (s.prompt?.type === "next") {
    const t = s.todos[0];
    if (t) return `your turn: ${t.concept} in ${t.path}. :w it, then say done.`;
    return s.suggestion ? `next up: ${s.suggestion}. say go, or ask for something else.` : "what next?";
  }
  if (s.busy) return "";
  for (let i = s.transcript.length - 1; i >= 0; i--) {
    const e = s.transcript[i]!;
    if (e.kind === "say") return e.text;
    if (e.kind === "note") return e.text;
  }
  return "";
}

function internState(s: State, typing: boolean): string {
  if (s.code && s.code.outcome && s.code.outcome !== "ran") return "blocked";
  if (typing || s.prompt) return "asking";
  if (s.busy && s.code?.live) return "building";
  if (s.busy) return "thinking";
  return "idle";
}
