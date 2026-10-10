// Behavioral regression tests for WorkshopStore: durable state across close and reopen, job
// transitions, schedules, corrections, reading positions, and graded exercise attempts. Each test
// gets its own temporary home outside the repository and closes every store it opens.

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { WorkshopError, WorkshopRunner, WorkshopStore } from "./runtime.ts";
import type { BuildResult, Goal, Job, WorkshopErrorStatus } from "./runtime.ts";

const homes: string[] = [];
const open: WorkshopStore[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dum-workshop-test-"));
  homes.push(home);
  return home;
}

function openStore(home: string): WorkshopStore {
  const store = new WorkshopStore(home);
  open.push(store);
  return store;
}

after(() => {
  for (const store of open) store.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function status(expected: WorkshopErrorStatus): (err: unknown) => boolean {
  return (err) => err instanceof WorkshopError && err.status === expected;
}

/** A small valid result whose panels cite teachings the job's snapshot actually holds. */
function buildResultFor(job: Job, panelCount = 3): BuildResult {
  const teachingIds = job.snapshot.teachings.map((t) => t.id);
  assert.ok(teachingIds.length > 0, "fixture needs a job with teachings");
  return {
    title: `Creation for ${job.snapshot.goal.title}`,
    panels: Array.from({ length: panelCount }, (_, i) => ({ caption: `Panel ${i + 1}`, code: `console.log(${i})`, teachingIds })),
    verification: { command: "node demo.js", output: "0\n1\n2" },
    supportingMachinery: ["demo.js"],
  };
}

function goalWithTeaching(store: WorkshopStore, title = "Learn loops"): Goal {
  const goal = store.createGoal({ title, ambition: "Explain loops and conditions with a small program." });
  store.teach(goal.id, { concept: "loops", text: "A for loop repeats a body while its condition holds." });
  return goal;
}

/** Claim the next queued job and complete it with a valid result. */
function makeReady(store: WorkshopStore, panelCount = 3): Job {
  const claimed = store.claimNextJob();
  assert.ok(claimed, "expected a queued job to claim");
  return store.completeJob(claimed.id, buildResultFor(claimed, panelCount));
}

const GRADED = { concept: "loops" as const, exerciseId: "loops-1", answer: "0 1 2", correct: false, feedback: "The loop prints 0, 1, 2 then stops." };

// ---------------------------------------------------------------------------------------------

test("persisted goal, teaching, attempts and job snapshot survive close and reopen; returned records are clones", () => {
  const home = freshHome();
  const first = openStore(home);
  const goal = goalWithTeaching(first);
  const [teaching] = first.listTeachings(goal.id);
  const freeform = first.attempt(goal.id, { concept: "loops", text: "I wrote a counting loop", helped: true }).attempt;
  const graded = first.recordAttempt(goal.id, GRADED);
  const job = first.enqueue(goal.id);

  // Mutating what the store handed out changes nothing inside it.
  const handedGoal = first.getGoal(goal.id);
  handedGoal.title = "tampered";
  handedGoal.materials.length = 0;
  const handedJob = first.getJob(job.id);
  handedJob.snapshot.teachings.push({ ...teaching, id: "00000000-0000-4000-8000-000000000000" });
  handedJob.snapshot.goal.context = "tampered";
  const handedAttempts = first.listAttempts(goal.id);
  handedAttempts[0].answer = "tampered";
  const handedProgress = first.progress(goal.id);
  handedProgress.concepts[0].learnerReports.length = 0;
  assert.equal(first.getGoal(goal.id).title, goal.title);
  assert.equal(first.getGoal(goal.id).materials.length, goal.materials.length);
  assert.equal(first.getJob(job.id).snapshot.teachings.length, 1);
  assert.equal(first.getJob(job.id).snapshot.goal.context, job.snapshot.goal.context);
  assert.equal(first.listAttempts(goal.id)[0].answer, GRADED.answer);
  assert.equal(first.progress(goal.id).concepts[0].learnerReports.length, 1);

  const before = {
    goal: first.getGoal(goal.id),
    teachings: first.listTeachings(goal.id),
    attempts: first.listAttempts(goal.id),
    job: first.getJob(job.id),
    progress: first.progress(goal.id),
  };
  first.close();

  const second = openStore(home);
  assert.deepEqual(second.getGoal(goal.id), before.goal);
  assert.deepEqual(second.listTeachings(goal.id), before.teachings);
  assert.deepEqual(second.listAttempts(goal.id), before.attempts);
  assert.deepEqual(second.getJob(job.id), before.job);
  assert.deepEqual(second.progress(goal.id), before.progress);

  // The old freeform shape and the graded shape both come back intact, each listed where it belongs.
  const reopened = second.listAttempts(goal.id);
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].id, graded.id);
  assert.equal(reopened[0].helped, undefined);
  assert.equal(reopened[0].exerciseId, GRADED.exerciseId);
  assert.equal(reopened[0].answer, GRADED.answer);
  assert.equal(reopened[0].feedback, GRADED.feedback);
  assert.equal(reopened[0].correct, false);
  const loops = second.progress(goal.id).concepts.find((c) => c.concept === "loops");
  assert.ok(loops);
  assert.deepEqual(loops.learnerReports.map((r) => [r.attemptId, r.helped, r.text]), [[freeform.id, true, "I wrote a counting loop"]]);
  assert.deepEqual(loops.exerciseReports.map((r) => [r.attemptId, r.correct]), [[graded.id, false]]);
  assert.equal(loops.counts.attemptedWithHelp, 1);
  assert.equal(loops.counts.needsRevisiting, 1);
  assert.equal(loops.counts.usedIndependently, 0);
  second.close();
});

