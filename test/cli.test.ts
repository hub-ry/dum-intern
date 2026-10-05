import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, writeSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const loader = fileURLToPath(import.meta.resolve("tsx"));
const cli = fileURLToPath(new URL("../src/cli.tsx", import.meta.url));
const ANSI = /\x1b\[[0-9;]*m/g;

/** The real CLI, with an isolated tree, no personal context, and `input` as its whole stdin. */
function dum(dir: string, args: string[], input = ""): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--import", loader, cli, ...args], {
    cwd: dir,
    env: { ...process.env, DUM_HOME: `${dir}/home`, DUM_CONTEXT: "off", NO_COLOR: "1", DUM_RESTARTED: "", DUM_TRANSCRIPT: "" },
    input,
    encoding: "utf8",
    timeout: 20000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.replace(ANSI, "") };
}

function project(): string {
  const dir = mkdtempSync(`${tmpdir()}/dum-cli-`);
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("an empty tree still shows every track and where each one starts", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-cli-`);
  try {
    const { code, out } = dum(dir, ["--skills"]);
    assert.equal(code, 0, out);
    assert.match(out, /python · basics.*0\/\d+/);
    assert.match(out, /c\+\+ · graphics/);
    assert.match(out, /○ next: printing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tree is edited from the CLI: added skills show as built, forgotten ones don't, copies included", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-cli-`);
  try {
    dum(dir, ["--add", "printing", "--in", "python"]);
    writeFileSync(`${dir}/home/skills/copy.md`, readFileSync(`${dir}/home/skills/printing (python).md`));
    assert.match(dum(dir, ["--forget", "printing", "--in", "python"]).out, /is locked again/);
    assert.doesNotMatch(dum(dir, ["--skills", "python"]).out, /● printing/);
    dum(dir, ["--add", "printing, variables, arithmetic, functions", "--in", "c++"]);
    const tree = dum(dir, ["--skills", "c++"]).out;
    assert.match(tree, /● printing/);
    assert.match(tree, /● functions/);
    assert.match(tree, /c\+\+ · systems/);
    assert.match(tree, /c\+\+ · graphics/);
    assert.match(dum(dir, ["--skills", "klingon"]).out, /no curated track/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local commands answer at the first prompt, and the end of input ends the session cleanly", () => {
  const dir = project();
  try {
    const { code, out } = dum(dir, ["--plain"], ":tree python\n:remember the parser is mine\n");
    assert.equal(code, 0, out);
    assert.match(out, /what do you want\?/);
    assert.match(out, /your skill tree/);
    assert.match(out, /printing/);
    assert.match(out, /remembered: the parser is mine/);
    assert.match(readFileSync(`${dir}/.dum/memory.md`, "utf8"), /the parser is mine/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mode chosen by flag is saved for the repo, and anti-vibe's tightening is explained once", () => {
  const dir = project();
  try {
    const first = dum(dir, ["-a"], "exit\n");
    assert.equal(first.code, 0, first.out);
    assert.equal(JSON.parse(readFileSync(`${dir}/.dum/preferences.json`, "utf8")).mode, "anti-vibe");
    assert.match(first.out, /dum -u switches this repo back/);
    const again = dum(dir, [], "exit\n");
    assert.match(again.out, /dum-intern\s+\S+\s+anti-vibe/);
    assert.doesNotMatch(again.out, /dum -u switches this repo back/);
    dum(dir, ["-u"], "exit\n");
    assert.equal(JSON.parse(readFileSync(`${dir}/.dum/preferences.json`, "utf8")).mode, "understand");
    assert.match(dum(dir, [], "exit\n").out, /dum-intern\s+\S+\s+understand/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open work from an older session is surfaced, left untouched, and starts no course", () => {
  const dir = project();
  try {
    mkdirSync(`${dir}/.dum`);
    const legacy = JSON.stringify({ todos: [{ concept: "recursion", path: "walk.py", what: "walk the tree", requires: [], before: "# TODO(dum): recursion\n" }] }, null, 2) + "\n";
    writeFileSync(`${dir}/.dum/todos.json`, legacy);
    const { code, out } = dum(dir, [], "exit\n");
    assert.equal(code, 0, out);
    assert.match(out, /recursion in walk\.py/);
    assert.match(out, /what do you want\?/);
    assert.doesNotMatch(out, /course: recursion/);
    assert.equal(readFileSync(`${dir}/.dum/todos.json`, "utf8"), legacy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dum-dev remembers a note, restarts its real launcher and returns to the same project", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-restart-`);
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  const launcher = fileURLToPath(new URL("../bin/dum-dev", import.meta.url));
  const log = `${dir}/launcher.log`;
  const fd = openSync(log, "w");
  const fifo = `${dir}/input`;
  execFileSync("mkfifo", [fifo], { stdio: "ignore" });
  const child = spawn("bash", ["-c", 'exec "$1" --plain --new < "$2"', "_", launcher, fifo], {
    cwd: dir,
    env: { ...process.env, DUM_HOME: `${dir}/skills`, DUM_CONTEXT: "off", NO_COLOR: "1", DUM_RESTARTED: "0" },
    stdio: ["ignore", fd, fd],
  });
  const inputFd = openSync(fifo, "w");
  let output = "";
  const completion = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  let phase = 0;
  // A real launcher restarts a real child process: its log file is the only signal there is.
  const poll = setInterval(() => {
    output = readFileSync(log, "utf8").replace(ANSI, "");
    if (phase === 0 && output.includes("what do you want?")) {
      phase = 1;
      writeSync(inputFd, ":remember continue my guessing game\n");
    }
    if (phase === 1 && output.includes("remembered: continue my guessing game")) {
      phase = 2;
      writeSync(inputFd, ":restart\n");
    }
    if (phase === 2 && output.includes("restored ")) {
      phase = 3;
      writeSync(inputFd, ":memory\n");
    }
    if (phase === 3 && output.includes("# Session memory")) {
      phase = 4;
      writeSync(inputFd, "exit\n");
    }
  }, 25);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 12000);
  try {
    const code = await completion;
    output = readFileSync(log, "utf8");
    assert.equal(code, 0, output);
    assert.equal(phase, 4, output);
    assert.match(output, /continue my guessing game/);
    assert.match(readFileSync(`${dir}/.dum/memory.md`, "utf8"), /guessing game/);
    assert.ok(!readFileSync(`${dir}/.dum/transcript.json`, "utf8").includes('"answer":":restart"'));
  } finally {
    clearTimeout(timeout);
    clearInterval(poll);
    closeSync(fd);
    closeSync(inputFd);
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
