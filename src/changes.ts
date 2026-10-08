// Direct changes (rules 1, 6 and 7). On command, when the user holds every skill a change names,
// Dum writes the shared or followed file itself: no yes/no step, the diff shown after, and a
// one-click revert. It writes only if the file still has the bytes Dum read, and reverts only if
// it still has the bytes Dum wrote. Each change keeps, under the zone,
// changes/<id>/{change.json, before, after, change.patch, path}; `path` is the host-private
// absolute location revert needs after the request's shares have lapsed.

import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { classify, mayChange, type Kind, type Mode } from "./gate.ts";
import type * as skills from "./skills.ts";
import { createState, readState, statePath, writeState } from "./state-files.ts";
import { bound, readText, sha, unifiedDiff } from "./shared-files.ts";
import { IdSchema, ResourcePathSchema, SHARE_LIMITS, type InputBinding, type RequestBinding, type ResourcePath, type Resources } from "./share-types.ts";
import { ChangeManifestSchema, ChangeReceiptSchema, ShaSchema, ZONE_LIMITS, type ChangeManifest, type ChangeReceipt, type SkillRef, type ZoneId } from "./zone-types.ts";

/** What change() checks against: the live grants, tree and holds for this request. */
export type ChangeDeps = { home: string; resources: Resources; tree: skills.Tree; held: ReadonlySet<string>; mode: Mode };

const MANIFEST_BYTES = 16 * 1024;
const MORE = "the full patch is kept with the change";

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/**
 * Write `next` to `target` for the named skills. Refuses, writing nothing, when a skill isn't held
 * at its level today (rule 1: a concept needs build, a tool recognize, and a skill on a curated
 * track is a concept whatever it's called) or when the file no longer hashes to `baseSha`, the
 * digest of the bytes the model read (rule 7; null means the file must not exist yet). New files
 * go only in a shared or followed folder.
 */
export async function change(
  deps: ChangeDeps,
  zoneId: ZoneId,
  binding: RequestBinding,
  target: ResourcePath,
  baseSha: string | null,
  next: string,
  skillRefs: (SkillRef & { kind?: Kind })[],
): Promise<ChangeReceipt> {
  IdSchema.parse(zoneId);
  if (binding.zoneId !== zoneId) throw new Error("that request belongs to another zone - nothing written");
  if (!ResourcePathSchema.safeParse(target).success) throw new Error(`${target} isn't a shared file name - nothing written`);
  if (baseSha !== null && !ShaSchema.safeParse(baseSha).success) throw new Error("base_sha must be the sha256 Dum read - nothing written");
  if (next.includes("\0") || Buffer.byteLength(next) > ZONE_LIMITS.changeBytes) {
    throw new Error(`a change must be text under ${ZONE_LIMITS.changeBytes / 1024} KiB - nothing written`);
  }
  if (skillRefs.length > ZONE_LIMITS.focusSkills) throw new Error(`a change can name at most ${ZONE_LIMITS.focusSkills} skills - nothing written`);

  // Rule 1, decided now against the live tree and holds, for this exact resource and its language.
  const pieces = classify(deps.tree, skillRefs.map((s) => ({ skill: s.name, lang: s.lang, kind: s.kind, what: "", paths: [target] })), deps.mode, deps.held);
  const verdict = mayChange(deps.tree, deps.mode, pieces, target, skillRefs.map((s) => s.name), deps.held);
  if (!verdict.ok) throw new Error(`${verdict.why} - nothing written`);

  // Rule 7: the file must still be what the model read.
  const { absolute, currentSha } = await deps.resources.target(target);
  const current = currentSha === null ? null : await deps.resources.file(target);
  if (currentSha !== baseSha || (current && current.sha !== baseSha)) {
    throw new Error(
      baseSha === null
        ? `${target} already exists - read it first; Dum changes files against what it read. Nothing written`
        : currentSha === null
          ? `${target} no longer exists - it changed since Dum read it. Nothing written`
          : `${target} changed since Dum read it - nothing written; read it again`,
    );
  }
  const before = current?.text ?? null;
  if (before === next) throw new Error(`that doesn't change ${target}`);

  const patch = unifiedDiff(target, before, next);
  const nextSha = sha(next);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const manifest = ChangeManifestSchema.parse({
    version: 1, id, zoneId, requestId: binding.requestId, createdAt, target, baseSha, nextSha,
    skills: skillRefs.map(({ name, lang }) => ({ name, lang })), revertedAt: null,
  });
  const dir = `zones/${zoneId}/changes/${id}`;
  const keep = (name: string, body: string) => {
    if (!createState(deps.home, `${dir}/${name}`, body)) throw new Error(`${dir}/${name} already exists - nothing written`);
  };
  try {
    // Everything revert needs is durable before the user's file changes.
    if (before !== null) keep("before", before);
    keep("after", next);
    keep("change.patch", patch);
    keep("path", absolute);
    keep("change.json", `${JSON.stringify(manifest, null, 2)}\n`);
    if (before === null) create(absolute, next, target);
    else replace(absolute, next, baseSha!, target);
  } catch (err) {
    rmSync(dirname(statePath(deps.home, `${dir}/change.json`)), { recursive: true, force: true });
    throw err;
  }

  // Read the written file back through the grant, so its bytes are the last Dum read. The write
  // has landed either way; the receipt says whether revert can still find Dum's bytes there.
  let revertible: boolean;
  try {
    revertible = (await deps.resources.file(target)).sha === nextSha;
  } catch {
    revertible = false;
  }
  return ChangeReceiptSchema.parse({ id, zoneId, target, baseSha, nextSha, diff: bound(patch, MORE), appliedAt: createdAt, revertible });
}

