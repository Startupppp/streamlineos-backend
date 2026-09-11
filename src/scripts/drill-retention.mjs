/* global process */

/**
 * Retention drill — do the cron retention sweeps actually delete expired data,
 * protect legally-held subjects, and stay within one org's scope?
 *
 * WHAT THIS DRILL PROVES (PRD-C188 requirements):
 *
 *   1. Expired eligible data is deleted or anonymised.
 *   2. Legal-hold subjects are retained, not deleted.
 *   3. One org's retention operation cannot affect another org's rows.
 *   4. Retries are idempotent and resumable.
 *   5. Large purges are cursor-based with no silent truncation.
 *
 * WHY THE PROBE CANNOT USE A SINGLE ROLLED-BACK TRANSACTION.
 *
 * The legal-hold drill ran everything inside one `runInNewTenantTransaction`
 * and rolled it back at the end — because `RetentionService.processRequest`
 * and `sweepStrandedDeleteRequests` both accept an explicit orgId and operate
 * within whatever transaction context is in flight. The three cron retention
 * services covered here (helpdesk, mail, announcements) all route through
 * `forEachOrg`, which opens a NEW tenant transaction per organisation. A row
 * INSERTed inside an outer transaction is invisible to any query in a child
 * transaction — Postgres read isolation. The probe therefore commits fixture
 * data, runs the real sweeps, queries what survived, and deletes everything
 * in a finally block. The scratch-database guard makes this safe.
 *
 * THE DRILL HAS A CONTROL PHASE. Before any hold exists the same sweep must
 * DELETE the expired rows. Without it "retained" would also be the answer from
 * a sweep that deletes nothing, and this drill would certify broken code.
 *
 * Nothing the probe does survives the drill: cleanup runs in the finally block
 * regardless of outcome and cascades through all fixture tables.
 *
 * Usage:
 *   SCRATCH_DATABASE_URL=postgresql://… node src/scripts/drill-retention.mjs \
 *     --org-a=<id> --org-b=<id>
 *   node src/scripts/drill-retention.mjs --self-test
 *
 * Both orgs must already exist in the scratch database with status ACTIVE.
 * Typical invocation from the orchestrator:
 *   SCRATCH_DATABASE_URL=... pnpm drill:retention --org-a=<id> --org-b=<id>
 *
 * Exit codes:
 *   0 = every production path gave the correct answer
 *   1 = a production path gave the WRONG answer — this is the finding
 *   2 = INCONCLUSIVE: prerequisite absent, database unreachable, control sweep
 *       deleted zero rows (anti-vacuity floor), or too few paths exercised.
 *       Never read as a pass.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

/**
 * Inlined from reset-scratch-db.mjs — importing that module directly would
 * trigger its own --self-test handler at module evaluation time when this
 * script is invoked with --self-test, running the wrong test suite.
 *
 * The allowlist rule (name must contain "scratch") is intentional and matches
 * the original. See reset-scratch-db.mjs header for the rationale.
 */
