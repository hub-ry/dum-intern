/**
 * Build Dum's native helpers into build/extra-resources/ for electron-builder.
 *
 *   dum-focus               universal (arm64 + x86_64) focus helper, from native/macos/FocusBridge.swift.
 *                           Built on any Mac.
 *   OpenSuperWhisper.app    the controlled voice helper: vendor/OpenSuperWhisper (OpenSuperWhisper 0.1.0,
 *                           commit e406fee) compiled with DUM_BRIDGE, bundle ID com.dumintern.opensuperwhisper.
 *                           Built on Apple Silicon only, the one platform voice supports.
 *   OpenSuperWhisper-LICENSE.txt, OpenSuperWhisper-THIRD-PARTY.txt
 *
 * Off macOS it only creates the output directory, so electron-builder's extraResources entry resolves.
 * Each helper is rebuilt only when its sources change (digests in build/native-stamps/).
 *
 * Voice build prerequisites (Apple Silicon): Xcode (not just the Command Line Tools), cmake, Rust with
 * the aarch64-apple-darwin target, git, and network access: the two upstream git submodules are fetched
 * at the commits pinned in vendor/OpenSuperWhisper/DUM-VENDOR.json and the Swift packages are cloned at
 * the vendored Package.resolved versions (automatic resolution disabled). whisper.cpp builds without
 * OpenMP (vendor/OpenSuperWhisper/libwhisper/CMakeLists.txt), so no Homebrew runtime is linked or
 * shipped. No speech model is bundled: the helper downloads one in Dum's voice setup on first use.
 *
 * Run as: node tools/prepare-dictation.mjs
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = join(ROOT, 'build', 'extra-resources');
const STAMPS = join(ROOT, 'build', 'native-stamps');
const VENDOR = join(ROOT, 'vendor', 'OpenSuperWhisper');
const FOCUS_SOURCE = join(ROOT, 'native', 'macos', 'FocusBridge.swift');

/** SHA-256 over every file under `dir`: sorted relative paths and contents. */
function treeDigest(dir) {
  const hash = createHash('sha256');
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(`${relative(dir, path)}\0`).update(readFileSync(path)).update('\0');
      else throw new Error(`prepare-dictation: ${relative(dir, path)} is not a regular file`);
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function output(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

async function fresh(name, digest, built) {
  const stamp = join(STAMPS, name);
  return existsSync(built) && existsSync(stamp) && (await readFile(stamp, 'utf8')) === digest;
}

async function buildFocus() {
  const target = join(OUTPUT, 'dum-focus');
  const digest = createHash('sha256').update(readFileSync(FOCUS_SOURCE)).digest('hex');
  if (await fresh('focus.sha256', digest, target)) {
    console.log('prepare-dictation: dum-focus is up to date.');
    return;
  }
  const work = join(ROOT, 'build', 'focus-work');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const slices = [];
  for (const arch of ['arm64', 'x86_64']) {
    const slice = join(work, `dum-focus-${arch}`);
    console.log(`prepare-dictation: compiling dum-focus for ${arch} …`);
    run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', `${arch}-apple-macos13.0`, FOCUS_SOURCE, '-o', slice], ROOT);
    slices.push(slice);
  }
  await rm(target, { force: true });
  run('/usr/bin/lipo', ['-create', ...slices, '-output', target], ROOT);
  const archs = output('/usr/bin/lipo', ['-archs', target], ROOT).split(/\s+/).sort().join(' ');
  if (archs !== 'arm64 x86_64') throw new Error(`prepare-dictation: dum-focus has architectures "${archs}", expected arm64 and x86_64`);
  await rm(work, { recursive: true, force: true });
  await writeFile(join(STAMPS, 'focus.sha256'), digest);
  console.log(`prepare-dictation: dum-focus ready at ${target}`);
}

function requireTool(tool, args, hint) {
  try {
    execFileSync(tool, args, { stdio: 'ignore' });
  } catch {
    throw new Error(`prepare-dictation: ${hint}`);
  }
}

/** One XML plist string value; the build asks Xcode for XML output. */
function plistString(xml, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return match ? match[1].trim() : null;
}

async function buildVoice() {
  const manifest = JSON.parse(await readFile(join(VENDOR, 'DUM-VENDOR.json'), 'utf8'));
  const target = join(OUTPUT, 'OpenSuperWhisper.app');
  const digest = treeDigest(VENDOR);
  if (await fresh('voice.sha256', digest, join(target, 'Contents', 'MacOS', 'OpenSuperWhisper'))) {
    console.log('prepare-dictation: OpenSuperWhisper.app (Dum bridge) is up to date.');
    return;
  }

  requireTool('/usr/bin/xcodebuild', ['-version'],
    'Xcode is required to build the voice helper (the Command Line Tools alone are not enough): install Xcode, then `sudo xcode-select -s /Applications/Xcode.app`.');
  requireTool('git', ['--version'], 'git is required to fetch the pinned whisper.cpp and autocorrect sources.');
  requireTool('cmake', ['--version'], 'cmake is required to build the voice helper (brew install cmake).');
  requireTool('cargo', ['--version'], 'Rust is required to build the voice helper (https://rustup.rs).');
  requireTool('rustup', ['--version'], 'rustup is required to build the voice helper (install Rust from https://rustup.rs, not Homebrew\'s rust).');
  if (!output('rustup', ['target', 'list', '--installed'], ROOT).split('\n').includes('aarch64-apple-darwin')) {
    throw new Error('prepare-dictation: run `rustup target add aarch64-apple-darwin` first.');
  }

  // Build in a scratch copy so the vendored tree stays exactly as committed.
  const work = join(ROOT, 'build', 'osw-work');
  await rm(work, { recursive: true, force: true });
  await cp(VENDOR, work, { recursive: true });

  for (const sub of manifest.submodules) {
    const dir = join(work, sub.path);
    console.log(`prepare-dictation: fetching ${sub.path} at ${sub.commit} …`);
    await mkdir(dir, { recursive: true });
    run('git', ['init', '--quiet'], dir);
    run('git', ['fetch', '--quiet', '--depth', '1', sub.url, sub.commit], dir);
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir);
    const head = output('git', ['rev-parse', 'HEAD'], dir);
    if (head !== sub.commit) throw new Error(`prepare-dictation: ${sub.path} is at ${head}, expected ${sub.commit}`);
  }

  // The native libraries, as upstream's run.sh prepares them.
  const libs = join(work, 'build');
  await mkdir(libs, { recursive: true });
  run('cmake', ['-G', 'Xcode', '-B', 'libwhisper/build', '-S', 'libwhisper'], work);
  run('cargo', ['build', '-p', 'autocorrect-swift', '--release', '--target', 'aarch64-apple-darwin',
    '--manifest-path=asian-autocorrect/Cargo.toml'], work);
  const autocorrect = join(libs, 'libautocorrect_swift.dylib');
  await cp(join(work, 'asian-autocorrect', 'target', 'aarch64-apple-darwin', 'release', 'libautocorrect_swift.dylib'), autocorrect);
  run('/usr/bin/install_name_tool', ['-id', '@rpath/libautocorrect_swift.dylib', autocorrect], work);
  run('/usr/bin/codesign', ['--force', '--sign', '-', autocorrect], work);

  // Bridge mode (DUM_BRIDGE, Dum's bundle ID, Info.plist and entitlements) is set on the app target
  // in the vendored project. Settings given here apply to every target, Swift packages included.
  console.log('prepare-dictation: building OpenSuperWhisper in Dum bridge mode …');
  run('/usr/bin/xcodebuild', [
    '-project', 'OpenSuperWhisper.xcodeproj',
    '-scheme', 'OpenSuperWhisper',
    '-configuration', 'Release',
    '-derivedDataPath', 'build',
    '-destination', 'platform=macOS,arch=arm64',
    '-clonedSourcePackagesDirPath', 'SourcePackages',
    '-disableAutomaticPackageResolution',
    '-skipPackagePluginValidation',
    '-skipMacroValidation',
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGN_IDENTITY=',
    // Dum's runtime check (src/desktop/dictation.ts) reads only an XML Info.plist; "XML" is the setting's enum value.
    'INFOPLIST_OUTPUT_FORMAT=XML',
    'build',
  ], work);

  const product = join(work, 'build', 'Build', 'Products', 'Release', 'OpenSuperWhisper.app');
  const info = await readFile(join(product, 'Contents', 'Info.plist'), 'utf8');
  if (!info.trimStart().startsWith('<?xml')) {
    throw new Error('prepare-dictation: the built helper\'s Info.plist is not XML; Dum refuses a binary plist. Check INFOPLIST_OUTPUT_FORMAT.');
  }
  const expect = {
    CFBundleIdentifier: manifest.bundleId,
    CFBundleShortVersionString: manifest.release,
    CFBundleExecutable: 'OpenSuperWhisper',
    DumBridgeVersion: manifest.bridgeVersion,
  };
  for (const [key, value] of Object.entries(expect)) {
    if (plistString(info, key) !== value) throw new Error(`prepare-dictation: built helper has ${key}=${plistString(info, key)}, expected ${value}`);
  }
  // The helper may load only the OS and what its own bundle carries: never a build machine path like
  // Homebrew's, and every @rpath library must be in Contents/Frameworks.
  const executable = join(product, 'Contents', 'MacOS', 'OpenSuperWhisper');
  const linked = output('/usr/bin/otool', ['-L', executable], work).split('\n').slice(1).map((line) => line.trim().split(' (')[0]);
  const foreign = linked.filter((lib) => lib.startsWith('@rpath/')
    ? !existsSync(join(product, 'Contents', 'Frameworks', lib.slice('@rpath/'.length)))
    : !/^(\/System\/Library\/|\/usr\/lib\/)/.test(lib));
  if (foreign.length) throw new Error(`prepare-dictation: the voice helper links outside the OS and its bundle: ${foreign.join(', ')}`);

  await rm(target, { recursive: true, force: true });
  run('/usr/bin/ditto', [product, target], work);

  await cp(join(VENDOR, 'LICENSE'), join(OUTPUT, 'OpenSuperWhisper-LICENSE.txt'));
  const notices = [];
  const licensed = (name, dir) => {
    const file = existsSync(dir) ? readdirSync(dir).find((f) => /^(LICENSE|LICENCE|COPYING)(\.\w+)?$/i.test(f)) : undefined;
    if (!file) throw new Error(`prepare-dictation: no license file found for ${name}`);
    notices.push(`== ${name} ==\n\n${readFileSync(join(dir, file), 'utf8').trim()}\n`);
  };
  for (const sub of manifest.submodules) licensed(sub.path, join(work, sub.path));
  const checkouts = join(work, 'SourcePackages', 'checkouts');
  for (const name of readdirSync(checkouts).sort()) licensed(`Swift package ${name}`, join(checkouts, name));
  await writeFile(join(OUTPUT, 'OpenSuperWhisper-THIRD-PARTY.txt'), notices.join('\n'));

  await rm(work, { recursive: true, force: true });
  await writeFile(join(STAMPS, 'voice.sha256'), digest);
  console.log(`prepare-dictation: OpenSuperWhisper.app (Dum bridge) ready at ${target}`);
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  if (process.platform !== 'darwin') {
    console.log(`prepare-dictation: native helpers build on macOS only; created ${OUTPUT}.`);
    return;
  }
  await mkdir(STAMPS, { recursive: true });
  await buildFocus();
  if (process.arch !== 'arm64') {
    console.log('prepare-dictation: voice needs Apple Silicon; this build ships the keyboard and focus helper only.');
    return;
  }
  await buildVoice();
}

await main();
