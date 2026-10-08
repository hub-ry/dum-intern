// Sign in with ChatGPT, in Electron main. Browser OAuth with PKCE, state and an OIDC nonce over a
// 127.0.0.1 loopback callback; first sign-in registers Dum through `dynamic_agent_client`; the ID
// token is checked against OpenAI's JWKS and the grant must include ChatGPT plan use. Main keeps
// the refresh token encrypted and hands the host short-lived access tokens; this is OAuth, never a
// model call. Source: developers.openai.com/siwc/token-sharing-open-source (sign-in,
// profiles-and-sessions, token-reference, errors-and-recovery).

import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import timers from "node:timers/promises";
import { z } from "zod";
import type { BackendSetup, BackendStatus, LoginMethod, LoginUi } from "./types.ts";
import type { Credentials } from "../desktop/credentials.ts";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = "https://api.openai.com/v1";
const REGISTER = "dynamic_agent_client";
const AGENT_NAME = "Dum";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const CALLBACK_PATH = "/auth/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
/** Refresh this long before the access token's expiry, so a request never starts on a dying token. */
const EARLY_REFRESH_MS = 2 * 60_000;
const UNUSABLE_REFRESH: Record<string, true> = {
  invalid_grant: true, invalid_refresh_token: true, token_expired: true,
  refresh_token_expired: true, refresh_token_invalidated: true, refresh_token_reused: true,
};

const DID_NOT_COMPLETE = "ChatGPT sign-in did not complete";
const CANNOT_USE = "This ChatGPT login cannot be used by Dum";
const SIGN_IN_AGAIN = "Sign in to ChatGPT again";

/**
 * Stored encrypted under "chatgpt-refresh". The issued client and verified account stay after
 * sign-out so the next sign-in reuses the registration; tokens are null when signed out or when
 * the grant lacked ChatGPT plan use.
 */
const RecordSchema = z.object({
  version: z.literal(1),
  clientId: z.string().min(1).max(512),
  subject: z.string().min(1).max(512),
  email: z.string().max(320).nullable(),
  idToken: z.string().max(16384).nullable(),
  refreshToken: z.string().max(16384).nullable(),
  scopes: z.array(z.string().max(128)).max(32),
  savedAt: z.string(),
}).strict();
type SignInRecord = z.infer<typeof RecordSchema>;

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});

/** Short-lived access tokens live in main's memory only. */
const cache = new WeakMap<Credentials, { value: string; expiresAt: number }>();
/** Refreshes for one store run one at a time: the refresh token rotates. */
const refreshing = new WeakMap<Credentials, Promise<{ value: string; expiresAt: number }>>();

export function chatgptSetup(o: { credentials: Credentials }): BackendSetup {
  const { credentials } = o;
  let attempt: AbortController | null = null;
  let message = "";
  return {
    id: "chatgpt",
    async status(): Promise<BackendStatus> {
      const base = { id: "chatgpt" as const, label: "ChatGPT", installed: true, methods: ["chatgpt"] as const, loginRunning: attempt !== null, loginNeedsCode: false };
      if (attempt) return { ...base, ready: null, message: "Finish signing in to ChatGPT in your browser" };
      const record = await readRecord(credentials);
      if (!record?.refreshToken) {
        const lacking = record !== null && !record.scopes.includes(PLAN_SCOPE);
        return { ...base, ready: null, message: message || (lacking ? `${CANNOT_USE}: allow ChatGPT plan use when you Continue with ChatGPT` : "Continue with ChatGPT") };
      }
      try {
        await accessToken(credentials, AbortSignal.timeout(15_000));
        message = "";
        return { ...base, ready: "chatgpt", message: "Signed in" };
      } catch (err) {
        return { ...base, ready: null, message: reason(err) };
      }
    },
    async login(method: LoginMethod, ui: LoginUi): Promise<void> {
      if (method !== "chatgpt") throw new Error(`ChatGPT doesn't sign in with ${method}`);
      attempt?.abort();
      const controller = new AbortController();
      attempt = controller;
      message = "";
      ui.changed();
      try {
        await signIn(credentials, ui, controller.signal);
      } catch (err) {
        message = reason(err);
        throw new Error(message);
      } finally {
        if (attempt === controller) attempt = null;
        ui.changed();
      }
    },
    cancelLogin(): void {
      attempt?.abort();
    },
    async signOut(method: LoginMethod): Promise<void> {
      if (method !== "chatgpt") throw new Error(`ChatGPT doesn't sign in with ${method}`);
      attempt?.abort();
      cache.delete(credentials);
      const record = await readRecord(credentials);
      if (!record) return;
      const confirmed = record.refreshToken ? await revoke(record.clientId, record.refreshToken) : true;
      await writeRecord(credentials, { ...record, idToken: null, refreshToken: null, savedAt: new Date().toISOString() });
      message = confirmed ? "" : "Signed out of ChatGPT on this Mac, but ChatGPT didn't confirm the session ended. You can disconnect Dum in ChatGPT settings.";
    },
  };
}

