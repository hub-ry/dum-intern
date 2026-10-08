import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Credentials, safeStorageCipher, type Cipher } from "../src/desktop/credentials.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-credentials-home-"));
process.env.DUM_CONTEXT = "off";

/** Real AES-GCM under a per-test key, standing in for the keychain-backed safeStorage. */
function fakeCipher(): Cipher {
  const key = randomBytes(32);
  return {
    async encrypt(text) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    async decrypt(data) {
      const d = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      d.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString("utf8");
    },
  };
}

function place(): { dir: string; file: string } {
  const dir = join(mkdtempSync(join(tmpdir(), "dum-credentials-")), "private");
  return { dir, file: join(dir, "credentials.json") };
}

test("values round-trip per kind and survive a new store instance", async () => {
  const { file } = place();
  const cipher = fakeCipher();
  const store = new Credentials(file, cipher);
  assert.equal(await store.has("anthropic-key"), false);
  assert.equal(await store.get("anthropic-key"), null);
  await store.set("anthropic-key", "sk-ant-api03-secret");
  await store.set("chatgpt-refresh", '{"refreshToken":"rt-secret"}');
  await store.set("chatgpt-host-id", "urn:uuid:3f1c8a8e-6c43-4e0e-9a59-0c6f35d2f0a1");
  const again = new Credentials(file, cipher);
  assert.equal(await again.has("anthropic-key"), true);
  assert.equal(await again.get("anthropic-key"), "sk-ant-api03-secret");
  assert.equal(await again.get("chatgpt-refresh"), '{"refreshToken":"rt-secret"}');
  assert.equal(await again.get("chatgpt-host-id"), "urn:uuid:3f1c8a8e-6c43-4e0e-9a59-0c6f35d2f0a1");
});

test("the file is owner-only and holds no plaintext secret", async () => {
  const { dir, file } = place();
  const store = new Credentials(file, fakeCipher());
  await store.set("anthropic-key", "sk-ant-api03-plain-canary");
  await store.set("chatgpt-refresh", "rt-plain-canary");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const raw = readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /plain-canary/);
  assert.doesNotMatch(Buffer.from(raw).toString("latin1"), /canary/);
  assert.deepEqual(readdirSync(dir), ["credentials.json"], "no temp file left behind");
});

test("delete removes one kind and keeps the others", async () => {
  const { file } = place();
  const store = new Credentials(file, fakeCipher());
  await store.set("anthropic-key", "key");
  await store.set("chatgpt-host-id", "urn:uuid:host");
  await store.delete("anthropic-key");
  assert.equal(await store.has("anthropic-key"), false);
  assert.equal(await store.get("anthropic-key"), null);
  assert.equal(await store.get("chatgpt-host-id"), "urn:uuid:host");
  await store.delete("anthropic-key");
  assert.equal(await store.get("chatgpt-host-id"), "urn:uuid:host");
});

test("concurrent sets keep every value", async () => {
  const { file } = place();
  const store = new Credentials(file, fakeCipher());
  await Promise.all([store.set("anthropic-key", "a"), store.set("chatgpt-refresh", "b"), store.set("chatgpt-host-id", "c")]);
  assert.deepEqual(
    [await store.get("anthropic-key"), await store.get("chatgpt-refresh"), await store.get("chatgpt-host-id")],
    ["a", "b", "c"],
  );
});

test("an unavailable keychain is reported and nothing is written", async () => {
  const { file } = place();
  let encrypted = 0;
  const cipher = safeStorageCipher({
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async (s) => { encrypted++; return Buffer.from(s); },
    decryptStringAsync: async (b) => ({ result: b.toString() }),
  });
  const store = new Credentials(file, cipher);
  await assert.rejects(store.set("anthropic-key", "sk-ant-secret"), /encryption isn't available, so nothing was saved/);
  assert.equal(encrypted, 0, "safeStorage was not asked to encrypt");
  assert.equal(existsSync(file), false);
});

test("a failing cipher saves nothing and a stored value it can't open is an error, not null", async () => {
  const { file } = place();
  const good = fakeCipher();
  await new Credentials(file, good).set("anthropic-key", "first");
  const broken: Cipher = { encrypt: async () => { throw new Error("keychain locked"); }, decrypt: async () => { throw new Error("keychain locked"); } };
  const store = new Credentials(file, broken);
  await assert.rejects(store.set("anthropic-key", "second"), /nothing was saved: keychain locked/);
  await assert.rejects(store.get("anthropic-key"), /couldn't unlock the saved Anthropic API key/);
  assert.equal(await new Credentials(file, good).get("anthropic-key"), "first");
});

test("safeStorageCipher uses the async API when it is available", async () => {
  const cipher = safeStorageCipher({
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => Buffer.from([...s].reverse().join("")),
    decryptStringAsync: async (b) => ({ result: [...b.toString()].reverse().join("") }),
  });
  assert.equal(await cipher.decrypt(await cipher.encrypt("abc")), "abc");
});

test("a symlink at the file name is replaced, never followed", async () => {
  const { dir, file } = place();
  await new Credentials(join(dir, "seed.json"), fakeCipher()).set("chatgpt-host-id", "seed");
  const victim = join(mkdtempSync(join(tmpdir(), "dum-credentials-victim-")), "victim.txt");
  writeFileSync(victim, "untouched");
  symlinkSync(victim, file);
  const store = new Credentials(file, fakeCipher());
  assert.equal(await store.has("anthropic-key"), false);
  await store.set("anthropic-key", "key");
  assert.equal(readFileSync(victim, "utf8"), "untouched");
  assert.equal(await store.get("anthropic-key"), "key");
});

test("a corrupt file is set aside and treated as empty", async () => {
  const { dir, file } = place();
  await new Credentials(file, fakeCipher()).set("anthropic-key", "key");
  writeFileSync(file, "{not json");
  const store = new Credentials(file, fakeCipher());
  assert.equal(await store.has("anthropic-key"), false);
  assert.ok(readdirSync(dir).some((n) => n.startsWith("credentials.json.invalid-")));
  await store.set("anthropic-key", "fresh");
  assert.equal(await store.get("anthropic-key"), "fresh");
});

test("empty and oversized values are refused", async () => {
  const { file } = place();
  const store = new Credentials(file, fakeCipher());
  await assert.rejects(store.set("anthropic-key", ""), /empty/);
  await assert.rejects(store.set("anthropic-key", "x".repeat(64 * 1024)), /too large/);
  assert.equal(existsSync(file), false);
});