test("a job left running is queued again on reopen and its next claim uses a fresh artifact id", () => {
  const home = freshHome();
  const first = openStore(home);
  const goal = goalWithTeaching(first);
  const queued = first.enqueue(goal.id);
  const running = first.claimNextJob();
  assert.ok(running);
  assert.equal(running.id, queued.id);
  assert.equal(running.state, "running");
  assert.equal(running.artifactId, queued.id);
  assert.equal(running.attempts, 1);
  // Closing without completing stands in for a process that died mid-build.
  first.close();

  const second = openStore(home);
  const recovered = second.getJob(queued.id);
  assert.equal(recovered.state, "queued");
  assert.equal(recovered.startedAt, undefined);
  assert.equal(recovered.artifactId, queued.id);
  assert.deepEqual(recovered.previousArtifactIds, []);

  const reclaimed = second.claimNextJob();
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, queued.id);
  assert.equal(reclaimed.state, "running");
  assert.equal(reclaimed.attempts, 2);
  assert.notEqual(reclaimed.artifactId, queued.id);
  assert.deepEqual(reclaimed.previousArtifactIds, [queued.id]);
  assert.deepEqual(second.getJob(queued.id).previousArtifactIds, [queued.id]);
  second.close();
});

test("a due schedule enqueues once, never duplicates an active job, and persists its next run", () => {
  const home = freshHome();
  const first = openStore(home);
  const goal = goalWithTeaching(first);
  const scheduled = first.setSchedule(goal.id, { intervalMinutes: 5 });
  assert.ok(scheduled.schedule);
  const firstDue = Date.parse(scheduled.schedule.nextRunAt);

  assert.deepEqual(first.runDueSchedules(firstDue - 1), []);
  const created = first.runDueSchedules(firstDue);
  assert.equal(created.length, 1);
  assert.equal(created[0].goalId, goal.id);
  assert.equal(created[0].state, "queued");
  const afterFirst = first.getGoal(goal.id).schedule;
  assert.ok(afterFirst);
  assert.equal(afterFirst.nextRunAt, new Date(firstDue + 5 * 60_000).toISOString());

  // Due again while the job is still queued: the interval advances, no second job appears.
  const secondDue = Date.parse(afterFirst.nextRunAt);
  assert.deepEqual(first.runDueSchedules(secondDue), []);
  assert.equal(first.listJobs(goal.id).length, 1);
  const afterSecond = first.getGoal(goal.id).schedule;
  assert.ok(afterSecond);
  assert.equal(afterSecond.nextRunAt, new Date(secondDue + 5 * 60_000).toISOString());

  // Still active while running.
  const running = first.claimNextJob();
  assert.ok(running);
  const thirdDue = Date.parse(afterSecond.nextRunAt);
  assert.deepEqual(first.runDueSchedules(thirdDue), []);
  assert.equal(first.listJobs(goal.id).length, 1);
  first.completeJob(running.id, buildResultFor(running));

  // The advanced next run survives reopen, and with no active job the next due time enqueues exactly one.
  const persisted = first.getGoal(goal.id).schedule;
  assert.ok(persisted);
  first.close();
  const second = openStore(home);
  assert.deepEqual(second.getGoal(goal.id).schedule, persisted);
  const fourthDue = Date.parse(persisted.nextRunAt);
  const again = second.runDueSchedules(fourthDue);
  assert.equal(again.length, 1);
  assert.equal(second.listJobs(goal.id).filter((j) => j.state === "queued").length, 1);
  assert.equal(second.listJobs(goal.id).length, 2);
  assert.equal(second.nextScheduledAt(), fourthDue + 5 * 60_000);
  second.close();
});

