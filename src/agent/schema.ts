// Schemas for the agent contract, shared by main, host and protocol.

import { z } from "zod";
import type { AgentChoice, BackendId, BackendStatus, Flavor, LoginMethod, ModelOption, Picture, Selector } from "./types.ts";

export const BACKEND_IDS = ["claude", "chatgpt", "local", "copilot"] as const satisfies readonly BackendId[];
export const LOGIN_METHODS = ["anthropic-key", "claude-subscription", "chatgpt", "github", "none"] as const satisfies readonly LoginMethod[];

/** The sign-in methods each backend has in a local build. Public builds never offer "claude-subscription". */
export const BACKEND_LOGINS: Readonly<Record<BackendId, readonly LoginMethod[]>> = {
  claude: ["anthropic-key", "claude-subscription"],
  chatgpt: ["chatgpt"],
  local: ["none"],
  copilot: ["github"],
};

/** The sign-in methods `backend` offers in `flavor`. */
export function offeredLogins(flavor: Flavor, backend: BackendId): readonly LoginMethod[] {
  const all = BACKEND_LOGINS[backend];
  return flavor === "public" ? all.filter((m) => m !== "claude-subscription") : all;
}

export const BackendIdSchema = z.enum(BACKEND_IDS);
export const LoginMethodSchema = z.enum(LOGIN_METHODS);
export const FlavorSchema = z.enum(["public", "local"]) satisfies z.ZodType<Flavor>;

const modelId = z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/, "not a model id");
const effort = z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/, "not an effort level");

export const SelectorSchema = z.object({
  backend: BackendIdSchema,
  model: modelId,
  effort: effort.nullable(),
}).strict() satisfies z.ZodType<Selector>;

/** A choice whose login is offered for its backend in `flavor`, with both selectors on that backend. */
export function agentChoiceSchema(flavor: Flavor): z.ZodType<AgentChoice> {
  return z.object({
    backend: BackendIdSchema,
    login: LoginMethodSchema,
    intern: SelectorSchema,
    helper: SelectorSchema,
  }).strict().superRefine((c, ctx) => {
    if (!offeredLogins(flavor, c.backend).includes(c.login)) {
      ctx.addIssue({ code: "custom", path: ["login"], message: `${c.backend} doesn't sign in with ${c.login} in this build` });
    }
    for (const role of ["intern", "helper"] as const) {
      if (c[role].backend !== c.backend) ctx.addIssue({ code: "custom", path: [role, "backend"], message: `the ${role} model must be on ${c.backend}` });
    }
  });
}

export const ModelOptionSchema = z.object({
  id: modelId,
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
  loginNeedsCode: z.boolean(),
  message: z.string().max(2000),
}).strict() satisfies z.ZodType<BackendStatus>;

export const BuildInfoSchema = z.object({ flavor: FlavorSchema }).strict() satisfies z.ZodType<{ flavor: Flavor }>;

/** Base64 PNG; 6 MiB of base64 keeps one frame under the 5 MB image limit. */
export const PictureSchema = z.object({
  mimeType: z.literal("image/png"),
  data: z.string().min(1).max(6 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/, "not base64"),
}).strict() satisfies z.ZodType<Picture>;
