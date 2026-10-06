import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../src/store.ts";
import {
  Outside,
  Workspace,
  createState,
  installExclusive,
  readState,
  sha,
  statePath,
  unifiedDiff,
  writeState,
} from "../src/workspace.ts";

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A committed project with an ignored file, a credential file, dum state and an outside secret. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "dum-ws-"));
  const away = mkdtempSync(join(tmpdir(), "dum-away-"));
  git(root, "init", "-q");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/main.py"), "def main():\n    return 1\n");
  writeFileSync(join(root, ".gitignore"), "build/\n");
  writeFileSync(join(root, ".env"), "TOKEN=hunter2\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "start");
  mkdirSync(join(root, "build"));
  writeFileSync(join(root, "build/out.py"), "ignored = True\n");
  mkdirSync(join(root, ".dum"));
  writeFileSync(join(root, ".dum/memory.md"), "remembered\n");
  writeFileSync(join(away, "secret.txt"), "outside secret\n");
  writeFileSync(join(away, "notes.txt"), "my outside notes\n");
  return { root, away, done: () => { rmSync(root, { recursive: true, force: true }); rmSync(away, { recursive: true, force: true }); } };
}

async function answer(store: Store, reply: string) {
  for (let i = 0; i < 50 && store.getSnapshot().prompt?.type !== "question"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.getSnapshot().prompt?.type, "question");
  store.submit(reply);
}

test("list shows tracked and untracked files but never ignored, credential, internal or escaping paths", () => {
  const p = project();
  try {
    writeFileSync(join(p.root, "src/new.py"), "x = 1\n");
    writeFileSync(join(p.root, "id_ed25519"), "key\n");
    symlinkSync(join(p.away, "secret.txt"), join(p.root, "src/leak.txt"));
    symlinkSync(join(p.root, ".env"), join(p.root, "src/env-link"));
    const files = new Workspace(p.root).list();
    assert.ok(files.includes("src/main.py"));
    assert.ok(files.includes("src/new.py"), "untracked files are listed");
    for (const hidden of [".env", "build/out.py", ".dum/memory.md", "id_ed25519", "src/leak.txt", "src/env-link"]) {
      assert.ok(!files.includes(hidden), `${hidden} must not be listed`);
    }
  } finally { p.done(); }
});

test("reads refuse outside, symlinked, credential, internal and ignored paths and bound excerpts", () => {
  const p = project();
  try {
    const ws = new Workspace(p.root);
    assert.throws(() => ws.read("../x"), Outside);
    assert.throws(() => ws.read(join(p.away, "secret.txt")), Outside);
    symlinkSync(join(p.away, "secret.txt"), join(p.root, "src/leak.txt"));
    assert.throws(() => ws.read("src/leak.txt"), /leaves/);
    symlinkSync(p.away, join(p.root, "src/linked"));
    assert.throws(() => ws.read("src/linked/secret.txt"));
    symlinkSync(join(p.root, ".env"), join(p.root, "src/env-link"));
    assert.throws(() => ws.read("src/env-link"), /credentials/);
    assert.throws(() => ws.read(".env"), /credentials/);
    assert.throws(() => ws.read(".dum/memory.md"), /internal/);
    assert.throws(() => ws.read(".git/config"), /internal/);
    assert.throws(() => ws.read("build/out.py"), /ignored/);

    const body = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    writeFileSync(join(p.root, "src/long.py"), body);
    const art = ws.read("src/long.py", 10, 500);
    assert.equal(art.from, 10);
    assert.equal(art.text.split("\n").length, 120, "excerpts stop at 120 lines");
    assert.equal(art.text.split("\n")[0], "line 10");
    assert.equal(art.sha, sha(body), "the SHA covers the whole file");
    writeFileSync(join(p.root, "src/big.py"), "x".repeat(300 * 1024));
    assert.throws(() => ws.read("src/big.py"), /KiB/);
  } finally { p.done(); }
});

