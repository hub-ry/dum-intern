import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessToken, chatgptSetup } from "../src/agent/siwc.ts";
import type { LoginUi } from "../src/agent/types.ts";
import { Credentials, type Cipher } from "../src/desktop/credentials.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-siwc-home-"));
process.env.DUM_CONTEXT = "off";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const FULL_SCOPE = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

/** Reversible and visibly not plaintext; the credential store's own test covers real encryption. */
const cipher: Cipher = {
  encrypt: async (text) => Buffer.from(Buffer.from(text, "utf8").map((b) => b ^ 0x5a)),
  decrypt: async (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString("utf8"),
};

function store(): { credentials: Credentials; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), "dum-siwc-")), "credentials.json");
  return { credentials: new Credentials(file, cipher), file };
}

type Pending = { clientId: string; redirectUri: string; challenge: string; nonce: string };

/**
 * OpenAI's auth server as the SIWC docs describe it: discovery, JWKS, authorization-code and
 * refresh grants with rotating refresh tokens, and revocation. Knobs make it misbehave.
 */
class FakeAuth {
  readonly key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly kid = "kid-1";
  signWith: KeyObject = this.key.privateKey;
  issuedClient = "oaiapp_123";
  subject = "user-sub-1";
  scope = FULL_SCOPE;
  idNonce: string | null = null;
  idExp = Math.floor(Date.now() / 1000) + 3600;
  refreshError: { status: number; body: object } | null = null;
  tokenCalls: URLSearchParams[] = [];
  revoked: URLSearchParams[] = [];
  refreshToken = "";
  accessTokens: string[] = [];
  private codes = new Map<string, Pending>();

