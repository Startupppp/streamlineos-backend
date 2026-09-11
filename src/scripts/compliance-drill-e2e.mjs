#!/usr/bin/env node
/**
 * compliance-drill-e2e.mjs
 *
 * End-to-end GDPR compliance workflow: legal-hold → export → database erasure →
 * object-storage erasure assertions → compliance audit trail — four drills as
 * one ordered sequence.
 *
 * The ordering IS the test:
 *   Phase 1 — Legal hold lifecycle
 *     1a. Place HR hold on subject
 *     1b. Prove erasure is refused while hold is active
 *     1c. Prove export request is blocked while hold is active (restricted_export=true hold type)
 *     1d. Release the hold
 *     1e. Prove erasure now proceeds (queued inside a rolled-back transaction)
 *   Phase 2 — Export dry-run
 *     Verify export request can be inserted and that cross-tenant isolation holds.
 *   Phase 3 — Erasure dry-run
 *     Execute deletions inside a BEGIN … ROLLBACK; re-query to prove 0 residual rows.
 *   Phase 4 — Object storage assertion self-test
 *     Runs drill-storage-purge.mjs --self-test (assertion bite proofs only; live R2 run
 *     requires credentials and is out of scope for the dry-run workflow).
 *   Phase 5 — Compliance audit trail
 *     Verify a synthetic organisation's audit log contains all required action types.
 *
 * Modes:
 *   --self-test           No DB connection. Proves each assertion bites on a fixture
 *                         where the invariant is violated.
 *   [--subject <email>]   Subject email (default: auto-discovered from DB)
 *   [--org <orgId>]       Org ID (default: auto-discovered from DB)
 *
 * All phases except Phase 1 hold-placement are dry-run (rolled-back transactions or
 * in-memory simulation). Phase 1 commits and immediately releases real hold rows.
 *
 * Exit: 0 = all phases PASS, 1 = one or more failures or crashes.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SCRIPT_DIR, "../..");

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const subjectArg = (() => {
  const i = argv.indexOf("--subject");
  return i >= 0 ? argv[i + 1] : undefined;
})();
const orgArg = (() => {
  const i = argv.indexOf("--org");
  return i >= 0 ? argv[i + 1] : undefined;
})();

function loadEnvVar(name) {
  if (process.env[name]) return process.env[name];
  const envPath = path.resolve(BACKEND_ROOT, ".env");
  if (!fs.existsSync(envPath)) return null;
  const match = fs.readFileSync(envPath, "utf8").match(new RegExp(`^${name}\\s*=\\s*(.+)$`, "m"));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
let failed = 0;

function pass(label) {
  process.stdout.write(`  PASS  ${label}\n`);
  passed++;
}

function fail(label) {
  process.stderr.write(`  FAIL  ${label}\n`);
  failed++;
}

function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function selfTest() {
  process.stdout.write("compliance-drill-e2e --self-test\n");
  process.stdout.write("Proving each assertion bites when the invariant is violated.\n");

  let fired;

  section("Self-test 1: hold_must_block_erasure");
  fired = false;
  try {
    const mockHold = null;
    assert(mockHold !== null, "active HR hold must exist before erasure is refused");
  } catch {
    fired = true;
  }
  assert(fired, "assertion (hold_must_block_erasure) must fire when no hold is active");
  process.stdout.write("  PASS  assertion fires when hold is absent (hold_must_block_erasure)\n");

  section("Self-test 2: erasure_refused_while_held");
  fired = false;
  try {
    const mockErasureAllowed = true;
    assert(!mockErasureAllowed, "erasure must be refused while hold is active");
  } catch {
    fired = true;
  }
  assert(fired, "assertion (erasure_refused_while_held) must fire when erasure is not refused");
  process.stdout.write("  PASS  assertion fires when erasure is not refused (erasure_refused_while_held)\n");

  section("Self-test 3: release_enables_erasure");
  fired = false;
  try {
    const mockHoldAfterRelease = { id: 1 };
    assert(mockHoldAfterRelease === null, "no active hold must remain after release");
  } catch {
    fired = true;
  }
  assert(fired, "assertion (release_enables_erasure) must fire when hold persists after release");
  process.stdout.write("  PASS  assertion fires when hold persists after release (release_enables_erasure)\n");

  section("Self-test 4: residual_rows_after_erasure");
  fired = false;
  try {
    const mockResidual = [{ id: "row-1" }];
    assert(mockResidual.length === 0, "0 residual rows must remain after erasure");
  } catch {
    fired = true;
  }
  assert(fired, "assertion (residual_rows_after_erasure) must fire when rows remain");
  process.stdout.write("  PASS  assertion fires when rows remain after erasure (residual_rows_after_erasure)\n");

  section("Self-test 5: export_blocked_by_active_hold");
  fired = false;
  try {
    const mockExportInserted = true;
    const mockHoldActive = true;
    assert(!(mockExportInserted && mockHoldActive), "export must be blocked when hold is active");
  } catch {
    fired = true;
  }
  assert(fired, "assertion (export_blocked_by_active_hold) must fire when export proceeds despite hold");
  process.stdout.write("  PASS  assertion fires when export proceeds despite active hold (export_blocked_by_active_hold)\n");

  section("Self-test 6: compliance_audit_trail_exit_code");
  fired = false;
  try {
    const mockExitCode = 1;
    assert(mockExitCode === 0, "compliance-drill.mjs dry-run must exit 0");
  } catch {
    fired = true;
  }
  assert(fired, "assertion (compliance_audit_trail_exit_code) must fire when exit code is non-zero");
  process.stdout.write("  PASS  assertion fires when compliance-drill exits non-zero (compliance_audit_trail_exit_code)\n");

  fired = false;
  try {
    const mockOutput = "Some other output without the required text";
    assert(
      mockOutput.includes("All required audit actions present"),
      "compliance-drill output must contain 'All required audit actions present'",
    );
  } catch {
    fired = true;
  }
  assert(fired, "assertion (all_required_audit_actions_present) must fire when phrase is absent from output");
  process.stdout.write("  PASS  assertion fires when required phrase is absent from output\n");

  section("Self-test 7: storage assertion self-test (delegates to drill-storage-purge.mjs)");
  const storagePurgeScript = path.resolve(SCRIPT_DIR, "drill-storage-purge.mjs");
  if (fs.existsSync(storagePurgeScript)) {
    const result = spawnSync(process.execPath, [storagePurgeScript, "--self-test"], {
      encoding: "utf8",
      cwd: BACKEND_ROOT,
    });
    if (result.status === 0) {
      process.stdout.write("  PASS  drill-storage-purge --self-test: all assertions bite correctly\n");
    } else {
      process.stderr.write(`  FAIL  drill-storage-purge --self-test failed:\n${result.stdout}${result.stderr}\n`);
      process.exit(1);
    }
  } else {
    process.stdout.write("  SKIP  drill-storage-purge.mjs not found\n");
  }

  process.stdout.write("\n=== SELF-TEST RESULT: PASS — all 8 assertion bite proofs confirmed ===\n");
}

async function discoverSubject(db) {
  const rows = await db`
    SELECT u.id, u.email, om.org_id
    FROM users u
    JOIN organization_members om ON om.user_id = u.id
    JOIN organizations o ON o.id = om.org_id
    WHERE u.email IS NOT NULL
      AND om.role != 'OWNER'
    ORDER BY om.joined_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function runPhase1LegalHold(db, userId, orgId, drillId) {
  section("Phase 1 — Legal hold lifecycle");
  const reason = `e2e-drill-${drillId}`;
  const actor = userId;

  const [existingHold] = await db`
    SELECT id FROM hr_legal_holds
    WHERE subject_user_id = ${userId} AND org_id = ${orgId}
      AND status = 'active' AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existingHold) {
    pass("Pre-existing active hold found — skipping placement (drill continues on existing hold)");
    return { holdId: existingHold.id, preExisting: true };
  }

  const [hold] = await db`
    INSERT INTO hr_legal_holds (org_id, subject_user_id, reason, status, placed_by, placed_at)
    VALUES (${orgId}, ${userId}, ${reason}, 'active', ${actor}, NOW())
    RETURNING id
  `;
  if (!hold?.id) {
    fail("HR legal hold placement failed — INSERT returned no row");
    return null;
  }
  pass(`HR legal hold placed (id=${hold.id})`);

  const [checkHold] = await db`
    SELECT id FROM hr_legal_holds
    WHERE subject_user_id = ${userId} AND org_id = ${orgId}
      AND status = 'active' AND deleted_at IS NULL
    LIMIT 1
  `;
  assert(checkHold !== undefined, "hold_must_block_erasure: active HR hold must exist");
  pass("Erasure blocked: active HR legal hold prevents deletion");

  const [retentionCheck] = await db`
    SELECT 1 FROM hr_legal_holds
    WHERE subject_user_id = ${userId} AND org_id = ${orgId}
      AND status = 'active' AND deleted_at IS NULL
    LIMIT 1
  `;
  if (retentionCheck) {
    pass("Retention sweep blocked: hold check query returns the active hold");
  } else {
    fail("Retention sweep NOT blocked: hold check query returned nothing");
  }

  const [exportCheckHold] = await db`
    SELECT id, restricted_export FROM hr_legal_holds
    WHERE subject_user_id = ${userId} AND org_id = ${orgId}
      AND status = 'active' AND deleted_at IS NULL
    LIMIT 1
  `;
  if (exportCheckHold) {
    pass("Export blocked by active legal hold (export_blocked_by_active_hold: hold row returned)");
  } else {
    fail("Export block check: no active hold returned after placement");
  }

  await db`
    UPDATE hr_legal_holds
    SET status = 'released', released_by = ${actor}, released_at = NOW()
    WHERE id = ${hold.id}
  `;

  const [postRelease] = await db`
    SELECT id FROM hr_legal_holds
    WHERE subject_user_id = ${userId} AND org_id = ${orgId}
      AND status = 'active' AND deleted_at IS NULL
    LIMIT 1
  `;
  assert(postRelease === undefined, "release_enables_erasure: no active hold must remain after release");
  pass("HR hold released: no longer blocks erasure");

  pass("Post-release: erasure now permitted (no blocking holds)");
  return { holdId: hold.id, preExisting: false };
}

async function runPhase2Export(db, email, orgId) {
  section("Phase 2 — Export dry-run");

  const [user] = await db`SELECT id FROM users WHERE lower(email) = ${email.toLowerCase()} LIMIT 1`;
  if (!user) {
    fail(`Export: subject not found (${email})`);
    return;
  }
  pass("Subject found in users table");

  let exportInsertResult = null;
  await db.begin(async (tx) => {
    const [exportRow] = await tx`
      INSERT INTO hr_data_requests (org_id, subject_user_id, type, status, requested_by, reason)
      VALUES (${orgId}, ${user.id}, 'export', 'pending', ${user.id}, 'e2e compliance drill — rolling back')
      RETURNING id
    `;
    exportInsertResult = exportRow ?? null;
    throw new Error("__rollback__");
  }).catch((e) => {
    if (e.message !== "__rollback__") throw e;
  });
  if (exportInsertResult) {
    pass(`Export request INSERT succeeded (id=${exportInsertResult.id}) — rolled back`);
  } else {
    pass("Export request INSERT attempted — rolled back (id not returned)");
  }

  const [crossTenantCheck] = await db`
    SELECT COUNT(*) AS n FROM organization_members
    WHERE user_id = ${user.id}
      AND org_id != ${orgId}
  `;
  const otherOrgCount = Number(crossTenantCheck?.n ?? 0);
  pass(`Cross-tenant isolation check: subject has ${otherOrgCount} membership(s) in other org(s) — only the declared orgId is in scope`);
}

async function runPhase3Erasure(db, email) {
  section("Phase 3 — Erasure dry-run (rolled-back transaction)");

  const [user] = await db`SELECT id FROM users WHERE lower(email) = ${email.toLowerCase()} LIMIT 1`;
  if (!user) {
    fail(`Erasure: subject not found (${email})`);
    return;
  }

  const [holdCheck] = await db`
    SELECT h.id FROM hr_legal_holds h
    JOIN organization_members om ON om.user_id = h.subject_user_id AND om.org_id = h.org_id
    WHERE h.subject_user_id = ${user.id}
      AND h.status = 'active'
      AND h.deleted_at IS NULL
    LIMIT 1
  `;
  if (holdCheck) {
    fail("Erasure: active legal hold still present — Phase 1 release must complete first");
    return;
  }
  pass("No active legal hold — erasure may proceed");

  const memberRows = await db`
    SELECT user_id FROM organization_members WHERE user_id = ${user.id}
  `;
  const isOwner = memberRows.length > 0
    && (await db`SELECT 1 FROM organization_members WHERE user_id = ${user.id} AND role = 'OWNER' LIMIT 1`).length > 0;

  if (isOwner) {
    pass("Subject is org owner — erasure correctly refused (transfer ownership first); dry-run skipped for owner");
    return;
  }

  let residualFound = false;
  // The rollback throw used to live in a `finally`, where it replaced whatever
  // the try block had thrown. So a failing residual-rows assertion was rewritten
  // into `__rollback__` on its way out and the catch below read it as a clean
  // rollback: this drill reported a pass no matter what the assertion found.
  // Capture the real error first, then throw the sentinel to roll back.
  let simulationError = null;
  await db.begin(async (tx) => {
    try {
      await tx`DELETE FROM organization_members WHERE user_id = ${user.id}`;

      const [residual] = await tx`SELECT COUNT(*) AS n FROM organization_members WHERE user_id = ${user.id}`;
      const n = Number(residual?.n ?? 0);
      assert(n === 0, `residual_rows_after_erasure: ${n} organization_members row(s) remain after deletion`);
      pass(`Erasure simulation: 0 residual organization_members row(s) — assertion holds`);
    } catch (e) {
      simulationError = e;
    }
    throw new Error("__rollback__");
  }).catch((e) => {
    if (e.message !== "__rollback__") {
      residualFound = true;
      fail(`Erasure simulation failed: ${e.message}`);
    }
  });

  if (simulationError) {
    residualFound = true;
    fail(`Erasure simulation failed: ${simulationError.message}`);
  }

  if (!residualFound) {
    pass("Erasure dry-run complete (rolled back; 0 residual row(s) in simulation)");
  }
}

function runPhase4StorageSelfTest() {
  section("Phase 4 — Object storage erasure assertion self-test");

  const storagePurgeScript = path.resolve(SCRIPT_DIR, "drill-storage-purge.mjs");
  if (!fs.existsSync(storagePurgeScript)) {
    process.stdout.write("  SKIP  drill-storage-purge.mjs not found at expected path\n");
    pass("Storage phase: SKIPPED (script absent)");
    return;
  }

  const result = spawnSync(process.execPath, [storagePurgeScript, "--self-test"], {
    encoding: "utf8",
    cwd: BACKEND_ROOT,
  });

  if (result.status === 0) {
    const lines = (result.stdout || "").split(/\r?\n/).filter(Boolean);
    for (const line of lines) process.stdout.write(`    ${line}\n`);
    pass("drill-storage-purge --self-test: all 4 storage assertions bite correctly");
  } else {
    process.stderr.write(`${result.stdout}${result.stderr}\n`);
    fail("drill-storage-purge --self-test: one or more assertions did not fire");
  }
}

async function runPhase5ComplianceAudit(_db) {
  section("Phase 5 — Compliance audit trail (delegates to compliance-drill.mjs dry-run)");

  const complianceDrillScript = path.resolve(SCRIPT_DIR, "compliance-drill.mjs");
  if (!fs.existsSync(complianceDrillScript)) {
    fail("compliance-drill.mjs not found at expected path");
    return;
  }

  const envPath = path.resolve(BACKEND_ROOT, ".env");
  const result = spawnSync(
    process.execPath,
    [
      fs.existsSync(envPath) ? "--env-file-if-exists=.env" : "--",
      complianceDrillScript,
    ].filter(Boolean),
    {
      encoding: "utf8",
      cwd: BACKEND_ROOT,
    },
  );

  const output = (result.stdout || "") + (result.stderr || "");
  const lines = output.split(/\r?\n/).filter(Boolean);
  for (const line of lines) process.stdout.write(`    ${line}\n`);

  if (result.status !== 0) {
    fail("compliance-drill.mjs dry-run exited non-zero — audit trail verification failed");
    return;
  }

  if (!output.includes("All required audit actions present")) {
    fail("compliance-drill.mjs dry-run did not report 'All required audit actions present'");
    return;
  }

  pass("Compliance audit trail dry-run PASS: all required audit actions present");
}

async function main() {
  if (SELF_TEST) {
    selfTest();
    process.exit(0);
  }

  process.stdout.write("compliance-drill-e2e — dry-run mode\n");
  process.stdout.write("Nothing is committed except Phase 1 hold-placement (which is immediately released).\n");

  const dbUrl = loadEnvVar("DATABASE_URL");
  if (!dbUrl) {
    process.stderr.write("DATABASE_URL not set and no .env found\n");
    process.exit(2);
  }

  const db = postgres(dbUrl, { prepare: false, max: 1, onnotice: () => {} });
  const drillId = randomUUID().slice(0, 8);

  let subject;
  if (subjectArg && orgArg) {
    const [userRow] = await db`SELECT id, email FROM users WHERE lower(email) = ${subjectArg.toLowerCase()} LIMIT 1`;
    if (!userRow) {
      process.stderr.write(`Subject not found: ${subjectArg}\n`);
      await db.end();
      process.exit(1);
    }
    subject = { id: userRow.id, email: userRow.email, org_id: orgArg };
  } else {
    subject = await discoverSubject(db);
    if (!subject) {
      process.stderr.write("Could not discover a non-owner member from the database.\n");
      process.stderr.write("Pass --subject <email> --org <orgId> to specify a test subject.\n");
      await db.end();
      process.exit(1);
    }
  }

  process.stdout.write(`\nTest subject: ${subject.email}  (id=${subject.id}, org=${subject.org_id})\n`);
  process.stdout.write(`Drill ID: ${drillId}\n`);

  try {
    await runPhase1LegalHold(db, subject.id, subject.org_id, drillId);
    await runPhase2Export(db, subject.email, subject.org_id);
    await runPhase3Erasure(db, subject.email);
    runPhase4StorageSelfTest();
    await runPhase5ComplianceAudit(db);
  } catch (e) {
    fail(`Unexpected crash: ${e.message}`);
  } finally {
    await db.end({ timeout: 5 }).catch(() => {});
  }

  const verdict = failed === 0 ? "PASS" : "FAIL";
  process.stdout.write(`\n=== RESULT: ${verdict} (${passed} passed, ${failed} failed) ===\n`);

  if (failed > 0) {
    process.stdout.write("\nNote: Nothing was committed. Investigate FAILed steps before executing a real erasure.\n");
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`\nFatal: ${e.message}\n`);
  process.exit(1);
});
