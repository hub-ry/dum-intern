#!/usr/bin/env node
// One-time Purdue Brightspace setup for Dum, with automatic sign-in from an authenticator (TOTP) key.
// Ryan runs it himself in a terminal on hub: ~/opt/brightspace-mcp/bin/brightspace setup
//
// It asks for his Purdue username, password and authenticator setup key (hidden), saves the password
// and key in the Secret Service keyring through the pinned package's own saveSecureConfig (the same
// code its wizard uses), then signs in once with no phone and lists his courses as proof.
// Nothing secret is printed, logged, passed on a command line or put in the environment.
//
// It replaces the package's own `setup` wizard, which also offers to register `npx ...@latest` with
// Claude Code and Codex. Installed next to the launcher in ~/opt/brightspace-mcp/bin (see README).

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BIN = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(BIN, "brightspace");
const BUILD = join(BIN, "..", "node_modules", "brightspace-mcp-server", "build");
const load = (rel) => import(pathToFileURL(join(BUILD, rel)).href);
const PURDUE = "https://purdue.brightspace.com";

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const say = (s = "") => process.stdout.write(s + "\n");

class Cancelled extends Error {}
let saved = false;

// The terminal stays in raw mode (no echo) from the first question until sign-in, so nothing typed or
// pasted ahead of a prompt is ever echoed by the terminal itself. cooked() hands it back.
let raw = false;
let typeahead = ""; // keys after an Enter, kept for the next question
function rawMode() {
  if (raw) return;
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  raw = true;
}
function cooked() {
  if (!raw) return;
  process.stdin.setRawMode(false);
  process.stdin.pause();
  raw = false;
}
process.on("exit", cooked);