function assertScratchTarget(scratchUrl) {
  let parsed;
  try {
    parsed = new URL(scratchUrl);
  } catch {
    return { ok: false, reason: "SCRATCH_DATABASE_URL is not a parseable URL" };
  }
  const database = parsed.pathname.replace(/^\//, "").split("?")[0];
  if (!/scratch/i.test(database))
    return {
      ok: false,
      reason:
        `refusing to run against database "${database}" — SCRATCH_DATABASE_URL must name a ` +
        `scratch database (name must contain "scratch"). This drill commits and deletes data.`,
    };
  return { ok: true, database, label: `${parsed.hostname}:${parsed.port || "5432"}/${database}` };
}

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TS_NODE_BASE = path.join(BACKEND_ROOT, "node_modules", ".bin", "ts-node");
const TS_NODE = process.platform === "win32" ? `${TS_NODE_BASE}.CMD` : TS_NODE_BASE;
const PROBE = path.join(BACKEND_ROOT, "src", "scripts", "retention-drill-probe.ts");

/**
 * Anti-vacuity floors.
 *
 * A drill that asserted nothing must report INCONCLUSIVE, never a pass.
 * MIN_CHECKS and MIN_PRODUCTION_PATHS together require several distinct product
 * methods to have answered. REQUIRED_PHASES is the one that matters most: drop
 * the control phase and the drill can no longer tell "hold blocked it" from
 * "nothing works".
 */
const MIN_CHECKS = 14;
const MIN_PRODUCTION_PATHS = 4;
const REQUIRED_PHASES = ["control", "held", "isolated", "idempotent", "batch"];

const argv = process.argv.slice(2);
const selfTest = argv.includes("--self-test");

function haveTsNode() {
  return existsSync(TS_NODE) || existsSync(TS_NODE_BASE);
}

function runProbe(probeArgs) {
  const dir = mkdtempSync(path.join(tmpdir(), "retention-drill-"));
  const out = path.join(dir, "report.json");
  try {
    execFileSync(TS_NODE, ["--transpile-only", PROBE, ...probeArgs, `--out=${out}`], {
      cwd: BACKEND_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
      shell: process.platform === "win32",
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
    const line =
      `${check.phase.toUpperCase().padEnd(10)} ${check.productionPath}\n` +
      `             expected ${check.expected}\n` +
      `             observed ${check.observed}`;
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

function redactedLabel(scratchUrl) {
  const result = assertScratchTarget(scratchUrl);
  return result.ok ? result.label : "(unparseable)";
}

function sha256(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

function finish(code) {
  process.exit(code);
}

if (!haveTsNode()) {
  process.stderr.write(
    `INCONCLUSIVE — ts-node is not installed at ${TS_NODE}. ` +
      "No production code was loaded. This is exit 2, not a pass.\n",
  );
  finish(2);
}

if (selfTest) {
  /**
   * Self-test verifies two things without a database:
   *
   *   1. SYMBOL EXISTENCE: every product class method the drill claims to call
   *      is still present under that name. A rename that silently detaches the
   *      drill from the product fails here.
   *
   *   2. ANTI-VACUITY LOGIC: `assessControlDeletion(0, N)` must return
   *      ok=false. If this function were broken to always return ok=true, the
   *      control phase would accept a sweep that deleted nothing as a pass —
   *      and the drill would certify a broken product.
   *
   * The second check is what "the self-test bites" means in practice: break
   * `assessControlDeletion` to return ok=true regardless of `deleted`, run
   * --self-test, observe FAIL naming the anti-vacuity path, then restore.
   */
  console.log("\n=== RETENTION DRILL — self-test (no database) ===\n");
  const report = runProbe(["--contract"]);
  if (!report || !Array.isArray(report.checks) || report.checks.length === 0) {
    process.stderr.write("INCONCLUSIVE — probe reported no production surface. Exit 2.\n");
    finish(2);
  }
  const { passed, failed } = render(report.checks);
  console.log(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed) ===`);
  finish(failed > 0 ? 1 : 0);
}

const scratchUrl = process.env.SCRATCH_DATABASE_URL;
if (!scratchUrl) {
  process.stderr.write(
    "INCONCLUSIVE — SCRATCH_DATABASE_URL is not set. No production path was exercised. Exit 2.\n",
  );
  finish(2);
}

const guard = assertScratchTarget(scratchUrl);
if (!guard.ok) {
  process.stderr.write(`INCONCLUSIVE — ${guard.reason}\n`);
  finish(2);
}

const orgAArg = argv.find((a) => a.startsWith("--org-a="))?.slice("--org-a=".length)?.trim();
const orgBArg = argv.find((a) => a.startsWith("--org-b="))?.slice("--org-b=".length)?.trim();

if (!orgAArg || !orgBArg) {
  process.stderr.write(
    "INCONCLUSIVE — usage: node drill-retention.mjs --org-a=<id> --org-b=<id>. " +
      "Both orgs must exist in the scratch database. Exit 2.\n",
  );
  finish(2);
}

console.log(`\n=== RETENTION DRILL against ${guard.label} ===`);
console.log(`    org-a=${orgAArg}  org-b=${orgBArg}`);
console.log("    Every verdict below is a real service method's answer.\n");

const report = runProbe([`--org-a=${orgAArg}`, `--org-b=${orgBArg}`]);

if (!report) {
  process.stderr.write("INCONCLUSIVE — probe produced no report. Exit 2.\n");
  finish(2);
}

if (report.error) {
  process.stderr.write(`INCONCLUSIVE — ${report.error}\n`);
  finish(2);
}

const checks = Array.isArray(report.checks) ? report.checks : [];
const phases = new Set(checks.map((c) => c.phase));
const paths = new Set(checks.map((c) => c.productionPath));
const missingPhases = REQUIRED_PHASES.filter((p) => !phases.has(p));

const { passed, failed } = render(checks);

console.log("\n--- Evidence bundle (no credentials) ---");
console.log(`    database : ${guard.label}`);
console.log(`    org-a    : ${orgAArg}    org-b: ${orgBArg}`);
console.log(`    checks   : ${checks.length}    paths: ${paths.size}    phases: ${[...phases].sort().join(", ")}`);
console.log(`    result   : ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed)`);
console.log(`    sha256   : ${sha256(report)}`);

if (checks.length < MIN_CHECKS || paths.size < MIN_PRODUCTION_PATHS || missingPhases.length > 0) {
  process.stderr.write(
    `INCONCLUSIVE — covered ${checks.length} check(s) across ${paths.size} path(s) ` +
      `(floors: ${MIN_CHECKS} and ${MIN_PRODUCTION_PATHS})` +
      (missingPhases.length > 0 ? `; missing phases: ${missingPhases.join(", ")}` : "") +
      ". Too little of the contract was exercised to call this a pass. Exit 2.\n",
  );
  finish(2);
}

console.log(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed) ===`);
console.log(`    ${paths.size} production paths across ${[...phases].sort().join(", ")} phases.\n`);
finish(failed > 0 ? 1 : 0);