test("a correction needs a ready parent from the same goal and leaves the parent untouched", () => {
  const store = openStore(freshHome());
  const goalA = goalWithTeaching(store, "Goal A");
  const goalB = goalWithTeaching(store, "Goal B");
  store.enqueue(goalA.id);
  const parent = makeReady(store);
  assert.equal(parent.goalId, goalA.id);
  assert.equal(parent.state, "ready");
  const parentBefore = store.getJob(parent.id);

  assert.throws(() => store.enqueue(goalB.id, { correction: "Use goal B's framing", parentId: parent.id }), status(400));
  assert.throws(() => store.enqueue(goalA.id, { correction: "Missing parent" }), status(400));
  const queuedB = store.enqueue(goalB.id);
  assert.throws(() => store.enqueue(goalB.id, { correction: "Parent is only queued", parentId: queuedB.id }), status(409));

  const revision = store.enqueue(goalA.id, { correction: "Show the loop counter on every panel", parentId: parent.id });
  assert.notEqual(revision.id, parent.id);
  assert.equal(revision.goalId, goalA.id);
  assert.equal(revision.state, "queued");
  assert.equal(revision.parentId, parent.id);
  assert.equal(revision.correction, "Show the loop counter on every panel");
  assert.equal(revision.result, undefined);

  const parentAfter = store.getJob(parent.id);
  assert.deepEqual(parentAfter, parentBefore);
  assert.deepEqual(parentAfter.result, parentBefore.result);
  assert.equal(parentAfter.parentId, undefined);
  assert.equal(parentAfter.correction, undefined);
  assert.equal(store.listJobs(goalA.id).filter((j) => j.id === revision.id).length, 1);
  assert.equal(store.listJobs(goalB.id).some((j) => j.id === revision.id), false);
  store.close();
});

test("reading positions are bounded to a ready presentation's panels and survive reopen", () => {
  const home = freshHome();
  const first = openStore(home);
  const goal = goalWithTeaching(first);
  const queued = first.enqueue(goal.id);
  assert.throws(() => first.savePosition(queued.id, 0), status(409));
  assert.equal(first.getPosition(queued.id), 0);

  const ready = makeReady(first, 3);
  assert.equal(ready.id, queued.id);
  for (const bad of [-1, 1.5, Number.NaN, 3, 4, Number.POSITIVE_INFINITY, "1" as unknown as number]) {
    assert.throws(() => first.savePosition(ready.id, bad), status(400), `panel ${String(bad)} should be rejected`);
  }
  assert.equal(first.getPosition(ready.id), 0);
  assert.equal(first.savePosition(ready.id, 2), 2);
  assert.equal(first.getPosition(ready.id), 2);
  first.close();

  const second = openStore(home);
  assert.equal(second.getPosition(ready.id), 2);
  assert.equal(second.savePosition(ready.id, 0), 0);
  assert.equal(second.getPosition(ready.id), 0);
  second.close();
});