test("outside files need your explicit yes, dum can't ask for them, and credentials are refused even approved", async () => {
  const p = project();
  try {
    const store = new Store("demo", "understand", p.root);
    const ws = new Workspace(p.root, store);
    await assert.rejects(ws.inspect(join(p.away, "notes.txt"), "dum"), /only they can share it/);
    assert.equal(store.getSnapshot().prompt, null, "dum's request never prompts you to share");

    const refused = ws.inspect(join(p.away, "notes.txt"));
    await answer(store, "n");
    await assert.rejects(refused, /not shared/);

    const shared = ws.inspect(join(p.away, "notes.txt"));
    await answer(store, "y");
    assert.match(await shared, /my outside notes/);
    const entry = store.getSnapshot().transcript.at(-1);
    assert.equal(entry?.kind, "excerpt");

    mkdirSync(join(p.away, ".ssh"));
    writeFileSync(join(p.away, ".ssh/config"), "Host x\n");
    await assert.rejects(ws.inspect(join(p.away, ".ssh/config")), /credentials/);
    writeFileSync(join(p.away, "server.pem"), "-----BEGIN-----\n");
    await assert.rejects(ws.shareExternal(join(p.away, "server.pem")), /credentials/);
    await assert.rejects(ws.shareExternal("/proc/self/environ"), /system files/);
    for (const file of [".terraform.d/credentials.tfrc.json", ".config/github-copilot/hosts.json", ".vault-token"]) {
      mkdirSync(dirname(join(p.away, file)), { recursive: true });
      writeFileSync(join(p.away, file), "token\n");
      await assert.rejects(ws.shareExternal(join(p.away, file)), /credentials/);
    }
    // dum's own home holds your tree and its private edit link: refused before you're even asked.
    const was = process.env.DUM_HOME;
    process.env.DUM_HOME = join(p.away, "dum-home");
    try {
      mkdirSync(join(p.away, "dum-home"));
      writeFileSync(join(p.away, "dum-home/web.json"), "{\"edit\":\"https://example.com/private\"}\n");
      await assert.rejects(ws.shareExternal(join(p.away, "dum-home/web.json")), /dum's own private state/);
      assert.equal(store.getSnapshot().prompt, null);
    } finally {
      if (was === undefined) delete process.env.DUM_HOME;
      else process.env.DUM_HOME = was;
    }
    await assert.rejects(new Workspace(p.root).shareExternal(join(p.away, "notes.txt")), /approval/);
  } finally { p.done(); }
});

test("a proposal never touches the file, refuses a stale baseline and saves a patch git can apply", () => {
  const p = project();
  try {
    const store = new Store("demo", "understand", p.root);
    const ws = new Workspace(p.root, store);
    const before = ws.file("src/main.py");
    const next = "def main():\n    return 2\n\nprint(main())";
    // You save in your editor after dum read the file: dum's proposal is refused, your bytes stay.
    writeFileSync(join(p.root, "src/main.py"), "def main():\n    return 'yours'\n");
    assert.throws(() => ws.propose("src/main.py", before.sha, next), /changed since dum read it/);
    assert.equal(readFileSync(join(p.root, "src/main.py"), "utf8"), "def main():\n    return 'yours'\n");
    assert.equal(existsSync(join(p.root, ".dum/proposals")), false);

    // Another name for a file - a linked directory or a linked file, even inside the project -
    // never stands in for its real path, which is what decides whether AI may change it.
    symlinkSync(join(p.root, "src"), join(p.root, "include"));
    symlinkSync("main.py", join(p.root, "src/alias.py"));
    const aliased = ws.file("src/main.py");
    assert.throws(() => ws.propose("include/main.py", aliased.sha, next));
    assert.throws(() => ws.propose("src/alias.py", aliased.sha, next));
    assert.throws(() => ws.propose("include/fresh.py", null, next));
    assert.equal(readFileSync(join(p.root, "src/main.py"), "utf8"), "def main():\n    return 'yours'\n");
    assert.equal(existsSync(join(p.root, "src/fresh.py")), false);
    assert.equal(existsSync(join(p.root, ".dum/proposals")), false);

    const current = ws.file("src/main.py");
    assert.throws(() => ws.propose("src/main.py", null, next), /already exists/);
    assert.throws(() => ws.propose("src/main.py", current.sha, current.text), /doesn't change/);
    const { diff, artifact } = ws.propose("src/main.py", current.sha, next);
    assert.match(diff, /^-    return 'yours'$/m);
    assert.match(diff, /^\+print\(main\(\)\)$/m);
    assert.equal(readFileSync(join(p.root, "src/main.py"), "utf8"), "def main():\n    return 'yours'\n", "proposals are never applied");
    assert.match(artifact, /^\.dum\/proposals\/.+\.patch$/);
    const last = store.getSnapshot().transcript.at(-1);
    assert.ok(last?.kind === "diff" && last.outcome === "proposed" && last.artifact === artifact);

    // The saved artifact is a real patch: applying it yourself gives exactly the proposal.
    git(p.root, "apply", artifact);
    assert.equal(readFileSync(join(p.root, "src/main.py"), "utf8"), next);
    assert.throws(() => ws.propose(".env", null, "X=1\n"), /credentials/);
    assert.throws(() => ws.propose("../escape.py", null, "x"), Outside);
  } finally { p.done(); }
});

test("unified diffs round-trip through git apply, including a missing final newline", () => {
  const p = project();
  try {
    const cases: [string, string][] = [
      ["a\nb\nc\n", "a\nB\nc\n"],
      ["one\ntwo", "one\ntwo\n"],
      ["x\n".repeat(30), "y\n" + "x\n".repeat(28) + "z\n"],
      ["", "fresh\n"],
    ];
    cases.forEach(([before, after], i) => {
      const path = `src/case${i}.txt`;
      writeFileSync(join(p.root, path), before);
      const patch = unifiedDiff(path, before, after);
      writeFileSync(join(p.root, "p.patch"), patch);
      git(p.root, "apply", "p.patch");
      assert.equal(readFileSync(join(p.root, path), "utf8"), after, `case ${i}`);
    });
  } finally { p.done(); }
});

test("create only makes new files, never through a symlinked directory, and your save wins a race", () => {
  const p = project();
  try {
    const store = new Store("demo", "understand", p.root);
    const ws = new Workspace(p.root, store);
    ws.create("src/util/helpers.py", "def helper():\n    pass\n");
    assert.equal(readFileSync(join(p.root, "src/util/helpers.py"), "utf8"), "def helper():\n    pass\n");
    assert.equal(store.getSnapshot().transcript.at(-1)?.kind, "diff");

    assert.throws(() => ws.create("src/main.py", "overwrite"), /already exists/);
    assert.equal(readFileSync(join(p.root, "src/main.py"), "utf8"), "def main():\n    return 1\n");

    symlinkSync(p.away, join(p.root, "src/out"));
    assert.throws(() => ws.create("src/out/planted.py", "x"), /leaves|symlink/);
    assert.equal(existsSync(join(p.away, "planted.py")), false);
    mkdirSync(join(p.root, "lib"));
    symlinkSync(join(p.root, "lib"), join(p.root, "src/inner"));
    assert.throws(() => ws.create("src/inner/x.py", "x"));
    assert.equal(existsSync(join(p.root, "lib/x.py")), false);

    // Your editor saves the same new file after dum prepared its bytes but before it installs them.
    const dir = join(p.root, "src");
    const made = installExclusive(dir, "race.py", "dum's version\n", 0o666, () => writeFileSync(join(dir, "race.py"), "your version\n"));
    assert.equal(made, false);
    assert.equal(readFileSync(join(dir, "race.py"), "utf8"), "your version\n");
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".dum-")), [], "no temp files left behind");
  } finally { p.done(); }
});

