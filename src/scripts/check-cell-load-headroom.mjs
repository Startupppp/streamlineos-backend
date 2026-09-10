/**
 * cell:load — headroom assertion for the cell workload envelope.
 *
 * Reads .load-driver-results.json produced by `pnpm load:drive` and asserts that
 * every measured latency objective has at least 40% headroom:
 *
 *   headroom = (target − measured_p95) / target ≥ 0.40
 *
 * A result file produced by a non-colocated runner (public internet to Neon) will
 * fail latency objectives because the 80ms+ round-trip floor exceeds several targets.
 * Run `pnpm load:drive` from within the same region as the Neon endpoint, then
 * run this script.
 *
 * Usage:
 *   pnpm -C backend cell:load
 *   pnpm -C backend cell:load --results=.load-driver-results.json
 *   pnpm -C backend cell:load --self-test
 *
 * Exit codes:
 *   0 = all measured objectives have ≥ 40% headroom
 *   1 = one or more objectives breach the headroom floor, or prerequisites absent
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CELL_SHARE, LATENCY_OBJECTIVES } from "./envelope-profile.mjs";

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const HEADROOM_FLOOR = 0.40;

const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const RESULTS_PATH = resolve(process.cwd(), flag("results", ".load-driver-results.json"));

const NO_HEADROOM_OBJECTIVES = new Set([
  "authenticated-interactive-availability",
  "cross-org-data-exposure",
  "durable-event-loss-after-ack",
  "node-failure-committed-loss",
]);

function pad(s, n) { return String(s).padEnd(n); }

function pass(label, detail) { console.log(`PASS   ${pad(label, 44)} ${detail}`); }
function fail(label, detail) { console.error(`FAIL   ${pad(label, 44)} ${detail}`); }
function skip(label, detail) { console.log(`SKIP   ${pad(label, 44)} ${detail}`); }

function computeHeadroom(obj) {
  if (NO_HEADROOM_OBJECTIVES.has(obj.name)) return null;
  if (obj.target <= 0) return null;
  const measured = obj.measured ?? obj.measuredMs;
  if (measured === null || measured === undefined) return null;
  return (obj.target - measured) / obj.target;
}

function checkHeadroom(results) {
  const failures = [];
  let measured = 0;
  let skipped = 0;

  for (const obj of results.objectives) {
    if (obj.verdict === "NOT_DRIVEN" || obj.measured === null || obj.measured === undefined) {
      skip(obj.name, `NOT_DRIVEN — ${obj.reason ?? "no measurement produced"}`);
      skipped++;
      continue;
    }

    if (NO_HEADROOM_OBJECTIVES.has(obj.name)) {
      const verdict = obj.verdict === "MET" ? "PASS" : "FAIL";
      if (verdict === "PASS") pass(obj.name, `measured=${obj.measured} target=${obj.target} (boolean objective, no headroom)`);
      else { fail(obj.name, `BREACHED measured=${obj.measured} target=${obj.target}`); failures.push(obj.name); }
      measured++;
      continue;
    }

    measured++;
    const headroom = computeHeadroom(obj);
    if (headroom === null) {
      skip(obj.name, `headroom uncomputable (target=${obj.target})`);
      skipped++;
      measured--;
      continue;
    }

    const pct = (headroom * 100).toFixed(1);
    if (headroom >= HEADROOM_FLOOR) {
      pass(obj.name, `headroom=${pct}% measured=${obj.measured} target=${obj.target}`);
    } else {
      fail(obj.name, `headroom=${pct}% < ${(HEADROOM_FLOOR * 100).toFixed(0)}% floor measured=${obj.measured} target=${obj.target}`);
      failures.push(obj.name);
    }
  }

  const line =
    `RESULT: ${failures.length === 0 ? "HEADROOM PASS" : "HEADROOM FAIL"}` +
    ` measured=${measured} skipped=${skipped} breached=${failures.length}` +
    ` floor=${(HEADROOM_FLOOR * 100).toFixed(0)}%`;
  console.log(`\n${line}`);
  return failures;
}

function selfTest() {
  const fakeResults = {
    generatedAtMs: Date.now(),
    requestCount: 5000,
    organizationMembers: 100_004,
    conditions: { geography: { value: "same-region", note: "colocated with ap-southeast-1" } },
    objectives: [
      { name: "p95-simple-db-roundtrip", verdict: "MET", measured: 12.2, target: 20 },
    ],
  };
  const failures = checkHeadroom(fakeResults);
  if (failures.length === 1 && failures[0] === "p95-simple-db-roundtrip") {
    console.log("\nSELF-TEST PASS: 39% headroom (12.2ms against 20ms target) is correctly reported as FAIL — the guard can bite");
    process.exitCode = 0;
  } else {
    console.error("\nSELF-TEST FAIL: expected one headroom failure but got:", failures);
    process.exitCode = 1;
  }
}

function main() {
  if (!existsSync(RESULTS_PATH)) {
    console.error(`MISSING PREREQUISITE: ${RESULTS_PATH} does not exist.`);
    console.error("Produce it first by running the load driver from a colocated runner:");
    console.error("  pnpm -C backend load:drive");
    console.error("Then assert headroom:");
    console.error("  pnpm -C backend cell:load");
    // 2, not 1: this gate could not RUN. Exit 1 here is indistinguishable from
    // "headroom is insufficient", which is the finding this script exists to
    // report, and a sweep reading exit codes counts a missing results file as a
    // capacity violation. Same convention as check:alert-ack and
    // compare-cell-schema.
    process.exit(2);
  }

  let results;
  try {
    results = JSON.parse(readFileSync(RESULTS_PATH, "utf8"));
  } catch (e) {
    console.error(`PARSE ERROR: ${RESULTS_PATH}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  if (!Array.isArray(results.objectives) || results.objectives.length === 0) {
    console.error("VACUITY GUARD: results file contains no objectives. The file is corrupt or from a failed run.");
    console.error("Delete it and re-run pnpm load:drive.");
    process.exit(1);
  }

  const members = results.organizationMembers ?? 0;
  if (members < CELL_SHARE.largestOrgMembers) {
    console.error(`VACUITY GUARD: results were produced with ${members} members but the cell envelope requires` +
      ` ${CELL_SHARE.largestOrgMembers}. Seed the fixture first: pnpm -C backend seed:envelope`);
    process.exit(1);
  }

  console.log(`results   : ${RESULTS_PATH}`);
  console.log(`generated : ${new Date(results.generatedAtMs).toISOString()}`);
  console.log(`requests  : ${results.requestCount}`);
  console.log(`members   : ${members} (required: ${CELL_SHARE.largestOrgMembers})`);
  console.log(`geography : ${results.conditions?.geography?.value ?? "not declared"}`);
  if (results.conditions?.geography?.note) console.log(`note      : ${results.conditions.geography.note}`);
  console.log(`floor     : ${(HEADROOM_FLOOR * 100).toFixed(0)}% headroom required\n`);

  const measuredNames = new Set((results.objectives ?? []).map((o) => o.name));
  for (const obj of LATENCY_OBJECTIVES) {
    if (!measuredNames.has(obj.name)) {
      results.objectives.push({ name: obj.name, verdict: "NOT_DRIVEN", measured: null, target: obj.target });
    }
  }

  const failures = checkHeadroom(results);
  if (failures.length > 0) process.exitCode = 1;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (SELF_TEST) selfTest();
  else main();
}