/** One line from the terminal. Hidden input echoes nothing at all. Ctrl-C cancels. */
function ask(prompt, { hidden = false } = {}) {
  rawMode();
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let value = "";
    let esc = 0; // 1 after ESC, 2 inside a CSI sequence (arrow keys and the like), which is dropped
    let done = false;
    const finish = (err, rest) => {
      done = true;
      typeahead = rest;
      stdin.removeListener("data", onData);
      stdin.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      const chars = [...chunk];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (esc === 1) { esc = ch === "[" ? 2 : 0; continue; }
        if (esc === 2) { if (ch >= "@" && ch <= "~") esc = 0; continue; }
        if (ch === "\x1b") { esc = 1; continue; }
        if (ch === "\r" || ch === "\n") {
          const rest = chars.slice(i + 1).join("");
          return finish(null, ch === "\r" && rest.startsWith("\n") ? rest.slice(1) : rest);
        }
        if (ch === "\x03" || (ch === "\x04" && !value)) return finish(new Cancelled(), "");
        if (ch === "\x7f" || ch === "\b") {
          if (value) {
            value = [...value].slice(0, -1).join("");
            if (!hidden) process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch === "\x15") { // Ctrl-U clears the line
          if (!hidden) process.stdout.write("\b \b".repeat([...value].length));
          value = "";
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        if (!hidden) process.stdout.write(ch);
      }
    };
    if (typeahead) {
      const pending = typeahead;
      typeahead = "";
      onData(pending);
      if (done) return;
    }
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function yes(prompt, def = false) {
  for (;;) {
    const a = (await ask(`${prompt} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (!a) return def;
    if (/^y(es)?$/.test(a)) return true;
    if (/^no?$/.test(a)) return false;
  }
}

function fail(lines) {
  say();
  for (const l of [].concat(lines)) say(yellow(l));
  process.exit(1);
}

/** The pieces of the pinned package this script uses. */
async function loadPackage() {
  if (!existsSync(join(BUILD, "index.js"))) fail(`The pinned brightspace-mcp-server isn't installed in ${join(BIN, "..")}. See "Purdue Brightspace" in Dum's README.`);
  const [totp, secure, store, cred] = await Promise.all([
    load("auth/totp.js"), load("utils/secure-config.js"), load("utils/config-store.js"), load("auth/credential-store.js"),
  ]);
  return { ...totp, ...secure, ...store, ...cred };
}

async function preflight(pkg) {
  if (spawnSync("sh", ["-c", "command -v secret-tool"], { stdio: "ignore" }).status !== 0) {
    fail(["secret-tool is missing. Install it first, then run this again:", "  sudo apt-get install -y --no-install-recommends gnome-keyring libsecret-tools"]);
  }
  try {
    await pkg.assertNativeCredentialStoreAvailable();
  } catch {
    fail([
      "The keyring isn't reachable or isn't unlocked. Check it, then run this again:",
      "  systemctl --user status gnome-keyring-daemon.service",
      "  systemctl --user restart gnome-keyring-daemon.service",
      `Its headless setup is in "Purdue Brightspace" in Dum's README.`,
    ]);
  }
  try {
    const { chromium } = await import(pathToFileURL(join(BIN, "..", "node_modules", "playwright-core", "index.mjs")).href);
    if (!existsSync(chromium.executablePath())) throw new Error("missing");
  } catch {
    fail(["Playwright's Chromium is missing. Install it, then run this again:", `  (cd ${join(BIN, "..")} && ./node_modules/.bin/playwright install chromium)`]);
  }
  const ntp = spawnSync("timedatectl", ["show", "-p", "NTPSynchronized", "--value"], { encoding: "utf8" });
  if (ntp.status === 0 && ntp.stdout.trim() !== "yes") {
    say(yellow("  Warning: hub's clock isn't NTP-synchronized. Authenticator codes depend on the right time."));
  }
}

/** The existing settings for Purdue, if any, minus anything secret. */
function existingPurdue(pkg) {
  try {
    if (!pkg.configStoreExists()) return null;
    const c = pkg.loadConfigStore();
    if (c.baseUrl && new URL(c.baseUrl).origin !== PURDUE) return null;
    const { password: _p, totpUri: _t, ...rest } = c;
    return rest;
  } catch {
    return null;
  }
}

async function askUsername(existing) {
  say(dim("  Your Purdue career account login, like the one you type at Purdue's Microsoft sign-in (\"name\" or \"name@purdue.edu\")."));
  for (;;) {
    const def = existing?.username;
    const raw = (await ask(`  Purdue username${def ? ` [${def}]` : ""}: `)).trim() || def || "";
    if (/^[^\s@]+(@[^\s@]+\.[^\s@]+)?$/.test(raw)) return raw;
    say(yellow("  That doesn't look like a Purdue username or email."));
  }
}

async function askPassword(keep) {
  say(dim("  Your Purdue password. Nothing appears as you type."));
  for (;;) {
    const a = await ask(`  Purdue password${keep ? " (Enter keeps the saved one)" : ""}: `, { hidden: true });
    if (!a && keep) return undefined;
    if (!a) { say(yellow("  The password is required.")); continue; }
    const b = await ask("  Same password again: ", { hidden: true });
    if (a === b) return a;
    say(yellow("  Those didn't match. Try again."));
  }
}

async function askTotp(pkg, username, keep) {
  say(dim("  The authenticator SETUP KEY: the long code Microsoft shows under \"Can't scan image?\", or an otpauth:// link."));
  say(dim("  Not a 6-digit code. Nothing appears as you type or paste."));
  for (;;) {
    const raw = await ask(`  Authenticator setup key${keep ? " (Enter keeps the saved one)" : ""}: `, { hidden: true });
    if (!raw.trim() && keep) return undefined;
    if (!raw.trim()) { say(yellow("  The setup key is required for sign-in without your phone.")); continue; }
    try {
      return pkg.normalizeTotpEnrollment(raw, username);
    } catch {
      say(yellow("  That isn't a valid setup key (base32 letters A-Z and digits 2-7) or otpauth:// link. Try again."));
    }
  }
}

/**
 * Microsoft only adds the authenticator after it sees a working code. Show the current one on request,
 * so the key doesn't also have to go into a phone app. Returns the period of the last code shown.
 */
async function offerCodes(pkg, uri) {
  say();
  say("  Is Microsoft's page asking for a code to finish adding the authenticator?");
  let shown = null;
  while (await yes(shown === null ? "  Show the current 6-digit code here?" : "  Show the code again?", false)) {
    const left = Math.floor(pkg.secondsUntilFreshCode(uri));
    shown = Math.floor(Date.now() / 30_000);
    say(`  Code: ${bold(pkg.generateTotp(uri))}  ${dim(`(good for about ${left} more seconds)`)}`);
  }
  return shown;
}

/** The sign-in, exactly as the server does it later, but with no way to type a code: it must be automatic. */
function signIn() {
  return new Promise((resolve) => {
    const child = spawn(LAUNCHER, ["auth"], { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

const AUTH_HINTS = {
  2: "Another sign-in is already running on hub (maybe one of Dum's). Wait a minute and run this again.",
  4: "Microsoft asked for something the automatic sign-in can't answer. Check that the authenticator app is registered at https://mysignins.microsoft.com/security-info, then run this again.",
  5: "The keyring couldn't be read. Check: systemctl --user status gnome-keyring-daemon.service",
  6: "The network or browser failed during sign-in. Run this again; your settings are saved.",
  7: "Microsoft waited for a phone approval, so the authenticator code didn't take. Check the method at https://mysignins.microsoft.com/security-info and run this again.",
};

/** Ask the MCP server itself for the courses, the way Dum will. */
function listCourses() {
  return new Promise((resolve, reject) => {
    const child = spawn(LAUNCHER, [], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    const waiting = new Map();
    const timer = setTimeout(() => { child.kill(); reject(new Error("The server didn't answer within 3 minutes.\n" + tail(err))); }, 180_000);
    const tail = (s) => s.split("\n").filter(Boolean).slice(-6).join("\n");
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id && waiting.has(m.id)) waiting.get(m.id)(m);
      }
    });
    child.stderr.on("data", (d) => { err = (err + d).slice(-8000); });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    const call = (id, method, params) => new Promise((r) => { waiting.set(id, r); send({ jsonrpc: "2.0", id, method, params }); });
    (async () => {
      await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dum-brightspace-setup", version: "1" } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const r = await call(2, "tools/call", { name: "get_my_courses", arguments: {} });
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      const text = r.result?.content?.[0]?.text ?? "";
      if (r.error || r.result?.isError) return reject(new Error((r.error?.message ?? text) || "get_my_courses failed"));
      resolve(JSON.parse(text));
    })().catch((e) => { clearTimeout(timer); child.kill(); reject(e); });
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("Run this in a terminal on hub (ssh hub, then run it). It asks for hidden input.");

  say();
  say(bold("Purdue Brightspace for Dum: automatic sign-in setup"));
  say();
  say("  This lets Dum read your Brightspace (due dates, grades, assignments, announcements, syllabi) and sign in");
  say("  on its own, with no phone prompts, using your password and an authenticator key kept on hub.");
  say(dim("  Both live in hub's keyring, readable only by your user. Anyone who can run code as ryanhubbart on hub"));
  say(dim("  could sign in as you; the key still stops anyone who only has your password."));
  say();
  say("  First, add an authenticator for Purdue's Microsoft login (skip this if you already have its setup key):");
  say("    1. Open https://mysignins.microsoft.com/security-info and sign in.");
  say("    2. Add sign-in method > Microsoft Authenticator (or \"Authenticator app\") > \"I want to use a different authenticator app\" > Next.");
  say("    3. Under the QR code, click \"Can't scan image?\" and copy the Secret key.");
  say("    4. Leave that page open at the step that asks for a code. This script can show you one.");
  say(dim("  Optional: also add the same key to an authenticator app on your phone as your own backup."));
  say();

  const pkg = await loadPackage();
  await preflight(pkg);

  const existing = existingPurdue(pkg);
  const username = await askUsername(existing);
  const sameUser = existing?.username === username;
  const hasPassword = sameUser && (await pkg.getStoredPassword(PURDUE, username).catch(() => null)) !== null;
  const hasTotp = sameUser && (await pkg.getStoredTotpUri(PURDUE, username).catch(() => null)) !== null;
  say();
  const password = await askPassword(hasPassword);
  say();
  const totpUri = await askTotp(pkg, username, hasTotp);
  const shownPeriod = totpUri ? await offerCodes(pkg, totpUri) : null;

  // The same merge the package's wizard does: Purdue's other saved settings stay.
  await pkg.saveSecureConfig({
    ...existing,
    baseUrl: PURDUE,
    username,
    ...(password !== undefined ? { password } : {}),
    ...(totpUri !== undefined ? { totpUri } : {}),
    headless: true,
    passwordless: false,
    rememberMfa: existing?.rememberMfa ?? false,
  });
  saved = true;
  say();
  say(green(`  Saved. Password and authenticator key are in hub's keyring; other settings in ${pkg.getConfigStorePath()}.`));

  say();
  if (!(await yes("  Ready to test? Finish adding the authenticator on Microsoft's page first. Sign in now?", true))) {
    say(dim("  Run this again (Enter keeps what's saved) or `~/opt/brightspace-mcp/bin/brightspace auth` to test later."));
    return;
  }
  cooked(); // from here on Ctrl-C stops things the usual way
  // Microsoft rejects a code it has just accepted, so don't sign in during the period of a code shown above.
  if (shownPeriod !== null && Math.floor(Date.now() / 30_000) === shownPeriod) {
    const wait = 30_000 - (Date.now() % 30_000) + 1000;
    say(dim(`  Waiting ${Math.ceil(wait / 1000)}s for a fresh code...`));
    await new Promise((r) => setTimeout(r, wait));
  }
  say(dim("  Signing in with a hidden browser. This takes up to a minute or two. You shouldn't need your phone."));
  const code = await signIn();
  if (code !== 0) fail([`Sign-in didn't finish (exit ${code}).`, AUTH_HINTS[code] ?? "Your settings are saved; fix the problem above and run this again (Enter keeps what's saved)."]);

  say();
  say(dim("  Asking the Brightspace server for your courses, the way Dum will..."));
  let courses;
  try {
    courses = await listCourses();
  } catch (e) {
    fail(["Signed in, but listing courses failed:", String(e instanceof Error ? e.message : e)]);
  }
  say();
  say(bold(`  Your courses (${courses.length}):`));
  for (const c of courses) say(`    ${c.name}${c.code ? dim(`  (${c.code})`) : ""}`);
  say();
  say(green("  Done. Dum can use Brightspace from its next message, and signs in again on its own when the session expires."));
}

main().catch((e) => {
  if (e instanceof Cancelled) {
    say(yellow(saved ? "\n  Cancelled. Your settings were already saved; run this again to test." : "\n  Cancelled. Nothing new was saved."));
    process.exit(130);
  }
  // Error messages from the package never carry the secrets themselves.
  fail(String(e instanceof Error ? e.message : e));
});
