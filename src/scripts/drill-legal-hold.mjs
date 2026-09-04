/* global process */

/**
 * Legal-hold drill — does an active legal hold actually stop the product from
 * erasing or sweeping a subject?
 *
 * WHAT THIS SCRIPT USED TO DO, AND WHY IT PROVED NOTHING.
 *
 * It opened a transaction, INSERTed a row into `hr_legal_holds`, and then SELECTed
 * that row back with its own hand-written SQL. Reading its own INSERT was the
 * whole test: the PASS string said so out loud — "Retention sweep blocked: hold
 * check query returns the active hold". Its verdict helper was
 *
 *     function holdCheck({ hrActive }) { return { erasureBlocked: hrActive, … } }
 *
 * so `--self-test` asserted that `hrActive === true` implies `erasureBlocked ===
 * true`, which is true of the identity function and of nothing else. Nine
 * assertions reported PASS and not one of them could have gone red if every
 * legal-hold guard in the product had been deleted, because not one of them ran
 * product code: the file mentioned no service, no helper and no sweep.
 *
 * WHAT IT DOES NOW.
 *
 * The verdict comes from `legal-hold-drill-probe.ts`, which constructs the real
 * `RetentionService`, `GdprSubjectErasureService`, `GdprStoragePurgeService` and
 * `LegalHoldsService` against a real database and asks THEM. This file is the CLI
 * around it: argument handling, the anti-vacuity floors, rendering and the exit
 * code. It deliberately owns no assertion of its own — a drill that can answer its
 * own question is the defect being fixed here.
 *
 * The probe is TypeScript because the product is. `package.json` runs this file
 * with plain `node`, so ts-node is spawned as a child rather than registered as a
 * loader.
 *
 * THE DRILL HAS A CONTROL PHASE. Before any hold exists, the same production
 * methods must PERMIT the operation — an unheld subject's delete request has to
 * run through `RetentionService.processRequest` to `completed`. Without that,
 * "blocked" would also be the answer from a product that erases nothing for
 * anybody, and this drill would certify it.
 *
 * Nothing is committed: the probe runs inside one tenant transaction and rolls it
 * back. The rollback is the only simulated part.
 *
 * Usage:
 *   node src/scripts/drill-legal-hold.mjs <email> <org-id>
 *   node src/scripts/drill-legal-hold.mjs --self-test
 *
 * Exit codes:
 *   0 = every production path refused under a hold and permitted without one
 *   1 = a production path gave the wrong answer — this is the finding
 *   2 = INCONCLUSIVE: a prerequisite is absent (no DATABASE_URL, no ts-node, the
 *       subject is not a member of the org, a pre-existing hold), or the run did
 *       not cover enough of the contract to have a verdict. Never read as a pass.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TS_NODE = path.join(BACKEND_ROOT, "node_modules", ".bin", "ts-node");
const PROBE = path.join(BACKEND_ROOT, "src", "scripts", "legal-hold-drill-probe.ts");

/**
 * Floors, in the shape of MIN_SEALS/MIN_SEALED_FILES in check-evidence-seal.mjs and
 * MIN_TABLES_SCANNED in check-retention-coverage.mjs: a run that asserted nothing
 * must report INCONCLUSIVE, never a pass.
 *
 * MIN_CHECKS and MIN_PRODUCTION_PATHS together mean a verdict requires several
 * distinct product methods to have answered, so deleting a probe phase turns the
 * gate amber rather than green. REQUIRED_PHASES is the one that matters most: drop
 * the control phase and the drill can no longer tell "the hold blocked it" from
 * "nothing works", so its absence is not a pass either.
 */
const MIN_CHECKS = 12;
const MIN_PRODUCTION_PATHS = 5;
const REQUIRED_PHASES = ["control", "held", "released"];

const argv = process.argv.slice(2);
const selfTest = argv.includes("--self-test");

function haveTsNode() {
  return existsSync(TS_NODE);
}

