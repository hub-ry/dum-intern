/**
 * Prepare the bundled OpenSuperWhisper (OSW) helper for macOS arm64 packaging.
 *
 * Downloads the official DMG release, verifies SHA-256 against the pinned
 * digest, mounts the disk image, copies the .app bundle via `ditto` (preserves
 * macOS extended attributes and executable bits), saves the upstream MIT
 * license, then unmounts.
 *
 * Run as: node tools/prepare-dictation.mjs
 *
 * On darwin/arm64: downloads and installs the helper into build/extra-resources/.
 * On all other platforms: creates the output directory (so electron-builder's
 *   extraResources glob does not error) and exits immediately.
 *
 * Idempotent: if OpenSuperWhisper.app already exists, skips the download.
 *
 * ── Pinned release ───────────────────────────────────────────────────────────
 * OpenSuperWhisper 0.1.0 — MIT License
 * https://github.com/Starmel/OpenSuperWhisper/releases/tag/0.1.0
 * Released: 2026-03-03
 * Requirements: macOS 14.0 (Sonoma), Apple Silicon (ARM64)
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, rename, readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const OSW_VERSION    = '0.1.0';
export const OSW_DMG_URL    = 'https://github.com/Starmel/OpenSuperWhisper/releases/download/0.1.0/OpenSuperWhisper.dmg';
export const OSW_DMG_SHA256 = 'af5ca5142c22e5bed3ba7d2642223c0a481e49935f5a5a6cf1bc766c7ecd9d69';
/** Hard ceiling: actual release is ~11 MB; 50 MB stops runaway responses before hashing. */
export const OSW_DMG_MAX_BYTES = 50 * 1024 * 1024;

const OSW_LICENSE_URL = 'https://raw.githubusercontent.com/Starmel/OpenSuperWhisper/0.1.0/LICENSE';
const OUTPUT_DIR  = resolve('build/extra-resources');
const APP_DEST    = join(OUTPUT_DIR, 'OpenSuperWhisper.app');
const LICENSE_DEST = join(OUTPUT_DIR, 'OpenSuperWhisper-LICENSE.txt');

/**
 * Path traversal guard: resolved target must be strictly inside resolvedBase.
 * Exported for tests.
 */
export function isPathInsideBase(resolvedTarget, resolvedBase) {
  return resolvedTarget === resolvedBase ||
    resolvedTarget.startsWith(resolvedBase + sep);
}

/**
 * Download bounds guard: received bytes must not exceed the ceiling.
 * Exported for tests.
 */
export function isSizeWithinBounds(receivedBytes, maxBytes) {
  return receivedBytes <= maxBytes;
}

/**
 * Download `url` to `dest`, streaming through a byte counter.
 * Rejects if total bytes exceed `maxBytes` before EOF, or on non-200 status.
 * Uses the global `fetch` (Node.js 18+) which follows redirects automatically.
 */