  install(): void {
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === "127.0.0.1") return realFetch(input, init);
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body : "");
      return this.route(url, form);
    };
  }

  private route(url: URL, form: URLSearchParams): Response {
    const at = `${url.origin}${url.pathname}`;
    if (at === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/oauth/revoke` });
    if (at === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [{ ...this.key.publicKey.export({ format: "jwk" }), kid: this.kid, alg: "RS256", use: "sig" }] });
    if (at === `${ISSUER}/oauth/revoke`) {
      this.revoked.push(form);
      return new Response(null, { status: 200 });
    }
    if (at !== `${ISSUER}/api/accounts/oauth/token`) return new Response("not found", { status: 404 });
    this.tokenCalls.push(form);
    assert.equal(form.get("resource"), RESOURCE);
    if (form.get("grant_type") === "authorization_code") {
      const pending = this.codes.get(form.get("code") ?? "");
      if (!pending) return Response.json({ error: "invalid_grant" }, { status: 400 });
      assert.equal(form.get("client_id"), pending.clientId === "dynamic_agent_client" ? this.issuedClient : pending.clientId);
      assert.equal(form.get("redirect_uri"), pending.redirectUri);
      assert.equal(createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url"), pending.challenge);
      return Response.json(this.tokens(this.issuedClient, pending.nonce));
    }
    if (form.get("grant_type") === "refresh_token") {
      if (this.refreshError) return Response.json(this.refreshError.body, { status: this.refreshError.status });
      if (form.get("refresh_token") !== this.refreshToken) return Response.json({ error: "refresh_token_reused" }, { status: 400 });
      assert.equal(form.get("client_id"), this.issuedClient);
      assert.equal(form.has("scope"), false);
      const { id_token: _, ...rest } = this.tokens(this.issuedClient, null);
      return Response.json(rest);
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  private tokens(clientId: string, nonce: string | null) {
    this.refreshToken = `rt-${randomBytes(8).toString("hex")}`;
    const access = `at-${randomBytes(8).toString("hex")}`;
    this.accessTokens.push(access);
    return {
      access_token: access,
      refresh_token: this.refreshToken,
      id_token: this.idToken({ iss: ISSUER, aud: clientId, sub: this.subject, exp: this.idExp, iat: Math.floor(Date.now() / 1000), nonce: this.idNonce ?? nonce, email: "learner@example.com" }),
      token_type: "Bearer",
      expires_in: 3600,
      scope: this.scope,
    };
  }

  idToken(claims: object): string {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const signing = `${part({ alg: "RS256", kid: this.kid, typ: "JWT" })}.${part(claims)}`;
    return `${signing}.${createSign("RSA-SHA256").update(signing).sign(this.signWith).toString("base64url")}`;
  }

  /** What the browser does after the user approves: back to the loopback callback. */
  approve(authorizeUrl: string, o: { state?: string; clientId?: string | null } = {}): { query: URLSearchParams; page: Promise<string> } {
    const url = new URL(authorizeUrl);
    const query = url.searchParams;
    const code = `code-${randomBytes(6).toString("hex")}`;
    this.codes.set(code, { clientId: query.get("client_id")!, redirectUri: query.get("redirect_uri")!, challenge: query.get("code_challenge")!, nonce: query.get("nonce")! });
    const back = new URL(query.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", o.state ?? query.get("state")!);
    back.searchParams.set("scope", this.scope);
    const issued = o.clientId === undefined ? (query.get("client_id") === "dynamic_agent_client" ? this.issuedClient : null) : o.clientId;
    if (issued) back.searchParams.set("client_id", issued);
    return { query, page: realFetch(back).then((r) => r.text()) };
  }
}

type Browser = LoginUi & { urls: URLSearchParams[]; pages: Promise<string>[] };

function browser(auth: FakeAuth, o: { state?: string; clientId?: string | null } = {}): Browser {
  const urls: URLSearchParams[] = [];
  const pages: Promise<string>[] = [];
  return {
    urls,
    pages,
    async openUrl(url) {
      assert.ok(url.startsWith(`${ISSUER}/api/accounts/authorize?`));
      const { query, page } = auth.approve(url, o);
      urls.push(query);
      pages.push(page);
    },
    changed() {},
  };
}

async function signedIn(): Promise<{ auth: FakeAuth; credentials: Credentials; file: string; ui: Browser }> {
  const auth = new FakeAuth();
  auth.install();
  const { credentials, file } = store();
  const ui = browser(auth);
  await chatgptSetup({ credentials }).login("chatgpt", ui);
  return { auth, credentials, file, ui };
}

test("first sign-in registers through dynamic_agent_client with PKCE, state, nonce and a 127.0.0.1 callback", async () => {
  const { auth, credentials, file, ui } = await signedIn();
  const q = ui.urls[0]!;
  assert.equal(q.get("client_id"), "dynamic_agent_client");
  assert.equal(q.get("agent_name_hint"), "Dum");
  assert.match(q.get("ext_agent_host_id") ?? "", /^urn:uuid:[0-9a-f-]{36}$/);
  assert.match(q.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(q.get("resource"), RESOURCE);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.ok((q.get("state") ?? "").length >= 32 && (q.get("nonce") ?? "").length >= 32);
  assert.equal(q.has("id_token_hint"), false);
  assert.match(await ui.pages[0]!, /signed in to ChatGPT/);

  const status = await chatgptSetup({ credentials }).status();
  assert.equal(status.ready, "chatgpt");
  assert.deepEqual(status.methods, ["chatgpt"]);
  assert.equal(await credentials.get("chatgpt-host-id"), q.get("ext_agent_host_id"));
  const record = JSON.parse((await credentials.get("chatgpt-refresh"))!);
  assert.equal(record.clientId, "oaiapp_123");
  assert.equal(record.refreshToken, auth.refreshToken);
  assert.doesNotMatch(readFileSync(file, "latin1"), new RegExp(auth.refreshToken));
  assert.equal(JSON.stringify(process.env).includes(auth.refreshToken), false);
  assert.equal(JSON.stringify(process.env).includes(auth.accessTokens[0]!), false);
});

test("a returning sign-in reuses the issued client and host ID with an ID-token hint, and no name hint", async () => {
  const { auth, credentials, ui } = await signedIn();
  const setup = chatgptSetup({ credentials });
  await setup.login("chatgpt", ui);
  const [first, second] = ui.urls;
  assert.equal(second!.get("client_id"), "oaiapp_123");
  assert.equal(second!.has("agent_name_hint"), false);
  assert.equal(second!.get("ext_agent_host_id"), first!.get("ext_agent_host_id"));
  assert.ok(second!.get("id_token_hint"));
  assert.equal(second!.get("login_hint"), "learner@example.com");
  assert.notEqual(second!.get("state"), first!.get("state"));
  assert.notEqual(second!.get("code_challenge"), first!.get("code_challenge"));
  assert.equal(auth.tokenCalls.at(-1)!.get("client_id"), "oaiapp_123");
});

async function refused(configure: (auth: FakeAuth) => void, ui: (auth: FakeAuth) => LoginUi, pattern: RegExp): Promise<{ auth: FakeAuth; credentials: Credentials }> {
  const auth = new FakeAuth();
  configure(auth);
  auth.install();
  const { credentials } = store();
  const setup = chatgptSetup({ credentials });
  await assert.rejects(setup.login("chatgpt", ui(auth)), pattern);
  assert.notEqual((await setup.status()).ready, "chatgpt");
  return { auth, credentials };
}

async function noTokens(credentials: Credentials): Promise<void> {
  const raw = await credentials.get("chatgpt-refresh");
  if (raw === null) return;
  const record = JSON.parse(raw);
  assert.equal(record.refreshToken, null);
  assert.equal(record.idToken, null);
}

test("state mismatch: the code is never exchanged and nothing is stored", async () => {
  const { auth, credentials } = await refused(() => {}, (a) => browser(a, { state: "forged" }), /did not complete: the browser's answer didn't match/);
  assert.equal(auth.tokenCalls.length, 0);
  assert.equal(await credentials.has("chatgpt-refresh"), false);
});

test("nonce mismatch: the ID token is refused and no token is stored", async () => {
  const { credentials } = await refused((a) => (a.idNonce = "other-nonce"), (a) => browser(a), /cannot be used by Dum: its ID token doesn't belong to this sign-in/);
  assert.equal(await credentials.has("chatgpt-refresh"), false);
});

test("expired ID token is refused", async () => {
  const { credentials } = await refused((a) => (a.idExp = Math.floor(Date.now() / 1000) - 5), (a) => browser(a), /ID token has expired/);
  assert.equal(await credentials.has("chatgpt-refresh"), false);
});

test("an ID token signed by an unpublished key is refused", async () => {
  const { credentials } = await refused((a) => (a.signWith = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey), (a) => browser(a), /signature is invalid/);
  assert.equal(await credentials.has("chatgpt-refresh"), false);
});

test("a new-registration callback without an issued client ID is incomplete", async () => {
  const { auth, credentials } = await refused(() => {}, (a) => browser(a, { clientId: null }), /didn't finish registering Dum/);
  assert.equal(auth.tokenCalls.length, 0);
  assert.equal(await credentials.has("chatgpt-refresh"), false);
});

test("wrong scope: without ChatGPT plan use no token is kept, and the next attempt asks for consent with the same client", async () => {
  const { auth, credentials } = await refused((a) => (a.scope = "email offline_access openid profile resource.invoke"), (a) => browser(a), /cannot be used by Dum: ChatGPT plan use wasn't allowed/);
  await noTokens(credentials);
  assert.match((await chatgptSetup({ credentials }).status()).message, /allow ChatGPT plan use/);
  auth.scope = FULL_SCOPE;
  const ui = browser(auth);
  await chatgptSetup({ credentials }).login("chatgpt", ui);
  assert.equal(ui.urls[0]!.get("client_id"), "oaiapp_123");
  assert.equal(ui.urls[0]!.get("prompt"), "consent");
  assert.equal((await chatgptSetup({ credentials }).status()).ready, "chatgpt");
});

test("a returning sign-in that comes back as another account keeps the old credentials untouched", async () => {
  const { auth, credentials, ui } = await signedIn();
  const before = await credentials.get("chatgpt-refresh");
  auth.subject = "someone-else";
  await assert.rejects(chatgptSetup({ credentials }).login("chatgpt", ui), /different ChatGPT account/);
  assert.equal(await credentials.get("chatgpt-refresh"), before);
});

test("callback timeout closes the listener and stores nothing", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { credentials } = store();
  new FakeAuth().install();
  let callback = "";
  const ui: LoginUi = {
    async openUrl(url) {
      callback = new URL(url).searchParams.get("redirect_uri")!;
      mock.timers.tick(5 * 60_000);
    },
    changed() {},
  };
  await assert.rejects(chatgptSetup({ credentials }).login("chatgpt", ui), /did not complete: the browser didn't come back in time/);
  await assert.rejects(realFetch(callback), "the loopback listener is closed");
  assert.equal(await credentials.has("chatgpt-refresh"), false);
});

test("cancelLogin ends the attempt", async () => {
  const { credentials } = store();
  new FakeAuth().install();
  const setup = chatgptSetup({ credentials });
  const ui: LoginUi = { openUrl: async () => setup.cancelLogin(), changed() {} };
  await assert.rejects(setup.login("chatgpt", ui), /sign-in was cancelled/);
  assert.equal((await setup.status()).loginRunning, false);
});

test("other sign-in methods are refused", async () => {
  const { credentials } = store();
  await assert.rejects(chatgptSetup({ credentials }).login("anthropic-key", { openUrl: async () => {}, changed() {} }), /doesn't sign in with anthropic-key/);
});

test("refresh: one rotation for concurrent callers, the replacement saved before use", async () => {
  const { auth, file } = await signedIn();
  const fresh = new Credentials(file, cipher);
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([accessToken(fresh, signal), accessToken(fresh, signal)]);
  assert.equal(a.value, b.value);
  assert.equal(a.value, auth.accessTokens.at(-1));
  assert.equal(auth.tokenCalls.filter((f) => f.get("grant_type") === "refresh_token").length, 1);
  assert.equal(JSON.parse((await fresh.get("chatgpt-refresh"))!).refreshToken, auth.refreshToken);
  assert.ok(a.expiresAt > Date.now() + 3_000_000);
  assert.equal((await accessToken(fresh, signal)).value, a.value, "cached until near expiry");
});

test("refresh failure: an unusable refresh token is cleared, the registration and host ID kept", async () => {
  const { auth, credentials, file } = await signedIn();
  const hostId = await credentials.get("chatgpt-host-id");
  auth.refreshError = { status: 400, body: { error: "invalid_grant" } };
  const fresh = new Credentials(file, cipher);
  await assert.rejects(accessToken(fresh, new AbortController().signal), /sign-in has ended. Sign in to ChatGPT again/);
  const record = JSON.parse((await fresh.get("chatgpt-refresh"))!);
  assert.equal(record.refreshToken, null);
  assert.equal(record.clientId, "oaiapp_123");
  assert.equal(await fresh.get("chatgpt-host-id"), hostId);
  assert.equal((await chatgptSetup({ credentials: fresh }).status()).ready, null);
});

test("a temporary refresh failure keeps the refresh token", async () => {
  const { auth, file } = await signedIn();
  const kept = auth.refreshToken;
  auth.refreshError = { status: 503, body: { detail: "unavailable" } };
  const fresh = new Credentials(file, cipher);
  await assert.rejects(accessToken(fresh, new AbortController().signal), /couldn't renew the sign-in \(503\)/);
  assert.equal(JSON.parse((await fresh.get("chatgpt-refresh"))!).refreshToken, kept);
});

test("sign-out revokes the refresh token, clears tokens and keeps the client mapping and host ID", async () => {
  const { auth, credentials } = await signedIn();
  const token = auth.refreshToken;
  const hostId = await credentials.get("chatgpt-host-id");
  const setup = chatgptSetup({ credentials });
  await setup.signOut("chatgpt");
  assert.equal(auth.revoked.length, 1);
  assert.equal(auth.revoked[0]!.get("token"), token);
  assert.equal(auth.revoked[0]!.get("token_type_hint"), "refresh_token");
  assert.equal(auth.revoked[0]!.get("client_id"), "oaiapp_123");
  await noTokens(credentials);
  assert.equal(JSON.parse((await credentials.get("chatgpt-refresh"))!).clientId, "oaiapp_123");
  assert.equal(await credentials.get("chatgpt-host-id"), hostId);
  assert.equal((await setup.status()).ready, null);
  await assert.rejects(accessToken(credentials, new AbortController().signal), /Sign in to ChatGPT again/);
});
