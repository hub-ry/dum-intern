// Ryan's "go" for a Workday submit, in a form the worker can check and nobody else can make.
//
// When the agent asks to submit, the worker parks a pending submit: a random nonce and an HMAC
// fingerprint of the review page. Hub puts that on an approval card in Discord. Only the bot's
// handler for Ryan's button signs an approval, with an Ed25519 private key that lives on hub
// (~/.config/dum-workday/approval.key), outside the VM and outside any model's reach. The worker
// holds only the public key. It clicks Submit only for a token that verifies, hasn't expired,
// names its pending nonce, matches the page as it is right now, and was never used before.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readRequest, updateRequest, type DumRequest } from "../shared/requests.ts";
import type { WorkerApi } from "./api.ts";

export const DEFAULT_KEY_DIR = join(homedir(), ".config", "dum-workday");
/** How long a signed approval stays good: the bot hands it to the worker right away. */
export const APPROVAL_TTL_MS = 15 * 60_000;

export class ApprovalError extends Error {}

const Payload = z.object({
  v: z.literal(1),
  typ: z.literal("dum-workday-submit"),
  rid: z.string().max(64),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  fp: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.string().max(2000),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type ApprovalPayload = z.infer<typeof Payload>;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Writes a new key pair: approval.key (0600, hub only) and approval.pub (goes to the worker). */
export function generateApprovalKeys(dir = DEFAULT_KEY_DIR): { privatePath: string; publicPath: string } {
  const privatePath = join(dir, "approval.key");
  const publicPath = join(dir, "approval.pub");
  if (existsSync(privatePath)) throw new ApprovalError(`${privatePath} already exists; delete it first to make a new pair.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  return { privatePath, publicPath };
}

export function loadPrivateKey(path: string): KeyObject {
  return createPrivateKey(readFileSync(path));
}

export function loadPublicKey(path: string): KeyObject {
  return createPublicKey(readFileSync(path));
}

export function signApproval(key: KeyObject, payload: ApprovalPayload): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(sign(null, Buffer.from(body), key))}`;
}

/** The payload of a token signed by `key`'s private half and not yet expired. Throws otherwise. */
export function verifyApproval(token: string, key: KeyObject, now: number): ApprovalPayload {
  const m = /^([A-Za-z0-9_-]{1,8000})\.([A-Za-z0-9_-]{40,200})$/.exec(token.trim());
  if (!m) throw new ApprovalError("That isn't an approval.");
  if (!verify(null, Buffer.from(m[1]!), key, Buffer.from(m[2]!, "base64url"))) throw new ApprovalError("The approval's signature doesn't check out; only Ryan's button in Discord makes valid ones.");
  let payload: ApprovalPayload;
  try {
    payload = Payload.parse(JSON.parse(Buffer.from(m[1]!, "base64url").toString("utf8")));
  } catch {
    throw new ApprovalError("The approval is signed but malformed.");
  }
  if (payload.exp <= now) throw new ApprovalError("The approval expired; ask Ryan again.");
  return payload;
}

/**
 * The bot's side, called only from Ryan's button press: signs the approval for a pending
 * workday-submit request and records it. Returns the decided request.
 */
export function approveSubmitRequest(requestsDir: string, id: string, key: KeyObject, now = new Date()): DumRequest {
  const req = readRequest(requestsDir, id);
  if (!req || req.kind !== "workday-submit" || !req.workday) throw new ApprovalError(`No Workday submit request ${id}.`);
  if (req.status !== "pending") return req;
  const iat = now.getTime();
  const approval = signApproval(key, { v: 1, typ: "dum-workday-submit", rid: req.id, nonce: req.workday.nonce, fp: req.workday.fingerprint, url: req.workday.url, iat, exp: iat + APPROVAL_TTL_MS });
  return updateRequest(requestsDir, id, { status: "approved", decidedAt: now.toISOString(), approval, outcome: "Approved; handing it to the worker." });
}

/**
 * Hands a signed approval to the worker, which checks it and clicks Submit. The request keeps
 * what happened as its outcome. Safe to repeat: the worker refuses a used approval.
 */
export async function handApprovalToWorker(requestsDir: string, id: string, worker: WorkerApi | null): Promise<DumRequest> {
  const req = readRequest(requestsDir, id);
  if (!req || req.kind !== "workday-submit" || req.status !== "approved" || !req.approval) throw new ApprovalError(`Request ${id} isn't an approved Workday submit.`);
  if (!worker) return updateRequest(requestsDir, id, { outcome: "Approved, but hub doesn't know where the worker is (~/.config/dum-workday/worker-url); run dum workday submit later." });
  const r = await worker.submit(req.approval).catch((err: Error) => ({ text: err.message, isError: true }));
  return updateRequest(requestsDir, id, { outcome: r.isError ? `Not submitted: ${r.text.split("\n")[0]!.slice(0, 300)}` : "Submitted." });
}

/** The bot's whole answer to Ryan's button on a submit card. Nothing else signs approvals. */
export async function decideSubmit(requestsDir: string, id: string, approve: boolean, deps: { keyPath: string; worker: WorkerApi | null; now?: Date }): Promise<DumRequest | null> {
  const req = readRequest(requestsDir, id);
  if (!req || req.kind !== "workday-submit") return null;
  if (req.status !== "pending") return req;
  const now = deps.now ?? new Date();
  if (!approve) return updateRequest(requestsDir, id, { status: "declined", decidedAt: now.toISOString() });
  let key: KeyObject;
  try {
    key = loadPrivateKey(deps.keyPath);
  } catch {
    return updateRequest(requestsDir, id, { status: "failed", decidedAt: now.toISOString(), outcome: "there's no approval key on hub yet (dum workday keygen)" });
  }
  approveSubmitRequest(requestsDir, id, key, now);
  return handApprovalToWorker(requestsDir, id, deps.worker);
}

/** Nonces of approvals the worker has used, so a token works once. Lives in the worker's state dir. */
export class UsedNonces {
  constructor(private readonly path: string) {}

  #read(): string[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  has(nonce: string): boolean {
    return this.#read().includes(nonce);
  }

  /** Records the nonce before the click, so a crash mid-submit can't let the token work twice. */
  use(nonce: string): void {
    const list = this.#read();
    if (list.includes(nonce)) throw new ApprovalError("That approval was already used.");
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify([...list, nonce].slice(-5000)), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