test("dum's state files refuse symlinks anywhere, write atomically and create exclusively", () => {
  const p = project();
  try {
    assert.equal(readState(p.root, "nothing.json"), null);
    writeState(p.root, "preferences.json", "{\"mode\":\"understand\"}");
    assert.equal(readState(p.root, "preferences.json"), "{\"mode\":\"understand\"}");
    assert.equal(createState(p.root, "courses/a.py", "scratch\n"), true);
    assert.equal(createState(p.root, "courses/a.py", "replacement\n"), false);
    assert.equal(readState(p.root, "courses/a.py"), "scratch\n");

    // A planted symlink in place of state would feed an outside secret into dum's context.
    symlinkSync(join(p.away, "secret.txt"), join(p.root, ".dum/memory-link.md"));
    assert.throws(() => readState(p.root, "memory-link.md"), /symlink/);
    assert.throws(() => writeState(p.root, "memory-link.md", "x"), /symlink/);
    assert.equal(readFileSync(join(p.away, "secret.txt"), "utf8"), "outside secret\n");
    symlinkSync(p.away, join(p.root, ".dum/practice"));
    assert.throws(() => statePath(p.root, "practice/tasks.json"), /symlink/);
    assert.throws(() => readState(p.root, "practice/secret.txt"), /symlink/);
    assert.throws(() => statePath(p.root, "../escape"), /state file name/);

    const other = mkdtempSync(join(tmpdir(), "dum-state-"));
    try {
      symlinkSync(p.away, join(other, ".dum"));
      assert.throws(() => writeState(other, "transcript.json", "[]"), /symlink/);
      assert.equal(existsSync(join(p.away, "transcript.json")), false);
    } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { p.done(); }
});

test("run is a fixed read-only Git catalog: anything else is refused and nothing executes", async () => {
  const p = project();
  try {
    const store = new Store("demo", "understand", p.root);
    const ws = new Workspace(p.root, store);
    for (const cmd of ["npm test", "make", "python3 main.py", "sh -c id", "git status; touch pwned", "git push", "git -c core.pager=touch status", "rm -rf ."]) {
      await assert.rejects(ws.run(cmd), /can't run/, cmd);
    }
    assert.equal(existsSync(join(p.root, "pwned")), false);

    writeFileSync(join(p.root, ".env"), "TOKEN=changed\n");
    writeFileSync(join(p.root, "src/main.py"), "def main():\n    return 3\n");
    const status = await ws.run("git status");
    assert.equal(status.code, 0);
    assert.match(status.output, /src\/main\.py/);
    assert.doesNotMatch(status.output, /\.env/);
    const diff = await ws.run("diff --output=written.txt");
    assert.equal(existsSync(join(p.root, "written.txt")), false, "diff options can't be smuggled in");
    assert.equal(diff.code, 0);
    const log = await ws.run("log 5");
    assert.match(log.output, /start/);
    assert.equal(store.getSnapshot().transcript.at(-1)?.kind, "result");
  } finally { p.done(); }
});

test("changes show tracked and untracked work without secrets and never run configured Git programs", async () => {
  const p = project();
  try {
    const marker = join(p.away, "ran");
    const script = join(p.away, "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat "$1" 2>/dev/null\n`, { mode: 0o755 });
    git(p.root, "config", "core.fsmonitor", script);
    git(p.root, "config", "diff.external", script);
    git(p.root, "config", "diff.evil.textconv", script);
    writeFileSync(join(p.root, ".gitattributes"), "*.py diff=evil\n");

    writeFileSync(join(p.root, "src/main.py"), "def main():\n    return 42\n");
    writeFileSync(join(p.root, "src/added.py"), "print('new')\n");
    writeFileSync(join(p.root, ".env"), "TOKEN=leaked\n");
    writeFileSync(join(p.root, "build/out.py"), "ignored = False\n");
    writeFileSync(join(p.root, ".dum/memory.md"), "changed\n");
    const store = new Store("demo", "understand", p.root);
    const shown = await new Workspace(p.root, store).changes();
    assert.match(shown, /^\+    return 42$/m);
    assert.match(shown, /src\/added\.py/);
    assert.match(shown, /^\+print\('new'\)$/m);
    assert.doesNotMatch(shown, /leaked|TOKEN|ignored = False|\.dum/);
    assert.equal(existsSync(marker), false, "fsmonitor, external diff and textconv never ran");
    await new Workspace(p.root).run("status");
    assert.equal(existsSync(marker), false);
    const yours = store.getSnapshot().transcript.at(-1);
    assert.ok(yours?.kind === "excerpt" && yours.by === "you");
    await new Workspace(p.root, store).changes("src/main.py", "dum");
    const dums = store.getSnapshot().transcript.at(-1);
    assert.ok(dums?.kind === "excerpt" && dums.by === "dum", "dum's own look at the changes is shown as dum's");

    await assert.rejects(new Workspace(p.root).changes(".env"), /credentials/);
    const many = Array.from({ length: 400 }, (_, i) => `n${i}`).join("\n") + "\n";
    writeFileSync(join(p.root, "src/many.py"), many);
    assert.ok((await new Workspace(p.root).changes("src/many.py")).split("\n").length <= 121, "diffs are bounded");
  } finally { p.done(); }
});

test("status and changes never run a clean or process filter that .gitattributes selects", async () => {
  const p = project();
  try {
    writeFileSync(join(p.root, "notes.txt"), "first\n");
    git(p.root, "add", "notes.txt");
    git(p.root, "commit", "-q", "--no-verify", "-m", "notes");
    const cleaned = join(p.away, "clean-ran");
    const processed = join(p.away, "process-ran");
    writeFileSync(join(p.away, "clean.sh"), `#!/bin/sh\ntouch ${cleaned}\ncat\n`, { mode: 0o755 });
    writeFileSync(join(p.away, "process.sh"), `#!/bin/sh\ntouch ${processed}\n`, { mode: 0o755 });
    git(p.root, "config", "filter.evil.clean", join(p.away, "clean.sh"));
    git(p.root, "config", "filter.evil.required", "true");
    git(p.root, "config", "filter.Long.name.process", join(p.away, "process.sh"));
    writeFileSync(join(p.root, ".gitattributes"), "*.py filter=evil\n*.txt filter=Long.name\n");
    writeFileSync(join(p.root, "src/main.py"), "def main():\n    return 42\n");
    writeFileSync(join(p.root, "notes.txt"), "second\n");

    const ws = new Workspace(p.root);
    const shown = await ws.changes();
    assert.match(shown, /^\+    return 42$/m);
    assert.match(shown, /^\+second$/m);
    assert.match((await ws.run("status")).output, /notes\.txt/);
    assert.match((await ws.run("diff --staged")).output, /nothing staged/);
    assert.equal(existsSync(cleaned), false, "the clean filter never ran");
    assert.equal(existsSync(processed), false, "the process filter never ran");

    // Plain Git runs each for its own file, so the fixture really selects them. The stub process
    // filter speaks no protocol; whether Git then fails or carries on depends on its version, so
    // only that the filter ran is asserted.
    git(p.root, "diff", "HEAD", "--", "src/main.py");
    assert.ok(existsSync(cleaned));
    try { git(p.root, "diff", "HEAD", "--", "notes.txt"); } catch { /* a stub that speaks no protocol may fail it */ }
    assert.ok(existsSync(processed));
  } finally { p.done(); }
});
