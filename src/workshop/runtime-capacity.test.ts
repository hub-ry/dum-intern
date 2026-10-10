// Behavioral regression tests for the state file's capacity reserve: a valid result the file has
// no room for ends its job as failed instead of leaving it running, the next goal's job still
// progresses, and nothing already kept is lost. The ceiling is lowered through the store's private
// field on an open store, so the real reserve arithmetic runs against a small state rather than a
// 256 MB fixture; the publisher is replaced on the runner instance with one that hands back a
// prepared, valid result, so the store's real completion path is what refuses it.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JOB_CLAIM_RESERVE_BYTES, JOB_FAILURE_RESERVE_BYTES, WorkshopCapacityError, WorkshopError, WorkshopRunner, WorkshopStore } from "./runtime.ts";
import type { BuildInput, BuildOptions, BuildResult, Goal, Job } from "./runtime.ts";
import { MAX_ERROR_LENGTH } from "./validate.ts";

const homes: string[] = [];
const open: WorkshopStore[] = [];
const runners: WorkshopRunner[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dum-workshop-capacity-"));
  homes.push(home);
  return home;
}

function openStore(home: string): WorkshopStore {
  const store = new WorkshopStore(home);
  open.push(store);
  return store;
}

after(async () => {
  for (const runner of runners) await runner.stop();
  for (const store of open) store.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

// -- private seams ----------------------------------------------------------------------------

type StoreSeam = { stateCapacityBytes: number };
type RunnerSeam = { build: (input: BuildInput, options: BuildOptions) => Promise<unknown> };

function setCapacity(store: WorkshopStore, bytes: number): void {
  (store as unknown as StoreSeam).stateCapacityBytes = bytes;
}

function setBuild(runner: WorkshopRunner, build: RunnerSeam["build"]): void {
  (runner as unknown as RunnerSeam).build = build;
}

function stateBytes(store: WorkshopStore): number {
  return statSync(join(store.home, "workshop.json")).size;
}

// -- fixtures ---------------------------------------------------------------------------------

function goalWithTeaching(store: WorkshopStore, title: string): Goal {
  const goal = store.createGoal({ title, ambition: "Explain loops and conditions with a small program." });
  store.teach(goal.id, { concept: "loops", text: `A for loop repeats a body while its condition holds (${title}).` });
  return goal;
}

function resultFor(job: Job, outputBytes = 0): BuildResult {
  const teachingIds = job.snapshot.teachings.map((t) => t.id);
  assert.ok(teachingIds.length > 0, "fixture needs a job with teachings");
  return {
    title: `Creation for ${job.snapshot.goal.title}`,
    panels: Array.from({ length: 3 }, (_, i) => ({ caption: `Panel ${i + 1}`, code: `console.log(${i})`, teachingIds })),
    verification: { command: "node demo.js", output: outputBytes > 0 ? "x".repeat(outputBytes) : "0\n1\n2" },
    supportingMachinery: ["demo.js"],
  };
}

const BIG_OUTPUT = 200 * 1024;
const SLACK = 16 * 1024;
/** The costliest error a job can fail with: every character is a control character JSON spends six bytes on. */
const WORST_ERROR = "\u0000".repeat(MAX_ERROR_LENGTH);

/** A finished creation on its own goal, kept as the history later writes must leave intact. */
function readyPrior(store: WorkshopStore): { job: Job; result: BuildResult } {
  const goal = goalWithTeaching(store, "Prior");
  const queued = store.enqueue(goal.id);
  const running = store.claimNextJob();
  assert.ok(running && running.id === queued.id);
  const result = resultFor(running);
  const job = store.completeJob(running.id, result);
  assert.equal(job.state, "ready");
  return { job, result };
}

/** Two goals with one queued job each, oldest first, and a ceiling that fits both failures but not a big result. */
function twoQueuedGoals(store: WorkshopStore): { first: Job; second: Job } {
  const a = goalWithTeaching(store, "Goal A");
  const b = goalWithTeaching(store, "Goal B");
  const first = store.enqueue(a.id);
  const second = store.enqueue(b.id);
  assert.ok(first.createdAt <= second.createdAt);
  setCapacity(store, stateBytes(store) + 2 * JOB_FAILURE_RESERVE_BYTES + JOB_CLAIM_RESERVE_BYTES + SLACK);
  return { first, second };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function isCapacity(err: unknown): boolean {
  return err instanceof WorkshopCapacityError && err instanceof WorkshopError && err.status === 409;
}

// ---------------------------------------------------------------------------------------------

test("at the exact ordinary ceiling a small teaching is refused, while every active job's claim and worst-case failure still fit and survive reopen", () => {
  const home = freshHome();
  const store = openStore(home);
  const prior = readyPrior(store);
  const a = goalWithTeaching(store, "Goal A");
  const b = goalWithTeaching(store, "Goal B");
  const first = store.enqueue(a.id);
  const second = store.enqueue(b.id);
  const teachingsA = store.listTeachings(a.id);
  const bytesBefore = stateBytes(store);
  // The ceiling sits exactly at the ordinary budget: the state as written plus two failures and one claim.
  const ceiling = bytesBefore + 2 * JOB_FAILURE_RESERVE_BYTES + JOB_CLAIM_RESERVE_BYTES;
  setCapacity(store, ceiling);

  // Even a one-character teaching would eat into the reserve: a capacity 409, rolled back in memory and on disk.
  assert.throws(() => store.teach(a.id, { concept: "loops", text: "y" }), isCapacity);
  assert.deepEqual(store.listTeachings(a.id), teachingsA);
  assert.equal(stateBytes(store), bytesBefore);

  // The reserve is for the jobs: the first claim, then its failure with the costliest error there is.
  const running = store.claimNextJob();
  assert.ok(running && running.id === first.id);
  const failed = store.failJob(running.id, new Error(WORST_ERROR));
  assert.equal(failed.state, "failed");
  assert.ok(failed.error !== undefined && failed.error.length <= MAX_ERROR_LENGTH);
  assert.match(failed.error, /^Error: \u0000+…$/);
  assert.ok(stateBytes(store) <= ceiling);

  // The other active job is unaffected by that maximal failure: its claim and the same failure fit too.
  const other = store.claimNextJob();
  assert.ok(other && other.id === second.id);
  const failedToo = store.failJob(other.id, new Error(WORST_ERROR));
  assert.equal(failedToo.state, "failed");
  assert.equal(failedToo.error, failed.error);
  assert.ok(stateBytes(store) <= ceiling);

  // With no active job left there is no reserve, and the teaching refused earlier goes in.
  store.teach(a.id, { concept: "loops", text: "y" });
  assert.equal(store.listTeachings(a.id).length, teachingsA.length + 1);
  assert.ok(stateBytes(store) <= ceiling);
  store.close();

  // A fresh process reads the control characters back exactly, and everything written before them.
  const reopened = openStore(home);
  assert.equal(reopened.getJob(first.id).state, "failed");
  assert.equal(reopened.getJob(first.id).error, failed.error);
  assert.equal(reopened.getJob(second.id).error, failedToo.error);
  assert.deepEqual(reopened.getJob(first.id).snapshot, first.snapshot);
  assert.deepEqual(reopened.getJob(second.id).snapshot, second.snapshot);
  assert.equal(reopened.getJob(prior.job.id).state, "ready");
  assert.deepEqual(reopened.getJob(prior.job.id).result, prior.result);
  assert.equal(reopened.getJob(prior.job.id).artifactId, prior.job.artifactId);
  assert.deepEqual(reopened.listTeachings(a.id).slice(0, teachingsA.length), teachingsA);
  assert.equal(reopened.listTeachings(a.id).length, teachingsA.length + 1);
  assert.equal(reopened.claimNextJob(), null, "nothing is left running or queued");
  reopened.close();
});

test("completeJob refuses a valid result the state file has no room for, leaves the job running, and failJob then fits", () => {
  const store = openStore(freshHome());
  const { first } = twoQueuedGoals(store);
  const running = store.claimNextJob();
  assert.ok(running);
  assert.equal(running.id, first.id);
  const onDisk = stateBytes(store);

  const err = (() => {
    try {
      store.completeJob(running.id, resultFor(running, BIG_OUTPUT));
    } catch (e) {
      return e;
    }
    return null;
  })();
  assert.ok(isCapacity(err), "a capacity 409, not a 400 or a plain conflict");
  assert.match((err as Error).message, /existing history is unchanged/);
  assert.equal(store.getJob(running.id).state, "running");
  assert.equal(store.getJob(running.id).result, undefined);
  assert.equal(stateBytes(store), onDisk);

  const failed = store.failJob(running.id, err);
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /capacity/);
  store.close();
});

test("the runner fails a job terminally when its valid result exceeds capacity, the next goal's job becomes ready, and history survives reopen", async () => {
  const home = freshHome();
  const store = openStore(home);
  const prior = readyPrior(store);
  const { first, second } = twoQueuedGoals(store);
  const teachingsA = store.listTeachings(first.goalId);
  const teachingsB = store.listTeachings(second.goalId);
  const errors: unknown[] = [];
  const runner = new WorkshopRunner(store, { artifactRoot: join(store.home, "artifacts"), onError: (e) => errors.push(e) });
  runners.push(runner);
  setBuild(runner, async (input) => (input.id === first.id ? resultFor(first, BIG_OUTPUT) : resultFor(second)));

  runner.start();
  await waitFor(() => store.getJob(first.id).state === "failed", "the oversized job to fail");
  await waitFor(() => store.getJob(second.id).state === "ready", "the next goal's job to become ready");
  await runner.stop();

  const failed = store.getJob(first.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /capacity/);
  assert.equal(failed.result, undefined);
  assert.ok(failed.finishedAt);
  assert.deepEqual(store.getJob(second.id).result, resultFor(second));
  assert.deepEqual(errors, [], "the capacity failure is handled, never reported as an operational error");
  const events = store.getGlobalContext().events.map((e) => e.type);
  assert.ok(events.includes("buildFailed") && events.includes("buildReady"));
  store.close();

  // A fresh process with the normal ceiling reads everything the first one kept.
  const reopened = openStore(home);
  assert.equal(reopened.getJob(first.id).state, "failed");
  assert.match(reopened.getJob(first.id).error ?? "", /capacity/);
  assert.deepEqual(reopened.getJob(first.id).snapshot, first.snapshot);
  assert.deepEqual(reopened.getJob(second.id).result, resultFor(second));
  assert.equal(reopened.getJob(prior.job.id).state, "ready");
  assert.deepEqual(reopened.getJob(prior.job.id).result, prior.result);
  assert.equal(reopened.getJob(prior.job.id).artifactId, prior.job.artifactId);
  assert.deepEqual(reopened.listTeachings(first.goalId), teachingsA);
  assert.deepEqual(reopened.listTeachings(second.goalId), teachingsB);
  assert.equal(reopened.claimNextJob(), null, "nothing is left running or queued");
  reopened.close();
});

test("a result that arrives during shutdown but exceeds capacity fails terminally instead of being requeued", async () => {
  const home = freshHome();
  const store = openStore(home);
  const { first, second } = twoQueuedGoals(store);
  const errors: unknown[] = [];
  const runner = new WorkshopRunner(store, { artifactRoot: join(store.home, "artifacts"), onError: (e) => errors.push(e) });
  runners.push(runner);
  // The first build only finishes once the runner asks it to stop, as a publisher that was about
  // to return anyway would; the second answers at once.
  setBuild(
    runner,
    (input, options) =>
      new Promise((resolve) => {
        if (input.id !== first.id) return resolve(resultFor(second));
        options.signal?.addEventListener("abort", () => resolve(resultFor(first, BIG_OUTPUT)), { once: true });
      }),
  );

  runner.start();
  await waitFor(() => runner.busy && store.getJob(first.id).state === "running", "the first job to start");
  await runner.stop();

  const failed = store.getJob(first.id);
  assert.equal(failed.state, "failed", "not queued again: building it again would not make it fit");
  assert.match(failed.error ?? "", /capacity/);
  assert.equal(store.getJob(second.id).state, "queued");
  assert.deepEqual(errors, []);

  // The next start takes the next goal's job without the failed one in the way.
  runner.start();
  await waitFor(() => store.getJob(second.id).state === "ready", "the second job to become ready");
  await runner.stop();
  assert.deepEqual(errors, []);
  store.close();

  const reopened = openStore(home);
  assert.equal(reopened.getJob(first.id).state, "failed");
  assert.equal(reopened.getJob(second.id).state, "ready");
  reopened.close();
});
