import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSpec, walk } from "./lib/route-scan.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = join(ROOT, "src");

/*
  `forEachOrg` opens one tenant transaction per organisation, sequentially, and
  the pool is 10. A periodic sweep with no budget borrows a connection for every
  tenant on every tick, competing with live traffic for the same slots.

  It already exposes `stopWhen`, consulted BEFORE each transaction is opened, and
  `startAfterOrgId` to resume where the budget ran out. Today no periodic sweep
  uses either.

  This does NOT claim the frozen sweeps are safe. It is a ceiling: the count may
  fall, never rise. Lowering it is per-caller work, because a budget without a
  durable cursor is worse than none — a truncated sweep restarts from the first
  organisation next tick and the tail is never reached.
*/
const BUDGET = "stopWhen";
const SWEEP = "forEachOrg";
/*
  A call, not a mention. `calendar-reminder-sweep.schemas.ts` names the sweep in
  prose and opens no transaction; counting it would inflate the ceiling with
  files that can never be fixed.
*/
const SWEEP_CALL = /\bforEachOrg\s*(?:<[^>]*>)?\s*\(/;

const PERIODIC = /[\\/]cron[\\/]|worker|relay|sweep|retention|reconcil/i;

const CEILING = 50;
const MIN_SCANNED = 60;

function periodicSweeps() {
  const unbudgeted = [];
  let scanned = 0;

  for (const file of walk(SRC)) {
    if (isSpec(file)) continue;
    const source = readFileSync(file, "utf8");
    if (!SWEEP_CALL.test(source)) continue;
    scanned++;
    const rel = relative(SRC, file).replace(/\\/g, "/");
    if (!PERIODIC.test(rel)) continue;
    if (source.includes(BUDGET)) continue;
    unbudgeted.push(rel);
  }

  return { scanned, unbudgeted: unbudgeted.sort() };
}

function selfTest() {
  const failures = [];

  if (!SWEEP_CALL.test("await forEachOrg(db, \"x\", fn);"))
    failures.push("a real forEachOrg call was not detected");
  if (SWEEP_CALL.test("// forEachOrg is described here but never called"))
    failures.push("a prose mention of forEachOrg was counted as a call");
  if (!PERIODIC.test("modules/cron/cron-billing.service.ts"))
    failures.push("a cron sweep was not recognised as periodic");
  if (!PERIODIC.test("modules/payroll/runs/payroll-export-worker.service.ts"))
    failures.push("a worker was not recognised as periodic");
  if (!PERIODIC.test("common/workflow/workflow-outbox-relay.service.ts"))
    failures.push("a relay was not recognised as periodic");
  if (PERIODIC.test("modules/billing/core/billing.controller.ts"))
    failures.push("a request-path controller was misread as a periodic sweep");

  const { scanned, unbudgeted } = periodicSweeps();
  if (scanned < MIN_SCANNED)
    failures.push(`resolved only ${scanned} file(s) calling ${SWEEP} (floor ${MIN_SCANNED})`);
  if (unbudgeted.length === 0)
    failures.push("found no unbudgeted sweep at all, which means the scan is not reading source");

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure}`);
    console.error("check-sweep-budget self-test FAILED");
    process.exit(3);
  }
  console.log("check-sweep-budget self-test passed");
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const { scanned, unbudgeted } = periodicSweeps();

  if (scanned < MIN_SCANNED) {
    console.error(
      `check-sweep-budget: resolved only ${scanned} file(s) calling ${SWEEP} ` +
        `(floor ${MIN_SCANNED}). The scan is broken, not the codebase.`,
    );
    process.exit(2);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ scanned, unbudgeted }, null, 2));
    return;
  }

  if (unbudgeted.length > CEILING) {
    console.error(
      `check-sweep-budget: ${unbudgeted.length} periodic sweep(s) iterate every organisation with no ` +
        `budget, above the ceiling of ${CEILING}. ${SWEEP} takes a ${BUDGET} consulted before each ` +
        `transaction is opened, and startAfterOrgId to resume — pass both, or the sweep competes with ` +
        `live traffic for the whole pool.`,
    );
    for (const entry of unbudgeted) console.error(`  ${entry}`);
    process.exit(1);
  }

  if (unbudgeted.length < CEILING) {
    console.log(
      `check-sweep-budget: ${unbudgeted.length} unbudgeted periodic sweep(s), below the ceiling of ` +
        `${CEILING}. Lower CEILING to ${unbudgeted.length} to hold the ground.`,
    );
    return;
  }

  console.log(
    `check-sweep-budget: ${scanned} file(s) call ${SWEEP}; ` +
      `${unbudgeted.length} periodic sweep(s) run unbudgeted (ceiling).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