/**
 * A current access token for the host, refreshed near expiry with the stored refresh token. The
 * rotated refresh token is saved before the access token is handed out. Unusable refresh tokens
 * are cleared; network failures keep them.
 */
export async function accessToken(credentials: Credentials, signal: AbortSignal): Promise<{ value: string; expiresAt: number }> {
  signal.throwIfAborted();
  const cached = cache.get(credentials);
  if (cached && cached.expiresAt - EARLY_REFRESH_MS > Date.now()) return { value: cached.value, expiresAt: cached.expiresAt };
  let pending = refreshing.get(credentials);
  if (!pending) {
    // Shared by every caller, so one caller's abort can't cut a rotation off halfway.
    pending = refresh(credentials).finally(() => refreshing.delete(credentials));
    refreshing.set(credentials, pending);
  }
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([pending, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function refresh(credentials: Credentials): Promise<{ value: string; expiresAt: number }> {
  const record = await readRecord(credentials);
  if (!record?.refreshToken) throw new Error(SIGN_IN_AGAIN);
  let res: Response;
  try {
    res = await post(TOKEN, { grant_type: "refresh_token", client_id: record.clientId, refresh_token: record.refreshToken, resource: RESOURCE }, AbortSignal.timeout(30_000));
  } catch (err) {
    throw new Error(`Dum couldn't reach ChatGPT to renew the sign-in: ${reason(err)}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = oauthError(body);
    if (code && UNUSABLE_REFRESH[code] === true) {
      cache.delete(credentials);
      await writeRecord(credentials, { ...record, refreshToken: null, savedAt: new Date().toISOString() });
      throw new Error(`Your ChatGPT sign-in has ended. ${SIGN_IN_AGAIN}.`);
    }
    if (code === "invalid_client") throw new Error(`ChatGPT no longer accepts Dum's registration (invalid_client). ${SIGN_IN_AGAIN}.`);
    throw new Error(`ChatGPT couldn't renew the sign-in (${res.status}${code ? ` ${code}` : ""})`);
  }
  const tokens = TokenResponse.safeParse(body);
  if (!tokens.success) throw new Error("ChatGPT sent a token response Dum doesn't understand");
  const scopes = tokens.data.scope ? tokens.data.scope.split(" ").filter(Boolean) : record.scopes;
  if (!scopes.includes(PLAN_SCOPE)) {
    cache.delete(credentials);
    await writeRecord(credentials, { ...record, refreshToken: null, scopes, savedAt: new Date().toISOString() });
    throw new Error(`${CANNOT_USE}: ChatGPT plan use is no longer allowed`);
  }
  await writeRecord(credentials, { ...record, refreshToken: tokens.data.refresh_token ?? record.refreshToken, scopes, savedAt: new Date().toISOString() });
  const fresh = { value: tokens.data.access_token, expiresAt: Date.now() + tokens.data.expires_in * 1000 };
  cache.set(credentials, fresh);
  return fresh;
}

async function signIn(credentials: Credentials, ui: LoginUi, signal: AbortSignal): Promise<void> {
  const hostId = await hostIdFor(credentials);
  const record = await readRecord(credentials);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const listener = await listen(signal);
  try {
    const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`;
    const query = new URLSearchParams({ client_id: record?.clientId ?? REGISTER });
    if (!record) query.set("agent_name_hint", AGENT_NAME);
    query.set("ext_agent_host_id", hostId);
    if (record?.idToken) query.set("id_token_hint", record.idToken);
    if (record?.email) query.set("login_hint", record.email);
    if (record && !record.scopes.includes(PLAN_SCOPE)) query.set("prompt", "consent");
    query.set("response_type", "code");
    query.set("redirect_uri", redirectUri);
    query.set("scope", SCOPE);
    query.set("resource", RESOURCE);
    query.set("state", state);
    query.set("nonce", nonce);
    query.set("code_challenge_method", "S256");
    query.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    await ui.openUrl(`${AUTHORIZE}?${query}`);

    const callback = await listener.callback;
    if (callback.get("state") !== state) throw new Error(`${DID_NOT_COMPLETE}: the browser's answer didn't match this attempt`);
    const error = callback.get("error");
    if (error === "access_denied") throw new Error(`${DID_NOT_COMPLETE}: access was declined`);
    if (error) throw new Error(`${DID_NOT_COMPLETE}: ${error}`);
    const code = callback.get("code");
    if (!code) throw new Error(`${DID_NOT_COMPLETE}: no authorization code came back`);
    const issued = callback.get("client_id");
    let clientId: string;
    if (record) {
      if (issued && issued !== record.clientId) throw new Error(`${DID_NOT_COMPLETE}: ChatGPT answered for a different registration`);
      clientId = record.clientId;
    } else {
      if (!issued || issued === REGISTER) throw new Error(`${DID_NOT_COMPLETE}: ChatGPT didn't finish registering Dum`);
      clientId = issued;
    }

    let res: Response;
    try {
      res = await post(TOKEN, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }, signal);
    } catch (err) {
      signal.throwIfAborted();
      throw new Error(`${DID_NOT_COMPLETE}: ${reason(err)}`);
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${DID_NOT_COMPLETE}: ChatGPT refused the code (${oauthError(body) ?? res.status})`);
    const tokens = TokenResponse.safeParse(body);
    if (!tokens.success || !tokens.data.id_token) throw new Error(`${DID_NOT_COMPLETE}: ChatGPT's token response was incomplete`);

    const claims = await validIdToken(tokens.data.id_token, clientId, nonce, signal);
    if (record && claims.sub !== record.subject) throw new Error(`${DID_NOT_COMPLETE}: that is a different ChatGPT account from the one this Mac registered`);
    const scopes = (tokens.data.scope ?? "").split(" ").filter(Boolean);
    const now = new Date().toISOString();
    const identity = { version: 1 as const, clientId, subject: claims.sub, email: claims.email ?? null, scopes, savedAt: now };
    if (!scopes.includes(PLAN_SCOPE) || !scopes.includes("resource.invoke") || !tokens.data.refresh_token) {
      // Keep the registration so the next attempt asks for consent with the same client; no tokens.
      await writeRecord(credentials, { ...identity, idToken: null, refreshToken: null });
      throw new Error(`${CANNOT_USE}: ChatGPT plan use wasn't allowed. Continue with ChatGPT again and allow it.`);
    }
    await writeRecord(credentials, { ...identity, idToken: tokens.data.id_token, refreshToken: tokens.data.refresh_token });
    cache.set(credentials, { value: tokens.data.access_token, expiresAt: Date.now() + tokens.data.expires_in * 1000 });
    listener.answer(true);
  } finally {
    listener.close();
  }
}

/** Created once per Mac before its first sign-in and kept across sign-outs. */
async function hostIdFor(credentials: Credentials): Promise<string> {
  const saved = await credentials.get("chatgpt-host-id");
  if (saved) return saved;
  const id = `urn:uuid:${randomUUID()}`;
  await credentials.set("chatgpt-host-id", id);
  return id;
}

type Listener = { port: number; callback: Promise<URLSearchParams>; answer(ok: boolean): void; close(): void };

/** One GET to /auth/callback on 127.0.0.1, within the timeout, or the attempt fails. */
async function listen(signal: AbortSignal): Promise<Listener> {
  signal.throwIfAborted();
  const callback = Promise.withResolvers<URLSearchParams>();
  callback.promise.catch(() => undefined);
  let respond: ((ok: boolean) => void) | null = null;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || respond) {
      res.writeHead(404).end();
      return;
    }
    respond = (ok) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><title>Dum</title><p>${ok ? "You're signed in to ChatGPT. You can close this tab and go back to Dum." : `${DID_NOT_COMPLETE}. Go back to Dum to try again.`}</p>`);
    };
    callback.resolve(url.searchParams);
  });
  const bound = Promise.withResolvers<void>();
  server.once("error", bound.reject);
  server.listen(0, "127.0.0.1", () => bound.resolve());
  try {
    await bound.promise;
  } catch (err) {
    throw new Error(`${DID_NOT_COMPLETE}: Dum couldn't listen for the browser (${reason(err)})`);
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error(`${DID_NOT_COMPLETE}: Dum couldn't listen for the browser`);
  }
  const timer = setTimeout(() => callback.reject(new Error(`${DID_NOT_COMPLETE}: the browser didn't come back in time`)), CALLBACK_TIMEOUT_MS);
  const onAbort = () => callback.reject(new Error(`${DID_NOT_COMPLETE}: sign-in was cancelled`));
  signal.addEventListener("abort", onAbort, { once: true });
  let answered = false;
  return {
    port: address.port,
    callback: callback.promise,
    answer(ok) {
      answered = true;
      respond?.(ok);
    },
    close() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (!answered) respond?.(false);
      server.close();
      server.closeAllConnections();
    },
  };
}

const ClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1).max(512),
  exp: z.number(),
  nonce: z.string().optional(),
  email: z.string().max(320).optional(),
});

/** RS256 signature against the issuer's published JWKS, then issuer, audience, expiry and nonce. */
async function validIdToken(token: string, clientId: string, nonce: string, signal: AbortSignal): Promise<z.infer<typeof ClaimsSchema>> {
  const parts = token.split(".");
  const [head = "", payload = "", signature = ""] = parts;
  if (parts.length !== 3) throw new Error(`${CANNOT_USE}: its ID token is malformed`);
  let header: z.infer<typeof HeaderSchema>;
  let claims: z.infer<typeof ClaimsSchema>;
  try {
    header = HeaderSchema.parse(JSON.parse(Buffer.from(head, "base64url").toString("utf8")));
    claims = ClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    throw new Error(`${CANNOT_USE}: its ID token is malformed`);
  }
  if (header.alg !== "RS256") throw new Error(`${CANNOT_USE}: its ID token isn't signed the way OpenAI signs them`);
  const keys = await jwks(signal);
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) throw new Error(`${CANNOT_USE}: its ID token's signing key isn't one OpenAI publishes`);
  let signed: boolean;
  try {
    signed = verify("sha256", Buffer.from(`${head}.${payload}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, "base64url"));
  } catch {
    signed = false;
  }
  if (!signed) throw new Error(`${CANNOT_USE}: its ID token's signature is invalid`);
  if (claims.iss !== ISSUER) throw new Error(`${CANNOT_USE}: its ID token came from the wrong issuer`);
  if (!(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId)) throw new Error(`${CANNOT_USE}: its ID token was issued to another app`);
  if (claims.exp * 1000 <= Date.now()) throw new Error(`${CANNOT_USE}: its ID token has expired`);
  if (claims.nonce !== nonce) throw new Error(`${CANNOT_USE}: its ID token doesn't belong to this sign-in`);
  return claims;
}

const HeaderSchema = z.object({ alg: z.string(), kid: z.string().optional() });
const JwksSchema = z.object({ keys: z.array(z.looseObject({ kty: z.string(), kid: z.string().optional() })) });
const Discovery = z.object({ jwks_uri: z.url(), revocation_endpoint: z.url().optional() });

async function discovery(signal: AbortSignal): Promise<z.infer<typeof Discovery>> {
  const res = await fetch(DISCOVERY, { redirect: "error", signal });
  if (!res.ok) throw new Error(`OpenAI's sign-in configuration answered ${res.status}`);
  return Discovery.parse(await res.json());
}

async function jwks(signal: AbortSignal): Promise<z.infer<typeof JwksSchema>["keys"]> {
  try {
    const res = await fetch((await discovery(signal)).jwks_uri, { redirect: "error", signal });
    if (!res.ok) throw new Error(`OpenAI's signing keys answered ${res.status}`);
    return JwksSchema.parse(await res.json()).keys;
  } catch (err) {
    signal.throwIfAborted();
    throw new Error(`${DID_NOT_COMPLETE}: Dum couldn't check the sign-in with OpenAI (${reason(err)})`);
  }
}

/** Ends the renewable session; true when OpenAI confirmed it. Network failures and 5xx get one retry. */
async function revoke(clientId: string, refreshToken: string): Promise<boolean> {
  for (const wait of [0, 2000]) {
    if (wait) await timers.setTimeout(wait);
    try {
      const signal = AbortSignal.timeout(15_000);
      const endpoint = (await discovery(signal)).revocation_endpoint;
      if (!endpoint) return false;
      const res = await post(endpoint, { token: refreshToken, token_type_hint: "refresh_token", client_id: clientId }, signal);
      if (res.ok) return true;
      if (res.status < 500) return false;
    } catch {
      // retried below, then reported as unconfirmed
    }
  }
  return false;
}

function post(url: string, form: Record<string, string>, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
    redirect: "error",
    signal,
  });
}

async function readRecord(credentials: Credentials): Promise<SignInRecord | null> {
  const raw = await credentials.get("chatgpt-refresh");
  if (raw === null) return null;
  try {
    return RecordSchema.parse(JSON.parse(raw));
  } catch {
    await credentials.delete("chatgpt-refresh");
    return null;
  }
}

async function writeRecord(credentials: Credentials, record: SignInRecord): Promise<void> {
  await credentials.set("chatgpt-refresh", JSON.stringify(RecordSchema.parse(record)));
}

/** OAuth errors arrive as `{error: "code"}` or `{error: {code}}`. */
function oauthError(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const error = body.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return null;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