test("graded attempts are validated strictly and a correct grade never becomes independent use", () => {
  const store = openStore(freshHome());
  const goal = goalWithTeaching(store);
  const other = store.createGoal({ title: "Other", ambition: "Another goal" });
  const ok = GRADED;

  assert.throws(() => store.recordAttempt("not-a-uuid", ok), status(400));
  assert.throws(() => store.recordAttempt("00000000-0000-4000-8000-000000000000", ok), status(404));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, concept: "recursion" as unknown as "loops" }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, concept: "Loops" as unknown as "loops" }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, exerciseId: "" }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, exerciseId: "   " }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, exerciseId: "x".repeat(101) }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, answer: "" }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, answer: "y".repeat(2001) }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, feedback: "" }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, feedback: "z".repeat(2001) }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, correct: "true" as unknown as boolean }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, correct: 1 as unknown as boolean }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, { ...ok, correct: undefined as unknown as boolean }), status(400));
  assert.throws(() => store.recordAttempt(goal.id, null as unknown as typeof ok), status(400));
  assert.deepEqual(store.listAttempts(goal.id), []);
  assert.deepEqual(store.progress(goal.id).concepts, []);

  // Boundary lengths are accepted and stored as supplied.
  const longest = store.recordAttempt(goal.id, { ...ok, exerciseId: "e".repeat(100), answer: "a".repeat(2000), feedback: "f".repeat(2000) });
  assert.equal(longest.exerciseId?.length, 100);
  assert.equal(longest.answer?.length, 2000);
  assert.equal(longest.feedback?.length, 2000);

  const wrong = store.recordAttempt(goal.id, { ...ok, exerciseId: "loops-2", answer: "0 1 2 3", correct: false, feedback: "One too many." });
  const right = store.recordAttempt(goal.id, { ...ok, exerciseId: "loops-2", answer: "0 1 2", correct: true, feedback: "Correct." });
  const conditions = store.recordAttempt(goal.id, { concept: "conditions", exerciseId: "cond-1", answer: "yes", correct: true, feedback: "Correct." });
  for (const a of [wrong, right, conditions]) {
    assert.equal(a.goalId, goal.id);
    assert.equal(a.helped, undefined);
    assert.equal(a.text, a.answer);
  }
  assert.equal(right.correct, true);
  assert.equal(wrong.correct, false);
  assert.equal(wrong.answer, "0 1 2 3");
  assert.equal(wrong.feedback, "One too many.");
  assert.deepEqual(store.listAttempts(goal.id).map((a) => a.id), [longest.id, wrong.id, right.id, conditions.id]);
  assert.deepEqual(store.listAttempts(other.id), []);

  const progress = store.progress(goal.id);
  const loops = progress.concepts.find((c) => c.concept === "loops");
  const cond = progress.concepts.find((c) => c.concept === "conditions");
  assert.ok(loops);
  assert.ok(cond);

  // Incorrect grades are server-reported gaps; correct grades record no evidence of any kind.
  assert.equal(loops.counts.usedIndependently, 0);
  assert.equal(loops.counts.attemptedWithHelp, 0);
  assert.equal(loops.counts.introduced, 0);
  assert.equal(loops.counts.needsRevisiting, 2);
  assert.equal(loops.evidence.length, 2);
  for (const e of loops.evidence) {
    assert.equal(e.kind, "needsRevisiting");
    assert.equal(e.reportedBy, "server");
    assert.equal(e.source.type, "exercise");
  }
  assert.ok(loops.evidence.some((e) => e.source.type === "exercise" && e.source.attemptId === wrong.id));
  assert.equal(loops.evidence.some((e) => e.source.type === "exercise" && e.source.attemptId === right.id), false);
  assert.deepEqual(cond.counts, { introduced: 0, attemptedWithHelp: 0, usedIndependently: 0, needsRevisiting: 0 });
  assert.deepEqual(cond.evidence, []);
  assert.equal(cond.latest, null);

  // Graded outcomes are listed under their own label with evidence references; learner reports stay empty.
  assert.deepEqual(loops.learnerReports, []);
  assert.deepEqual(cond.learnerReports, []);
  assert.equal(loops.exerciseReports.length, 3);
  const wrongReport = loops.exerciseReports.find((r) => r.attemptId === wrong.id);
  const rightReport = loops.exerciseReports.find((r) => r.attemptId === right.id);
  assert.ok(wrongReport);
  assert.ok(rightReport);
  assert.equal(wrongReport.label, "server-graded exercise");
  assert.equal(wrongReport.correct, false);
  assert.equal(wrongReport.answer, "0 1 2 3");
  assert.equal(wrongReport.feedback, "One too many.");
  assert.ok(loops.evidence.some((e) => e.id === wrongReport.evidenceId));
  assert.equal(rightReport.correct, true);
  assert.equal(rightReport.evidenceId, null);
  assert.deepEqual(cond.exerciseReports.map((r) => [r.exerciseId, r.correct, r.evidenceId]), [["cond-1", true, null]]);
  assert.equal(progress.note.includes("mastery"), true);

  // The learner's own freeform report keeps its prior meaning and is the only path to usedIndependently.
  const own = store.attempt(goal.id, { concept: "loops", text: "Wrote a loop alone", helped: false });
  assert.equal(own.evidence.kind, "usedIndependently");
  assert.equal(own.evidence.reportedBy, "learner");
  const after = store.progress(goal.id).concepts.find((c) => c.concept === "loops");
  assert.ok(after);
  assert.equal(after.counts.usedIndependently, 1);
  assert.deepEqual(after.learnerReports.map((r) => [r.attemptId, r.label, r.helped, r.text]), [[own.attempt.id, "learner report", false, "Wrote a loop alone"]]);
  assert.equal(after.exerciseReports.length, 3);
  // Freeform reports are not exercises, so the exercise list is unchanged.
  assert.equal(store.listAttempts(goal.id).length, 4);
  assert.equal(store.listAttempts(goal.id).some((a) => a.id === own.attempt.id), false);

  // Graded records feed the goal's computed context from the actual stored values.
  const context = store.getGoal(goal.id).context;
  assert.ok(context.includes("server graded incorrect"));
  assert.ok(context.includes("One too many."));
  assert.ok(context.includes(`exercise attempt ${right.id}`));
  store.close();
});

