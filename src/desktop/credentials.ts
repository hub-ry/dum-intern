// Main's encrypted credential store: the ChatGPT sign-in record, this Mac's SIWC host ID and the
// Anthropic API key. Each value is encrypted on its own by an injected cipher (Electron's async
// safeStorage in the app), so the file on disk holds kind names and ciphertext only. Settings,
// env and logs never see these values.

import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

export type CredentialKind = "chatgpt-refresh" | "chatgpt-host-id" | "anthropic-key";
export type Cipher = { encrypt(text: string): Promise<Buffer>; decrypt(data: Buffer): Promise<string> };

/** The slice of Electron's `safeStorage` this store uses; only the async API, which outlives the sync one. */
export type AsyncSafeStorage = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string }>;
};

const KINDS = ["chatgpt-refresh", "chatgpt-host-id", "anthropic-key"] as const satisfies readonly CredentialKind[];
const MAX_FILE = 256 * 1024;
const MAX_VALUE = 32 * 1024;
const UNAVAILABLE = "Dum can't protect credentials on this Mac because its keychain encryption isn't available, so nothing was saved.";

const Stored = z.object({
  version: z.literal(1),
  entries: z.partialRecord(z.enum(KINDS), z.base64().max(Math.ceil((MAX_VALUE * 2) / 3) * 4)),
}).strict();
type Entries = z.infer<typeof Stored>["entries"];

/** Electron main backs the store with this; it refuses rather than writing anything unprotected. */
export function safeStorageCipher(storage: AsyncSafeStorage): Cipher {
  const available = async () => {
    if (!(await storage.isAsyncEncryptionAvailable())) throw new Error(UNAVAILABLE);
  };
  return {
    async encrypt(text) {
      await available();
      return storage.encryptStringAsync(text);
    },
    async decrypt(data) {
      await available();
      return (await storage.decryptStringAsync(data)).result;
    },
  };
}

export class Credentials {
  /** Writes run one at a time, so two sets can't drop each other's entry. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string, private readonly cipher: Cipher) {}

  async has(kind: CredentialKind): Promise<boolean> {
    await this.queue;
    return this.read()[kind] !== undefined;
  }

  /** Null when nothing is stored. Throws when a stored value can't be decrypted. */
  async get(kind: CredentialKind): Promise<string | null> {
    await this.queue;
    const data = this.read()[kind];
    if (data === undefined) return null;
    try {
      return await this.cipher.decrypt(Buffer.from(data, "base64"));
    } catch (err) {
      throw new Error(`Dum couldn't unlock the saved ${label(kind)}: ${reason(err)}`);
    }
  }

  async set(kind: CredentialKind, value: string): Promise<void> {
    if (!value) throw new Error(`An empty ${label(kind)} can't be saved`);
    if (Buffer.byteLength(value) > MAX_VALUE) throw new Error(`The ${label(kind)} is too large to save`);
    await this.serial(async () => {
      let sealed: Buffer;
      try {
        sealed = await this.cipher.encrypt(value);
      } catch (err) {
        throw new Error(reason(err) === UNAVAILABLE ? UNAVAILABLE : `Dum couldn't protect the ${label(kind)}, so nothing was saved: ${reason(err)}`);
      }
      this.write({ ...this.read(), [kind]: sealed.toString("base64") });
    });
  }

  async delete(kind: CredentialKind): Promise<void> {
    await this.serial(async () => {
      const entries = this.read();
      if (entries[kind] === undefined) return;
      delete entries[kind];
      this.write(entries);
    });
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** A missing file is empty; an unreadable one is set aside, never trusted or silently overwritten. */
  private read(): Entries {
    let raw: string;
    try {
      const st = lstatSync(this.file);
      if (!st.isFile() || st.size > MAX_FILE) throw new Error("not a small regular file");
      raw = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      this.setAside();
      return {};
    }
    try {
      return Stored.parse(JSON.parse(raw)).entries;
    } catch {
      this.setAside();
      return {};
    }
  }

  private setAside(): void {
    renameSync(this.file, `${this.file}.invalid-${Date.now()}`);
  }

  /** A complete owner-only temp file renamed over the name; a symlink there is replaced, never followed. */
  private write(entries: Entries): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: 1, entries } satisfies z.infer<typeof Stored>);
    const temp = join(dir, `.${basename(this.file)}.${process.pid}.${randomBytes(6).toString("hex")}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.file);
    } catch (err) {
      unlinkSync(temp);
      throw err;
    }
  }
}

function label(kind: CredentialKind): string {
  return kind === "anthropic-key" ? "Anthropic API key" : kind === "chatgpt-host-id" ? "ChatGPT host ID" : "ChatGPT sign-in";
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
