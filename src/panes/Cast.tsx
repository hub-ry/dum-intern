// The two voices, with faces.
//
// They are not decoration so much as a status light you can read without
// parsing text: the intern is asking, thinking, building, or stopped, and the
// wizard is either quiet or has just said something. Both states already exist
// in the store - this pane only gives them a shape.

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { load, framesFor, draw, type Sprite } from "../sprite.ts";
import type { State } from "../store.ts";

const ART = new URL("../art/", import.meta.url).pathname;

export function Cast({ state, width }: { state: State; width: number }) {
  const sprites = useMemo(() => {
    try {
      return { intern: load(ART + "intern.txt"), wizard: load(ART + "wizard.txt") };
    } catch {
      // Missing art is a cosmetic failure and must stay one.
      return null;
    }
  }, []);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 220);
    return () => clearInterval(t);
  }, []);

  // The wizard talks for a beat after a quip lands, then goes quiet again.
  const quips = state.transcript.filter((e) => e.kind === "quip").length;
  const [talkingUntil, setTalkingUntil] = useState(0);
  useEffect(() => {
    if (quips) setTalkingUntil(Date.now() + 3500);
  }, [quips]);

  if (!sprites) return <Box width={width} />;

  const talking = Date.now() < talkingUntil;
  return (
    <Box width={width} flexDirection="column" paddingX={1}>
      <Character sprite={sprites.intern} state={internState(state)} tick={tick} />
      <Text dimColor>{internState(state)}</Text>
      <Box height={1} />
      <Character
        sprite={sprites.wizard}
        state={talking ? "talking" : state.busy ? "pondering" : "idle"}
        tick={tick}
      />
      <Text dimColor>{talking ? "the wizard" : "wizard"}</Text>
    </Box>
  );
}

function Character({ sprite, state, tick }: { sprite: Sprite; state: string; tick: number }) {
  const frames = framesFor(sprite, state);
  // A blink is an event, not a beat: alternating it evenly reads as a twitch.
  const rare = frames[1]?.name.endsWith(".blink");
  const i = frames.length < 2 ? 0 : rare ? (tick % 11 === 10 ? 1 : 0) : tick % frames.length;
  return (
    <Box flexDirection="column">
      {draw(sprite, frames[i]!).map((row, n) => (
        <Text key={n}>{row}</Text>
      ))}
    </Box>
  );
}

function internState(s: State): string {
  if (s.code && s.code.outcome && s.code.outcome !== "ran") return "blocked";
  if (s.prompt) return "asking";
  if (s.busy && s.code?.live) return "building";
  if (s.busy) return "thinking";
  return "idle";
}