// ---------------------------------------------------------------------------------------------

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

test("the runner creates a missing nested artifact root as a private directory before any build", () => {
  const store = openStore(freshHome());
  // store.home is canonical; the nested root does not exist yet, as on a freshly initialized home.
  const artifactRoot = join(store.home, "artifacts", "creations");
  assert.equal(existsSync(join(store.home, "artifacts")), false);

  const runner = new WorkshopRunner(store, { artifactRoot, onError: () => {} });
  assert.ok(runner instanceof WorkshopRunner);
  assert.equal(runner.busy, false);

  // The publisher requires a real, canonical directory: it exists, is not a symlink, and is private.
  const st = lstatSync(artifactRoot);
  assert.equal(st.isDirectory(), true);
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(modeOf(artifactRoot), 0o700);
  assert.equal(modeOf(join(store.home, "artifacts")), 0o700);
  // The home itself and its records are left as the store made them.
  assert.equal(modeOf(store.home), 0o700);
  assert.equal(existsSync(join(store.home, "workshop.json")), true);

  // A second runner over an existing root is accepted without changing it.
  const again = new WorkshopRunner(store, { artifactRoot, onError: () => {} });
  assert.ok(again instanceof WorkshopRunner);
  assert.equal(lstatSync(artifactRoot).isDirectory(), true);
  assert.equal(modeOf(artifactRoot), 0o700);
  store.close();
});