/**
 * Put back what a change replaced, or remove the file it created, only if the file still hashes to
 * what Dum wrote (rule 7). A UI action, possibly after the request that made the change ended.
 */
export async function revertChange(home: string, zoneId: ZoneId, binding: InputBinding, changeId: string): Promise<ChangeReceipt> {
  IdSchema.parse(zoneId);
  if (binding.zoneId !== zoneId) throw new Error("that change belongs to another zone - nothing reverted");
  if (!IdSchema.safeParse(changeId).success) throw new Error("there's no such change");
  const dir = `zones/${zoneId}/changes/${changeId}`;
  const body = readState(home, `${dir}/change.json`, MANIFEST_BYTES);
  if (body === null) throw new Error("there's no such change in this zone");
  const manifest = parse(body, `${dir}/change.json`);
  const label = manifest.target;
  if (manifest.revertedAt) throw new Error(`that change to ${label} was already reverted`);
  const absolute = readState(home, `${dir}/path`, 4096);
  const after = readState(home, `${dir}/after`, ZONE_LIMITS.changeBytes);
  const before = manifest.baseSha === null ? null : readState(home, `${dir}/before`, SHARE_LIMITS.fileBytes);
  if (absolute === null || !isAbsolute(absolute) || after === null || sha(after) !== manifest.nextSha
    || (manifest.baseSha !== null && (before === null || sha(before) !== manifest.baseSha))) {
    throw new Error(`what Dum kept for that change to ${label} is damaged - nothing reverted`);
  }

  let st;
  try {
    st = lstatSync(absolute);
  } catch (err) {
    if (code(err) !== "ENOENT" && code(err) !== "ENOTDIR") throw err;
    throw new Error(`${label} isn't there any more - nothing reverted`);
  }
  if (st.isSymbolicLink() || !st.isFile() || realpathSync(absolute) !== absolute) throw new Error(`${label} moved since Dum wrote it - nothing reverted`);
  if (readText(absolute, label).sha !== manifest.nextSha) throw new Error(`${label} changed since Dum wrote it - nothing reverted; your edits stay`);
  if (before === null) unlinkSync(absolute);
  else replace(absolute, before, manifest.nextSha, label);
  const revertedAt = new Date().toISOString();
  writeState(home, `${dir}/change.json`, `${JSON.stringify({ ...manifest, revertedAt }, null, 2)}\n`);
  return ChangeReceiptSchema.parse({
    id: manifest.id,
    zoneId,
    target: label,
    baseSha: manifest.baseSha,
    nextSha: manifest.nextSha,
    diff: bound(unifiedDiff(label, after, before), MORE),
    appliedAt: revertedAt,
    revertible: false,
  });
}

