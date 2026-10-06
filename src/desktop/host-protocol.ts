import { z } from "zod";
import type { State } from "../store.ts";
import type { View } from "../web/view.ts";

const tag = z.string().min(1).max(64);
const text = z.string().max(48 * 1024);
const image = z.object({ data: z.string().max(6 * 1024 * 1024), mimeType: z.literal("image/png"), label: z.string().max(300) }).strict();
const base = { epoch: tag, id: tag };
export const HostRequestSchema = z.discriminatedUnion("op", [
  z.object({ ...base, op: z.literal("open"), root: z.string().min(1).max(4096), personal: z.object({ path: z.string().max(8192), text: z.string().max(64 * 1024), warning: z.string().max(8192) }).strict(), mode: z.enum(["understand", "anti-vibe"]).optional(), wizardAdvice: z.boolean().default(false) }).strict(),
  z.object({ ...base, op: z.literal("send"), text, inputToken: tag, image: image.optional() }).strict(),
  z.object({ ...base, op: z.literal("command"), name: z.enum(["inspect", "changes", "practice", "submit", "run", "remember"]), argument: z.string().max(4096) }).strict(),
  z.object({ ...base, op: z.literal("panel"), panel: z.enum(["tree", "memory", "history", "context", "evidence", "boundary"]) }).strict(),
  z.object({ ...base, op: z.literal("interrupt") }).strict(),
  z.object({ ...base, op: z.literal("wizard-advice"), enabled: z.boolean() }).strict(),
  z.object({ ...base, op: z.literal("quip"), text: z.string().max(1000) }).strict(),
  z.object({ ...base, op: z.literal("close") }).strict(),
]);
export type HostRequest = z.infer<typeof HostRequestSchema>;
export type HostEvent =
  | { type: "ready"; epoch: string }
  | { type: "state"; epoch: string; state: State | null; inputToken: string; canAttach: boolean; tree: View | null; wizardStatus: string }
  | { type: "reply"; epoch: string; id: string; ok: boolean; error?: string };