test("the runner rejects an artifact root that is a symlink, sits under a symlink, lies outside the home, or is the home itself", () => {
  const store = openStore(freshHome());
  const home = store.home;

  // Final symlink: the link points at a real directory whose mode must stay untouched.
  const linkTarget = join(home, "elsewhere");
  mkdirSync(linkTarget);
  chmodSync(linkTarget, 0o755);
  const finalLink = join(home, "artifacts-link");
  symlinkSync(linkTarget, finalLink);
  assert.throws(() => new WorkshopRunner(store, { artifactRoot: finalLink, onError: () => {} }), status(400));
  assert.equal(lstatSync(finalLink).isSymbolicLink(), true);
  assert.equal(modeOf(linkTarget), 0o755);

  // Ancestor symlink: the canonical path differs from the supplied one; nothing is created on either side.
  const realParent = join(home, "real-parent");
  mkdirSync(realParent);
  chmodSync(realParent, 0o755);
  const parentLink = join(home, "parent-link");
  symlinkSync(realParent, parentLink);
  const underLink = join(parentLink, "artifacts");
  assert.throws(() => new WorkshopRunner(store, { artifactRoot: underLink, onError: () => {} }), status(400));
  assert.equal(existsSync(underLink), false);
  assert.equal(existsSync(join(realParent, "artifacts")), false);
  assert.equal(modeOf(realParent), 0o755);

  // Outside the home: a sibling temporary directory is neither created into nor re-permissioned.
  const outside = freshHome();
  const outsideRoot = join(outside, "artifacts");
  assert.throws(() => new WorkshopRunner(store, { artifactRoot: outsideRoot, onError: () => {} }), status(400));
  assert.equal(existsSync(outsideRoot), false);
  assert.throws(() => new WorkshopRunner(store, { artifactRoot: join(home, "..", "artifacts"), onError: () => {} }), status(400));
  assert.equal(existsSync(join(home, "..", "artifacts")), false);

  // The home itself is not an artifact root.
  assert.throws(() => new WorkshopRunner(store, { artifactRoot: home, onError: () => {} }), status(400));
  assert.throws(() => new WorkshopRunner(store, { artifactRoot: `${home}/`, onError: () => {} }), status(400));
  assert.throws(() => new WorkshopRunner(store, { artifactRoot: join(home, "x", ".."), onError: () => {} }), status(400));

  // A comma would break the publisher's Docker bind mount, so it is refused before anything is created.
  const withComma = join(home, "a,b");
  assert.throws(() => new WorkshopRunner(store, { artifactRoot: withComma, onError: () => {} }), status(400));
  assert.equal(existsSync(withComma), false);

  // Every rejection is the typed invalid error, and the home's records are untouched.
  assert.throws(() => new WorkshopRunner(store, { artifactRoot: finalLink, onError: () => {} }), (err: unknown) => err instanceof WorkshopError);
  assert.equal(modeOf(home), 0o700);
  assert.equal(existsSync(join(home, "workshop.json")), true);
  store.close();
});

test("a complete large verification report survives completion and restart", () => {
  const home = freshHome();
  const first = openStore(home);
  const goal = goalWithTeaching(first);
  first.enqueue(goal.id);
  const job = first.claimNextJob();
  assert.ok(job);
  const result = buildResultFor(job);
  result.verification.output = JSON.stringify({
    panels: Array.from({ length: 8 }, (_, i) => ({
      actual: "a".repeat(1000),
      actions: Array.from({ length: i === 0 ? 0 : 4 }, () => ({ before: "b".repeat(1200), after: "a".repeat(1200) })),
    })),
  });
  assert.ok(result.verification.output.length > 64000);
  assert.deepEqual(first.completeJob(job.id, result).result, result);
  first.close();
  const second = openStore(home);
  assert.deepEqual(second.getJob(job.id).result, result);
  second.close();
});
