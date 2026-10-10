// The owner-lock critical section, run as a child under flock(1)'s guard lock by files.ts:
//   flock ... /proc/self/fd/3 node --import tsx owner-lock-helper.ts <acquire|release> <owner path> <parent pid> <token>
// It only parses its arguments and prints the structured outcome of ownerLockOperation as one JSON
// line; every check on the owner record and every file rule lives in files.ts. The pid it writes
// is the parent's, passed in, never its own: the parent is the process that owns the home.

import { ownerLockOperation } from "./files.ts";
import type { OwnerLockOutcome } from "./files.ts";

function main(argv: string[]): OwnerLockOutcome {
  const [operation, path, pidText, token] = argv;
  if (operation !== "acquire" && operation !== "release") return { ok: false, kind: "operational", message: `owner-lock helper: unknown operation ${String(operation)}` };
  if (!path || !path.startsWith("/")) return { ok: false, kind: "operational", message: "owner-lock helper: owner path must be absolute" };
  const pid = /^[1-9][0-9]{0,15}$/.test(pidText ?? "") ? Number(pidText) : NaN;
  if (!Number.isSafeInteger(pid)) return { ok: false, kind: "operational", message: "owner-lock helper: parent pid must be a positive integer" };
  if (!token) return { ok: false, kind: "operational", message: "owner-lock helper: token is required" };
  return ownerLockOperation(operation, path, pid, token);
}

let outcome: OwnerLockOutcome;
try {
  outcome = main(process.argv.slice(2));
} catch (err) {
  outcome = { ok: false, kind: "operational", message: err instanceof Error ? err.message : String(err) };
}
process.stdout.write(`${JSON.stringify(outcome)}\n`);
