// Bundled OpenSuperWhisper helper for macOS arm64 dictation.
//
// OpenSuperWhisper (OSW) is a native Apple Silicon app that records audio using
// the user's configured global shortcut and inserts transcribed text into the
// focused application via macOS Accessibility APIs — including dum's composer
// panel. There is no programmatic recording API: the user triggers dictation
// themselves with the configured shortcut.
//
// This module exposes status (supported/available/message/version) and an
// open() action that launches OSW so the user can complete onboarding (model
// download, microphone permission, shortcut setup).
//
// Recording data disclosure: OSW may retain audio recordings locally in its
// own storage per its own in-app settings. Dum has no access to those recordings
// and cannot control OSW's retention behavior. Users should review OSW's settings.
//
// All OS interactions are injected through DictationPorts for isolated testing.

import { existsSync, realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

/** Pinned release installed by tools/prepare-dictation.mjs. */
export const OSW_VERSION = "0.1.0";
export const OSW_BUNDLE_ID = "com.starmel.OpenSuperWhisper";

export type DictationStatus = {
  /** Platform is macOS arm64 — the only supported target for OSW bundling. */
  supported: boolean;
  /** Helper app is present at the expected resources path with a valid bundle structure. */
  available: boolean;
  /**
   * Human-readable status for display in settings.
   * When supported and available, explains how to use native shortcut dictation.
   * When unsupported or unavailable, explains why and what to do.
   */
  message: string;
  /**
   * CFBundleShortVersionString from the app's Info.plist, or "" if unreadable.
   * Will equal OSW_VERSION ("0.1.0") when the pinned build is present.
   */
  version: string;
};

export type DictationPorts = {
  platform: string;
  arch: string;
  /** macOS product version, from Electron's process.getSystemVersion(). */
  systemVersion: string;
  /**
   * Returns the absolute path to the Electron app's Resources directory.
   * In production: () => process.resourcesPath
   * In tests: () => a temp directory containing a fake bundle
   */
  resourcesPath(): string;
  /**
   * Launches the helper app at the given validated absolute path.
   * Receives only the pre-validated OpenSuperWhisper.app path — never arbitrary input.
   *
   * Main awaits /usr/bin/open with a finite timeout and reports launch failures.
   *
   * '/usr/bin/open' is used explicitly (never a shell or PATH lookup) so the
   * only process launched is macOS's Open command with the verified bundle path.
   */
  spawnOpen(appPath: string): void | Promise<void>;
};

const BUNDLE_EXEC_REL = join("Contents", "MacOS", "OpenSuperWhisper");
const BUNDLE_PLIST_REL = join("Contents", "Info.plist");
const VERSION_RE = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/;

/** Extract CFBundleShortVersionString from Info.plist XML. Returns "" on any failure. */
function readPlistVersion(plistPath: string): string {
  try {
    const xml = readFileSync(plistPath, "utf8");
    return VERSION_RE.exec(xml)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

export class DictationHelper {
  constructor(private readonly o: DictationPorts) {}

  /** Absolute path where the bundled app is expected inside Electron's resources directory. */
  helperPath(): string {
    return join(this.o.resourcesPath(), "OpenSuperWhisper.app");
  }

  /**
   * Validate the bundle at helperPath():
   * - Resolved path stays inside resourcesPath() (no symlink/traversal escape)
   * - Exists as a directory
   * - Contains Contents/MacOS/OpenSuperWhisper (executable present)
   * - Contains Contents/Info.plist (metadata present)
   * Returns { path, version } on success, null otherwise.
   * Does not verify code signature (requires Security.framework / codesign CLI).
   */
  private validateBundle(): { path: string; version: string } | null {
    // Capture once so a volatile resourcesPath() stays consistent within one check.
    const resourcesDir = this.o.resourcesPath();
    const appPath = join(resourcesDir, "OpenSuperWhisper.app");
    if (!isAbsolute(appPath)) return null;
    // Must be a real directory before the symlink check.
    try {
      if (!existsSync(appPath) || !statSync(appPath).isDirectory()) return null;
    } catch {
      return null;
    }
    // Guard: symlink-resolved real path must stay inside the resources directory.
    // path.resolve() does not follow symlinks; realpathSync() does.
    try {
      const realApp  = realpathSync(appPath);
      const realBase = realpathSync(resourcesDir);
      if (!realApp.startsWith(realBase + sep) && realApp !== realBase) return null;
    } catch {
      return null;
    }
    const execPath  = join(appPath, BUNDLE_EXEC_REL);
    const plistPath = join(appPath, BUNDLE_PLIST_REL);
    if (!existsSync(execPath) || !existsSync(plistPath)) return null;
    return { path: appPath, version: readPlistVersion(plistPath) };
  }

  /**
   * Current dictation helper status. Safe to call on any platform.
   * Always returns a fully truthful status; never claims features work if they don't.
   */
  status(): DictationStatus {
    const { platform, arch } = this.o;
    if (platform !== "darwin" || arch !== "arm64") {
      return {
        supported: false,
        available: false,
        message:
          `Voice dictation requires macOS on Apple Silicon. ` +
          `This ${platform}/${arch} build does not include the OpenSuperWhisper helper.`,
        version: "",
      };
    }
    if (Number.parseInt(this.o.systemVersion, 10) < 14 || !/^\d+\./.test(this.o.systemVersion)) {
      return {
        supported: false,
        available: false,
        message: "Voice dictation requires macOS 14 or later on Apple Silicon.",
        version: "",
      };
    }
    const bundle = this.validateBundle();
    if (!bundle) {
      return {
        supported: true,
        available: false,
        message:
          "OpenSuperWhisper helper is missing from this build. " +
          "Re-download dum or run `node tools/prepare-dictation.mjs` and rebuild.",
        version: "",
      };
    }
    return {
      supported: true,
      available: true,
      message:
        `OpenSuperWhisper ${bundle.version} is ready. ` +
        `Use its global shortcut to speak into any dum text field — ` +
        `dictated text will fill the input without sending. ` +
        `Note: OpenSuperWhisper may store recordings locally per its own settings.`,
      version: bundle.version,
    };
  }

  /**
   * Open the OpenSuperWhisper helper app for onboarding.
   * The user sets up the model, grants microphone permission, and configures
   * the global shortcut. After that, speaking into dum's focused composer
   * fills the text input — dum never auto-sends dictated text.
   *
   * Throws if the platform is unsupported or the bundle is missing/invalid.
   * Never launches any process other than the validated bundle path.
   */
  async open(): Promise<void> {
    const status = this.status();
    if (!status.supported) throw new Error(status.message);
    const bundle = this.validateBundle();
    if (!bundle) {
      throw new Error(
        "OpenSuperWhisper helper is not available or could not be verified. " +
        "Re-download dum to restore the bundled helper."
      );
    }
    await this.o.spawnOpen(bundle.path);
  }
}
