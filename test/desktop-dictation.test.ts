// Isolated behavior tests for the bundled OpenSuperWhisper dictation helper.
// No network, no Electron, no actual native app required.
// Covers: platform gating, bundle validation, open() launch control,
//         path traversal prevention, and pinned-asset build constants.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DictationHelper,
  OSW_BUNDLE_ID,
  type DictationPorts,
} from "../src/desktop/dictation.ts";
import {
  isPathInsideBase,
  isSizeWithinBounds,
} from "../tools/prepare-dictation.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "dum-dictation-"));

/** Build a minimal valid OpenSuperWhisper.app bundle inside `resourcesDir`. */
function fakeBundle(resourcesDir: string, version = "0.1.0"): string {
  const appDir  = join(resourcesDir, "OpenSuperWhisper.app");
  const macosDir = join(appDir, "Contents", "MacOS");
  const execPath  = join(macosDir, "OpenSuperWhisper");
  const plistPath = join(appDir, "Contents", "Info.plist");
  mkdirSync(macosDir, { recursive: true });
  writeFileSync(execPath, "#!/bin/sh\n");
  chmodSync(execPath, 0o755);
  writeFileSync(plistPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "">',
    '<plist version="1.0"><dict>',
    `  <key>CFBundleIdentifier</key><string>${OSW_BUNDLE_ID}</string>`,
    `  <key>CFBundleShortVersionString</key><string>${version}</string>`,
    '</dict></plist>',
  ].join("\n"), "utf8");
  return appDir;
}

function ports(overrides: Partial<DictationPorts> = {}): DictationPorts & { opened: string[] } {
  const opened: string[] = [];
  return {
    platform: "darwin",
    arch: "arm64",
    systemVersion: "14.0",
    resourcesPath: () => temp(),
    spawnOpen: (p) => opened.push(p),
    opened,
    ...overrides,
  };
}

// ── Platform gating ───────────────────────────────────────────────────────────

test("supported is false and available is false on Linux", () => {
  const d = new DictationHelper(ports({ platform: "linux", arch: "x64" }));
  const s = d.status();
  assert.equal(s.supported, false);
  assert.equal(s.available, false);
  assert.equal(s.version, "");
});

test("supported is false on macOS x64 (Intel Mac)", () => {
  const d = new DictationHelper(ports({ platform: "darwin", arch: "x64" }));
  const s = d.status();
  assert.equal(s.supported, false);
  assert.equal(s.available, false);
});

test("macOS 13 cannot launch the Apple Silicon helper even when it is bundled", async () => {
  const dir = temp();
  fakeBundle(dir);
  const o = ports({ resourcesPath: () => dir, systemVersion: "13.6" });
  const d = new DictationHelper(o);
  assert.equal(d.status().supported, false);
  assert.equal(d.status().available, false);
  await assert.rejects(() => d.open(), Error);
  assert.equal(o.opened.length, 0);
});

test("supported is false on win32", () => {
  const d = new DictationHelper(ports({ platform: "win32", arch: "x64" }));
  assert.equal(d.status().supported, false);
});

test("open() throws on unsupported platform without calling spawnOpen", async () => {
  const o = ports({ platform: "linux", arch: "x64" });
  const d = new DictationHelper(o);
  await assert.rejects(() => d.open(), /macOS.*Apple Silicon/i);
  assert.equal(o.opened.length, 0);
});

test("open() throws on darwin/x64 (Intel Mac) without calling spawnOpen", async () => {
  const o = ports({ platform: "darwin", arch: "x64" });
  const d = new DictationHelper(o);
  await assert.rejects(() => d.open(), /macOS.*Apple Silicon/i);
  assert.equal(o.opened.length, 0);
});

// ── Bundle availability ───────────────────────────────────────────────────────

test("supported true, available false when resource dir has no OpenSuperWhisper.app", () => {
  const dir = temp();
  const d = new DictationHelper(ports({ resourcesPath: () => dir }));
  const s = d.status();
  assert.equal(s.supported, true);
  assert.equal(s.available, false);
  assert.equal(s.version, "");
});

test("supported true, available false when app dir exists but executable is missing", () => {
  const dir = temp();
  const appDir = join(dir, "OpenSuperWhisper.app", "Contents", "MacOS");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(dir, "OpenSuperWhisper.app", "Contents", "Info.plist"), "<plist/>");
  // No executable file inside MacOS/
  const d = new DictationHelper(ports({ resourcesPath: () => dir }));
  assert.equal(d.status().available, false);
});

test("supported true, available false when Info.plist is missing", () => {
  const dir = temp();
  const macosDir = join(dir, "OpenSuperWhisper.app", "Contents", "MacOS");
  mkdirSync(macosDir, { recursive: true });
  writeFileSync(join(macosDir, "OpenSuperWhisper"), "");
  // No plist file
  const d = new DictationHelper(ports({ resourcesPath: () => dir }));
  assert.equal(d.status().available, false);
});

test("supported true, available false when app path is a file not a directory", () => {
  const dir = temp();
  writeFileSync(join(dir, "OpenSuperWhisper.app"), "not a bundle");
  const d = new DictationHelper(ports({ resourcesPath: () => dir }));
  assert.equal(d.status().available, false);
});

