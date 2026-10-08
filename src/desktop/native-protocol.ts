// Private line protocols between main and its native helpers: the OpenSuperWhisper voice bridge and
// the focus helper. One JSON object per line; main validates every event and rejects anything else.

import { z } from "zod";
import { InputBindingSchema, TokenSchema } from "../share-types.ts";
import { AppSignalSchema } from "../observe-types.ts";
import type { InputBinding } from "../share-types.ts";
import type { AppSignal } from "../observe-types.ts";

export type DictationStatus = { supported: boolean; available: boolean; version: string | null; bridge: boolean; message: string };
/** Never audio: a phase, the recording it belongs to, and a bounded status line. */
export type VoiceState = { phase: "idle" | "recording" | "transcribing" | "ready" | "error"; recordingId: string | null; status: string };

/** Final transcript bound, in UTF-8 bytes. */
export const MAX_TRANSCRIPT_BYTES = 32 * 1024;

/** Main → voice bridge. A null gesture is a deliberate mouse start; native gestures must match a live press. */
export type VoiceCommand =
  | { op: "hello"; version: 1; nonce: string }
  | { op: "configure"; voiceHotkey: string }
  | { op: "begin"; gestureId: string | null; recordingId: string; binding: InputBinding }
  | { op: "stop"; recordingId: string }
  | { op: "cancel"; recordingId: string }
  | { op: "setup" }
  | { op: "shutdown" };

/** Voice bridge → main. */
export type VoiceEvent =
  | { op: "ready"; version: 1; nonce: string; bridgeVersion: string; modelReady: boolean; microphoneStatus: string; shortcutStatus: string }
  | { op: "pressed"; gestureId: string }
  | { op: "released"; gestureId: string }
  | { op: "recording"; recordingId: string; binding: InputBinding }
  | { op: "transcribing"; recordingId: string; binding: InputBinding }
  | { op: "transcript"; recordingId: string; binding: InputBinding; text: string }
  | { op: "cancelled"; recordingId: string }
  | { op: "error"; recordingId?: string; code: string; message: string };

const status = z.string().max(64).regex(/^[a-z0-9-]*$/, "not a status code");
const line = z.string().max(2000);

export const VoiceEventSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("ready"), version: z.literal(1), nonce: TokenSchema, bridgeVersion: z.string().min(1).max(64),
    modelReady: z.boolean(), microphoneStatus: status, shortcutStatus: status,
  }).strict(),
  z.object({ op: z.literal("pressed"), gestureId: TokenSchema }).strict(),
  z.object({ op: z.literal("released"), gestureId: TokenSchema }).strict(),
  z.object({ op: z.literal("recording"), recordingId: TokenSchema, binding: InputBindingSchema }).strict(),
  z.object({ op: z.literal("transcribing"), recordingId: TokenSchema, binding: InputBindingSchema }).strict(),
  z.object({
    op: z.literal("transcript"), recordingId: TokenSchema, binding: InputBindingSchema,
    text: z.string().refine((t) => new TextEncoder().encode(t).length <= MAX_TRANSCRIPT_BYTES, "transcript is too long"),
  }).strict(),
  z.object({ op: z.literal("cancelled"), recordingId: TokenSchema }).strict(),
  z.object({ op: z.literal("error"), recordingId: TokenSchema.optional(), code: status, message: line }).strict(),
]) satisfies z.ZodType<VoiceEvent>;

/** Main → focus helper. Handles live only for one helper lifetime and name only a captured running app. */
export type FocusCommand =
  | { op: "capture"; id: string }
  | { op: "restore"; id: string; handle: string }
  | { op: "frontmost"; id: string }
  | { op: "shutdown" };
/** Focus helper → main. */
export type FocusEvent =
  | { op: "captured"; id: string; handle: string }
  | { op: "restored"; id: string; ok: boolean }
  | { op: "frontmost"; id: string; app: AppSignal | null };

export const FocusEventSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("captured"), id: TokenSchema, handle: TokenSchema }).strict(),
  z.object({ op: z.literal("restored"), id: TokenSchema, ok: z.boolean() }).strict(),
  z.object({ op: z.literal("frontmost"), id: TokenSchema, app: AppSignalSchema.nullable() }).strict(),
]) satisfies z.ZodType<FocusEvent>;

export interface FocusBridge {
  /** An opaque handle for the app that is frontmost now. */
  capture(): Promise<string>;
  restore(handle: string): Promise<boolean>;
  frontmost(): Promise<AppSignal | null>;
  close(): Promise<void>;
}
