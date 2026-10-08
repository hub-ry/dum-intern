// What the user explicitly shared, and how a request is bound to the zone and prompt it came from.
// Selection grants reading, never writes or competency (docs/architecture.md rule 1). Data and schemas only.

import { z } from "zod";
import type { ZoneId } from "./zone-types.ts";

/** A zone-scoped input: the zone (null only for the first-run goal draft), epoch, live prompt token and request. */
export type InputBinding = { zoneId: ZoneId | null; zoneEpoch: string; inputToken: string; requestId: string };
/** Files and model requests need a live zone. */
export type RequestBinding = InputBinding & { zoneId: ZoneId };
/** `<grant-id>/<relative>`; the grant is a request share or a zone follow. */
export type ResourcePath = string;
export type ShareGrant = { id: string; kind: "file" | "folder"; scope: "request" | "zone"; label: string; files: ResourcePath[] };
/** Complete bytes of one shared file as read by the host, with their digest. */
export type SourceSnapshot = { path: ResourcePath; sourcePath: string; text: string; sha: string; complete: true };
export interface Resources {
  list(): ResourcePath[];
  file(path: ResourcePath): Promise<SourceSnapshot>;
  read(path: ResourcePath, from: number, to: number): Promise<{ path: ResourcePath; text: string; sha: string; from: number }>;
  /** For change(): revalidated absolute path and the current bytes' SHA, or null when absent. New files only under a folder grant. */
  target(path: ResourcePath): Promise<{ absolute: string; currentSha: string | null }>;
}

export const SHARE_LIMITS = {
  files: 2000,
  depth: 16,
  fileBytes: 262144,
  readLines: 120,
  reviewFiles: 4,
  reviewBytes: 98304,
  pendingMs: 300000,
} as const;

/** App-issued IDs: lowercase `crypto.randomUUID()`. */
export const IdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "not an app-issued id");
/** Opaque app-issued correlation values: epochs, prompt tokens, request and recording IDs. */
export const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "not an app-issued token");

const CONTROL = /[\u0000-\u001f\u007f]/;
export const ResourcePathSchema = z.string().max(4096).refine((p) => {
  const [grant, ...rest] = p.split("/");
  return IdSchema.safeParse(grant).success && rest.length > 0 && rest.length <= SHARE_LIMITS.depth
    && rest.every((s) => s !== "" && s !== "." && s !== ".." && !s.includes("\\") && !CONTROL.test(s));
}, "not a shared resource name");

export const InputBindingSchema = z.object({
  zoneId: IdSchema.nullable(),
  zoneEpoch: TokenSchema,
  inputToken: TokenSchema,
  requestId: TokenSchema,
}).strict() satisfies z.ZodType<InputBinding>;

export const RequestBindingSchema = z.object({
  zoneId: IdSchema,
  zoneEpoch: TokenSchema,
  inputToken: TokenSchema,
  requestId: TokenSchema,
}).strict() satisfies z.ZodType<RequestBinding>;

export const ShareGrantSchema = z.object({
  id: IdSchema,
  kind: z.enum(["file", "folder"]),
  scope: z.enum(["request", "zone"]),
  label: z.string().min(1).max(300),
  files: z.array(ResourcePathSchema).max(SHARE_LIMITS.files),
}).strict() satisfies z.ZodType<ShareGrant>;