test("supported and available when bundle has full valid structure", () => {
  const dir = temp();
  fakeBundle(dir);
  const d = new DictationHelper(ports({ resourcesPath: () => dir }));
  const s = d.status();
  assert.equal(s.supported, true);
  assert.equal(s.available, true);
  assert.equal(s.version, "0.1.0");
});

test("version is read from CFBundleShortVersionString in Info.plist", () => {
  const dir = temp();
  fakeBundle(dir, "99.0.0-test");
  const d = new DictationHelper(ports({ resourcesPath: () => dir }));
  assert.equal(d.status().version, "99.0.0-test");
});

test("version is empty string when plist has no CFBundleShortVersionString", () => {
  const dir = temp();
  const appDir = join(dir, "OpenSuperWhisper.app");
  const macosDir = join(appDir, "Contents", "MacOS");
  mkdirSync(macosDir, { recursive: true });
  writeFileSync(join(macosDir, "OpenSuperWhisper"), "");
  // Plist with no version key
  writeFileSync(join(appDir, "Contents", "Info.plist"), "<plist><dict></dict></plist>");
  const d = new DictationHelper(ports({ resourcesPath: () => dir }));
  assert.equal(d.status().version, "");
});

// ── open() launch control ────────────────────────────────────────────────────

test("a helper removed after the availability check cannot be launched", async () => {
  const dir = temp();
  const appDir = fakeBundle(dir);
  const o = ports({ resourcesPath: () => dir });
  const d = new DictationHelper(o);
  assert.equal(d.status().available, true);
  rmSync(join(appDir, "Contents", "MacOS", "OpenSuperWhisper"));
  await assert.rejects(() => d.open(), Error);
  assert.equal(o.opened.length, 0);
});

test("open() throws and does not call spawnOpen when bundle is missing", async () => {
  const dir = temp();
  const o = ports({ resourcesPath: () => dir });
  const d = new DictationHelper(o);
  await assert.rejects(() => d.open(), /not available|missing/i);
  assert.equal(o.opened.length, 0);
});

test("open() throws when bundle is structurally invalid (missing executable)", async () => {
  const dir = temp();
  mkdirSync(join(dir, "OpenSuperWhisper.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(dir, "OpenSuperWhisper.app", "Contents", "Info.plist"), "<plist/>");
  const o = ports({ resourcesPath: () => dir });
  const d = new DictationHelper(o);
  await assert.rejects(() => d.open(), /not available|missing|verified/i);
  assert.equal(o.opened.length, 0);
});

// ── Path traversal prevention ────────────────────────────────────────────────

test("symlink that escapes resourcesPath is rejected even though target bundle is valid", () => {
  // A symlink at resources/OpenSuperWhisper.app → ../outer/OpenSuperWhisper.app
  // escapes the resources directory. validateBundle() must detect this via
  // realpathSync() and refuse it.
  const outer     = temp();
  const resources = join(outer, "resources");
  mkdirSync(resources, { recursive: true });
  fakeBundle(outer); // real valid bundle lives OUTSIDE resources/
  // Create symlink: resources/OpenSuperWhisper.app → ../OpenSuperWhisper.app
  symlinkSync(join(outer, "OpenSuperWhisper.app"), join(resources, "OpenSuperWhisper.app"));
  const d = new DictationHelper(ports({ resourcesPath: () => resources }));
  assert.equal(d.status().available, false, "symlink escaping resources dir must be rejected");
});

// ── Build script validation logic (no downloads) ────────────────────────────

test("isPathInsideBase accepts path that is exactly the base", () => {
  assert.ok(isPathInsideBase("/a/b", "/a/b"));
});

test("isPathInsideBase accepts path strictly inside the base", () => {
  assert.ok(isPathInsideBase("/a/b/c", "/a/b"));
});

test("isPathInsideBase rejects resolved sibling path", () => {
  // The function operates on already-resolved paths (caller uses path.resolve/realpathSync first).
  // Unresolved dotdot "/a/b/../c" starts with "/a/b/" as a raw string and is not the function's
  // concern; the prepare script calls resolve() before passing to this guard.
  assert.ok(!isPathInsideBase("/a/c", "/a/b"),
    "sibling directory is not inside base");
  assert.ok(!isPathInsideBase("/a", "/a/b"),
    "parent directory is not inside base");
});

test("isPathInsideBase rejects partial directory name match", () => {
  // /a/base-extra must not be considered inside /a/base
  assert.ok(!isPathInsideBase("/a/base-extra", "/a/base"),
    "partial name match with separator difference is not inside base");
});

test("isSizeWithinBounds accepts zero bytes", () => {
  assert.ok(isSizeWithinBounds(0, 1024));
});

test("isSizeWithinBounds accepts exactly the max", () => {
  assert.ok(isSizeWithinBounds(1024, 1024));
});

test("isSizeWithinBounds rejects one byte over the max", () => {
  assert.ok(!isSizeWithinBounds(1025, 1024));
});