/** Every change kept for a zone, newest first. A damaged record is an error, not a gap. */
export function listChanges(home: string, zoneId: ZoneId): ChangeManifest[] {
  IdSchema.parse(zoneId);
  let at = home;
  for (const part of ["", "zones", zoneId, "changes"]) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch (err) {
      if (code(err) === "ENOENT") return [];
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${at} isn't a real folder - Dum won't follow it`);
  }
  const out: ChangeManifest[] = [];
  for (const id of readdirSync(at)) {
    if (!IdSchema.safeParse(id).success) continue;
    const file = `zones/${zoneId}/changes/${id}/change.json`;
    // A folder without its manifest is a change that never reached the user's file.
    const body = readState(home, file, MANIFEST_BYTES);
    if (body !== null) out.push(parse(body, file));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

function parse(body: string, file: string): ChangeManifest {
  try {
    return ChangeManifestSchema.parse(JSON.parse(body));
  } catch (err) {
    throw new Error(`${file} is damaged and was left as it is: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Writing the user's file

const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** A complete temporary file beside `abs`, synced, with exactly `mode`. The caller renames or links it. */
function tempFile(abs: string, body: string, mode: number): string {
  for (let attempt = 0; ; attempt++) {
    const temp = join(dirname(abs), `.${basename(abs).slice(0, 100)}.dum-${randomBytes(6).toString("hex")}.tmp`);
    let fd: number;
    try {
      fd = openSync(temp, WRITE_FLAGS, mode);
    } catch (err) {
      if (code(err) === "EEXIST" && attempt < 3) continue;
      throw err;
    }
    try {
      const buf = Buffer.from(body);
      let put = 0;
      while (put < buf.length) put += writeSync(fd, buf, put, buf.length - put);
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      unlinkSync(temp);
      throw err;
    }
    closeSync(fd);
    return temp;
  }
}

/**
 * Replace an existing file atomically with `body`, keeping its permissions. The last look before
 * the rename decides: if the file no longer hashes to `expected`, an editor saved since, and its
 * bytes stay.
 */
function replace(abs: string, body: string, expected: string, label: string): void {
  const st = lstatSync(abs);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${label} isn't a regular file any more - nothing written`);
  const temp = tempFile(abs, body, st.mode & 0o7777);
  try {
    if (readText(abs, label).sha !== expected) throw new Error(`${label} changed while Dum was writing it - nothing written; read it again`);
    if (realpathSync(dirname(abs)) !== dirname(abs)) throw new Error(`${label}: a folder on the way moved - nothing written`);
    renameSync(temp, abs);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * A brand-new file: complete before its name appears, and link(2) refuses an existing name, so a
 * file the user's editor created first always wins.
 */
function create(abs: string, body: string, label: string): void {
  const dir = dirname(abs);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const temp = tempFile(abs, body, 0o644);
  try {
    if (realpathSync(dir) !== dir) throw new Error(`${label}: a folder on the way is a symlink - nothing written`);
    linkSync(temp, abs);
  } catch (err) {
    if (code(err) === "EEXIST") throw new Error(`${label} appeared while Dum was creating it - yours was kept, Dum's discarded`);
    if (code(err) === "EPERM" || code(err) === "ENOTSUP" || code(err) === "EOPNOTSUPP" || code(err) === "EXDEV") {
      throw new Error(`this filesystem can't create ${label} without risking a replace, so Dum didn't create it`);
    }
    throw err;
  } finally {
    rmSync(temp, { force: true });
  }
}
