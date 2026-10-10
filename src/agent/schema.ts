// Schemas for the agent contract, shared by main, host and protocol.

import { z } from "zod";
import type { AgentChoice, BackendId, BackendStatus, LoginMethod, ModelOption, Picture, Role, Selector } from "./types.ts";

export const BACKEND_IDS = ["claude", "chatgpt", "copilot"] as const satisfies readonly BackendId[];
export const LOGIN_METHODS = ["anthropic-key", "chatgpt", "github"] as const satisfies readonly LoginMethod[];

export const ROLES = ["intern", "helper", "look"] as const satisfies readonly Role[];

/**
 * Claude's selectors before anything else is picked: the intern, the helper and the look. Ids the live
 * catalog lists; today they are aliases (opus → claude-opus-5-5, fable → claude-fable-5-1,
 * haiku → claude-haiku-5-5), and pictures are judged on what they resolve to. Pure data, so the
 * renderer can preselect them.
 */
export const CLAUDE_DEFAULTS = {
  intern: { backend: "claude", model: "opus", effort: "high" },
  helper: { backend: "claude", model: "fable", effort: "high" },
  look: { backend: "claude", model: "haiku", effort: "low" },
} as const satisfies Record<Role, Selector>;

/** The sign-in each backend takes. Claude takes only the user's own Anthropic API key. */
export const BACKEND_LOGINS: Readonly<Record<BackendId, readonly LoginMethod[]>> = {
  claude: ["anthropic-key"],
  chatgpt: ["chatgpt"],
  copilot: ["github"],
};

export const BackendIdSchema = z.enum(BACKEND_IDS);
export const LoginMethodSchema = z.enum(LOGIN_METHODS);

const modelId = z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/, "not a model id");
const effort = z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/, "not an effort level");

export const SelectorSchema = z.object({
  backend: BackendIdSchema,
  model: modelId,
  effort: effort.nullable(),
}).strict() satisfies z.ZodType<Selector>;

/** A choice whose login its backend takes, with every role's selector on that backend. */
export const AgentChoiceSchema = z.object({
  backend: BackendIdSchema,
  login: LoginMethodSchema,
  intern: SelectorSchema,
  helper: SelectorSchema,
  look: SelectorSchema,
}).strict().superRefine((c, ctx) => {
  if (!BACKEND_LOGINS[c.backend].includes(c.login)) {
    ctx.addIssue({ code: "custom", path: ["login"], message: `${c.backend} doesn't sign in with ${c.login}` });
  }
  for (const role of ROLES) {
    if (c[role].backend !== c.backend) ctx.addIssue({ code: "custom", path: [role, "backend"], message: `the ${role} model must be on ${c.backend}` });
  }
}) satisfies z.ZodType<AgentChoice>;

export const ModelOptionSchema = z.object({
  id: modelId,
  resolved: modelId,
  label: z.string().min(1).max(200),
  efforts: z.array(effort).max(16),
  images: z.boolean(),
  actions: z.boolean(),
  verified: z.boolean(),
}).strict() satisfies z.ZodType<ModelOption>;

export const BackendStatusSchema = z.object({
  id: BackendIdSchema,
  label: z.string().min(1).max(200),
  installed: z.boolean(),
  methods: z.array(LoginMethodSchema).max(LOGIN_METHODS.length),
  ready: LoginMethodSchema.nullable(),
  loginRunning: z.boolean(),
  message: z.string().max(2000),
}).strict() satisfies z.ZodType<BackendStatus>;

/** Base64 PNG; 6 MiB of base64 keeps one frame under the 5 MB image limit. */
export const PictureSchema = z.object({
  mimeType: z.literal("image/png"),
  data: z.string().min(1).max(6 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/, "not base64"),
}).strict() satisfies z.ZodType<Picture>;