/** Runs the probe and returns its parsed report, or null when it produced none. */
function runProbe(probeArgs) {
  const dir = mkdtempSync(path.join(tmpdir(), "legal-hold-drill-"));
  const out = path.join(dir, "report.json");
  try {
    execFileSync(TS_NODE, ["--transpile-only", PROBE, ...probeArgs, `--out=${out}`], {
      cwd: BACKEND_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
    });
  } catch (err) {
    process.stderr.write(`probe process failed: ${err.message}\n`);
  }
  try {
    return JSON.parse(readFileSync(out, "utf8"));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function render(checks) {
  let passed = 0;
  let failed = 0;
  for (const check of checks) {
    const line = `${check.phase.toUpperCase().padEnd(8)} ${check.productionPath}\n           expected ${check.expected}\n           observed ${check.observed}`;
    if (check.ok) {
      console.log(`  PASS  ${line}`);
      passed++;
    } else {
      console.error(`  FAIL  ${line}`);
      failed++;
    }
  }
  return { passed, failed };
}

function finish(code) {
  process.exit(code);
}

if (!haveTsNode()) {
  process.stderr.write(
    `INCONCLUSIVE — ts-node is not installed at ${TS_NODE}, so no production code could be ` +
      "loaded and nothing was verified. This is exit 2, not a pass.\n",
  );
  finish(2);
}

if (selfTest) {
  /*
   * The old --self-test asserted `holdCheck({hrActive:true}).erasureBlocked === true`,
   * a restatement of its own one-line function. This one asks whether the product
   * methods the drill claims to exercise still exist under those names, which is the
   * failure a rename would otherwise hide: the drill would keep passing while
   * silently testing nothing.
   */
  console.log("\n=== LEGAL HOLD DRILL — self-test (production surface, no database) ===\n");
  const report = runProbe(["--contract"]);
  if (!report || !Array.isArray(report.checks) || report.checks.length === 0) {
    process.stderr.write("INCONCLUSIVE — the probe reported no production surface at all.\n");
    finish(2);
  }
  const { passed, failed } = render(report.checks);
  console.log(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed) ===`);
  finish(failed > 0 ? 1 : 0);
}

const [emailArg, orgIdArg] = argv;
if (!emailArg || !orgIdArg) {
  process.stderr.write(
    "INCONCLUSIVE — usage: node drill-legal-hold.mjs <email> <org-id>. No subject, no drill.\n",
  );
  finish(2);
}

if (!process.env.DATABASE_URL) {
  process.stderr.write(
    "INCONCLUSIVE — DATABASE_URL is not set, so no production path was exercised. " +
      "This is exit 2, not a pass.\n",
  );
  finish(2);
}

const email = emailArg.trim().toLowerCase();
const orgId = orgIdArg.trim();

console.log(`\n=== LEGAL HOLD DRILL for ${email} in org ${orgId} ===`);
console.log("Every verdict below is a real service method's answer; nothing is committed.\n");

const report = runProbe([`--email=${email}`, `--org=${orgId}`]);

if (!report) {
  process.stderr.write(
    "INCONCLUSIVE — the probe produced no report, so no production path was observed.\n",
  );
  finish(2);
}

if (report.error) {
  process.stderr.write(`INCONCLUSIVE — the drill could not run: ${report.error}\n`);
  finish(2);
}

const checks = Array.isArray(report.checks) ? report.checks : [];
const phases = new Set(checks.map((c) => c.phase));
const paths = new Set(checks.map((c) => c.productionPath));
const missingPhases = REQUIRED_PHASES.filter((phase) => !phases.has(phase));

const { passed, failed } = render(checks);

if (checks.length < MIN_CHECKS || paths.size < MIN_PRODUCTION_PATHS || missingPhases.length > 0) {
  process.stderr.write(
    `INCONCLUSIVE — the run covered ${checks.length} check(s) across ${paths.size} production ` +
      `path(s) (floors: ${MIN_CHECKS} and ${MIN_PRODUCTION_PATHS})` +
      (missingPhases.length > 0 ? `, and no ${missingPhases.join("/")} phase ran` : "") +
      ". Too little of the contract was exercised to call this a pass.\n",
  );
  finish(2);
}

console.log(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed) ===`);
console.log(
  `    ${paths.size} production paths exercised across ${[...phases].sort().join(", ")} phases.\n`,
);
finish(failed > 0 ? 1 : 0);