export async function downloadTo(url, dest, maxBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${url}`);
  let received = 0;
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (chunks) {
      for await (const chunk of chunks) {
        received += chunk.length;
        if (!isSizeWithinBounds(received, maxBytes)) throw new Error(`Download exceeded ${maxBytes} byte ceiling (${url})`);
        yield chunk;
      }
    },
    createWriteStream(dest),
  );
}

/**
 * Verify a file's SHA-256 against the expected hex digest.
 * Exported for tests (pass a Buffer directly via verifyBuffer).
 */
export async function verifySha256(filePath, expectedHex) {
  const bytes = await readFile(filePath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedHex) {
    throw new Error(
      `SHA-256 mismatch for ${filePath}\n  expected: ${expectedHex}\n  actual:   ${actual}\n` +
      `Do not use this file.`
    );
  }
}

// ── Main execution (only when run directly) ──────────────────────────────────

// Guard lets the module be imported for its exports without side-effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}

async function run() {
  // Always create the output directory so electron-builder's extraResources
  // glob finds the `from` path even on platforms where we skip the download.
  await mkdir(OUTPUT_DIR, { recursive: true });

  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.log(
      `prepare-dictation: skipping download — ${process.platform}/${process.arch} is not darwin/arm64. ` +
      `Output directory created at ${OUTPUT_DIR}.`
    );
    return;
  }

  if (existsSync(join(APP_DEST, 'Contents', 'MacOS', 'OpenSuperWhisper')) && existsSync(LICENSE_DEST)) {
    console.log(`prepare-dictation: OpenSuperWhisper.app already present; skipping download.`);
    return;
  }

  const tmpDir  = join(tmpdir(), `osw-prepare-${Date.now()}`);
  const dmgPath = join(tmpDir, 'OpenSuperWhisper.dmg');
  await mkdir(tmpDir, { recursive: true });

  // ── Download ──────────────────────────────────────────────────────────────
  console.log(`prepare-dictation: downloading OSW ${OSW_VERSION} …`);
  await downloadTo(OSW_DMG_URL, dmgPath, OSW_DMG_MAX_BYTES);
  console.log(`prepare-dictation: download complete (${(await readFile(dmgPath)).length} bytes)`);

  // ── Verify SHA-256 ────────────────────────────────────────────────────────
  console.log(`prepare-dictation: verifying SHA-256 …`);
  await verifySha256(dmgPath, OSW_DMG_SHA256);
  console.log(`prepare-dictation: SHA-256 verified ✓`);

  // ── Mount DMG ─────────────────────────────────────────────────────────────
  const mountPoint = join(tmpDir, 'mounted');
  await mkdir(mountPoint, { recursive: true });
  console.log(`prepare-dictation: mounting DMG …`);
  execFileSync('/usr/bin/hdiutil', [
    'attach', dmgPath,
    '-nobrowse', '-readonly',
    '-mountpoint', mountPoint,
  ], { stdio: 'inherit' });

  let unmounted = false;
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    spawnSync('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { stdio: 'ignore' });
  };
  process.on('exit', unmount);
  process.on('SIGINT',  () => { unmount(); process.exit(130); });
  process.on('SIGTERM', () => { unmount(); process.exit(143); });

  // ── Validate mounted app path (path traversal guard) ──────────────────────
  const resolvedMount = resolve(mountPoint);
  const sourceApp     = resolve(join(mountPoint, 'OpenSuperWhisper.app'));
  if (!isPathInsideBase(sourceApp, resolvedMount)) {
    unmount();
    await rm(tmpDir, { recursive: true, force: true });
    throw new Error(`Path traversal detected: resolved app path ${sourceApp} escapes mount at ${resolvedMount}`);
  }
  if (!existsSync(sourceApp)) {
    unmount();
    await rm(tmpDir, { recursive: true, force: true });
    throw new Error(`OpenSuperWhisper.app not found in mounted DMG at expected path ${sourceApp}`);
  }

  // ── Copy app ──────────────────────────────────────────────────────────────
  // ditto preserves HFS+ metadata, extended attributes, and executable bits.
  console.log(`prepare-dictation: copying app to ${APP_DEST} …`);
  execFileSync('/usr/bin/ditto', [sourceApp, APP_DEST], { stdio: 'inherit' });
  unmount();

  // ── Download and save upstream MIT license ────────────────────────────────
  console.log(`prepare-dictation: fetching OSW MIT license …`);
  const licenseTmp = `${LICENSE_DEST}.tmp`;
  await downloadTo(OSW_LICENSE_URL, licenseTmp, 64 * 1024);
  await rename(licenseTmp, LICENSE_DEST);
  console.log(`prepare-dictation: license saved to ${LICENSE_DEST}`);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await rm(tmpDir, { recursive: true, force: true });
  console.log(`prepare-dictation: done — OpenSuperWhisper.app ready at ${APP_DEST}`);
}
