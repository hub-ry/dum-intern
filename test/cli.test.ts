import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const loader = fileURLToPath(import.meta.resolve("tsx"));
const cli = fileURLToPath(new URL("../src/cli.tsx", import.meta.url));

test("the real CLI forgets copied notes and offers the C++ systems and graphics tracks", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-cli-`);
  const run = (...args: string[]) => {
    const output = `${dir}/output.txt`;
    const fd = openSync(output, "w");
    try {
      execFileSync(process.execPath, ["--import", loader, cli, ...args], {
        cwd: dir,
        env: { ...process.env, DUM_HOME: dir },
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    return readFileSync(output, "utf8");
  };
  try {
    run("--add", "printing", "--in", "python");
    writeFileSync(`${dir}/skills/copy.md`, readFileSync(`${dir}/skills/printing (python).md`));
    assert.match(run("--forget", "printing", "--in", "python"), /is locked again/);
    assert.match(run("--skills"), /nothing unlocked yet/);
    run("--add", "printing, variables, arithmetic, functions", "--in", "c++");
    const tree = run("--skills");
    assert.match(tree, /c\+\+ · systems/);
    assert.match(tree, /c\+\+ · graphics/);
    assert.match(tree, /coordinate systems.*course open/);
    assert.match(tree, /compilation and linking.*course open/);
    assert.match(tree, /next: course/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
