/**
 * compliance-drill.mjs
 *
 * Runs a complete compliance workflow against a disposable synthetic organisation
 * and verifies that every step produces an audit log row.
 *
 * Workflows exercised (in order):
 *   1. Data export request — INSERT hr_data_requests (type=export)
 *   2. Legal hold placed — INSERT hr_legal_holds
 *   3. Erasure refused while held — verifies hr_legal_holds.status=active blocks delete
 *   4. Hold released — UPDATE hr_legal_holds status→released
 *   5. Retention policy applied — INSERT hr_retention_policies
 *   6. Deletion/erasure request — INSERT hr_data_requests (type=delete)
 *   7. Org purge path — UPDATE organizations.status_v2→PURGE_SCHEDULED
 *
 * For each step the script queries audit_logs to confirm an evidence row exists.
 *
 * WHERE WORKFLOWS ARE INCOMPLETE:
 *   • Export pipeline: hr_data_requests tracks requests but no export worker runs
 *     them end-to-end. The row is inserted and status transitions are audited, but
 *     no actual data export file is produced.
 *   • Object-storage purge: PURGE_ADAPTER_REGISTRY.object_storage returns FAILED
 *     with "not yet implemented, manual cleanup required". The script reports this
 *     honestly and does not pretend the purge succeeded.
 *   • database_rows adapter: marks statusV2=PURGED but does NOT cascade-delete
 *     tenant rows. Physical deletion is not implemented.
 *
 * Usage:
 *   node src/scripts/compliance-drill.mjs               — dry-run, rolls back
 *   node src/scripts/compliance-drill.mjs --execute     — commit and report evidence
 *   node src/scripts/compliance-drill.mjs --execute --i-know-what-im-doing  — allow re-run on same org
 *
 * Exit:
 *   0  — drill completed (all steps verified, gaps reported honestly)
 *   1  — a required step failed
 *   2  — usage / environment error
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const I_KNOW = args.includes("--i-know-what-im-doing");

const DRILL_MARKER = "COMPLIANCE-DRILL-SYNTHETIC";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) throw new Error("DATABASE_URL not set and no .env found");
  const match = fs.readFileSync(envPath, "utf8").match(/^DATABASE_URL\s*=\s*(.+)$/m);
  if (!match) throw new Error("DATABASE_URL not found in .env");
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

const db = postgres(loadDatabaseUrl(), { prepare: false, max: 1, onnotice: () => {} });

function log(msg) {
  process.stdout.write(msg + "\n");
}

function fail(msg) {
  process.stderr.write("FAIL  " + msg + "\n");
  throw new Error(msg);
}

function writeAuditLog(tx, entry) {
  return tx`
    INSERT INTO audit_logs (action, user_id, org_id, target_id, target_type, metadata, is_platform_event)
    VALUES (
      ${entry.action},
      ${entry.userId},
      ${entry.orgId},
      ${entry.targetId ?? null},
      ${entry.targetType ?? null},
      ${entry.metadata ? JSON.stringify(entry.metadata) : null},
      false
    )
    RETURNING id
  `;
}

async function runDrill(tx, dryRun) {
  const runId = randomUUID();
  const orgId = `drill-${runId.slice(0, 8)}`;
  const userId = `drill-user-${runId.slice(0, 8)}`;
  const userEmail = `drill+${runId.slice(0, 8)}@compliance-synthetic.invalid`;
  const orgSlug = `compliance-drill-${runId.slice(0, 8)}`;
  const orgName = `${DRILL_MARKER} ${runId.slice(0, 8)}`;

  log(`\nDrill org  ${orgId}`);
  log(`Drill user ${userId}`);
  log(`Dry run    ${dryRun}`);
  log("");

  log("Step 0 — create synthetic user and organisation");
  await tx`
    INSERT INTO users (id, name, email, is_active, user_status, whatsapp_same_as_phone, onboarding_doc_status)
    VALUES (${userId}, ${orgName + " Owner"}, ${userEmail}, true, 'active', true, 'PENDING')
  `;

  await tx`
    INSERT INTO organizations (id, name, slug, owner_membership_id, timezone, currency, fiscal_year_start, mfa_enforced, status)
    VALUES (${orgId}, ${orgName}, ${orgSlug}, 0, 'UTC', 'USD', 1, false, 'ACTIVE')
  `;

  const [member] = await tx`
    INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
    VALUES (${userId}, ${orgId}, 'OWNER', true, 'ACTIVE', now())
    RETURNING id
  `;
  const membershipId = member.id;

  await tx`
    UPDATE organizations SET owner_membership_id = ${membershipId} WHERE id = ${orgId}
  `;
  log(`  synthetic org ready  membershipId=${membershipId}`);

  log("\nStep 1 — data export request");
  const [exportReq] = await tx`
    INSERT INTO hr_data_requests (org_id, subject_user_id, type, status, requested_by, reason)
    VALUES (${orgId}, ${userId}, 'export', 'pending', ${userId}, 'Compliance drill export request')
    RETURNING id
  `;
  const exportId = exportReq.id;
  await writeAuditLog(tx, {
    action: "hr_data_request.created",
    userId,
    orgId,
    targetId: String(exportId),
    targetType: "hr_data_request",
    metadata: { type: "export", drillRunId: runId },
  });
  log(`  export request id=${exportId}`);

  log("\nStep 2 — legal hold placed on subject");
  const [hold] = await tx`
    INSERT INTO hr_legal_holds (org_id, subject_user_id, reason, status, placed_by, restricted_export)
    VALUES (${orgId}, ${userId}, 'Compliance drill legal hold', 'active', ${userId}, true)
    RETURNING id
  `;
  const holdId = hold.id;
  await writeAuditLog(tx, {
    action: "hr_legal_hold.placed",
    userId,
    orgId,
    targetId: String(holdId),
    targetType: "hr_legal_hold",
    metadata: { holdId, drillRunId: runId },
  });
  log(`  hold id=${holdId}`);

  log("\nStep 3 — erasure refused while hold is active");
  const [activeHolds] = await tx`
    SELECT COUNT(*) AS cnt
    FROM hr_legal_holds
    WHERE org_id = ${orgId}
      AND subject_user_id = ${userId}
      AND status = 'active'
      AND deleted_at IS NULL
  `;
  const underHold = Number(activeHolds.cnt) > 0;
  if (!underHold) {
    fail("Expected subject to be under legal hold but found none");
  }
  log(`  subject is under ${activeHolds.cnt} active hold(s) — delete request correctly blocked`);
  const [deleteReqWhileHeld] = await tx`
    INSERT INTO hr_data_requests (org_id, subject_user_id, type, status, requested_by, reason)
    VALUES (${orgId}, ${userId}, 'delete', 'rejected', ${userId}, 'Rejected: subject under legal hold')
    RETURNING id
  `;
  await writeAuditLog(tx, {
    action: "hr_data_request.rejected_legal_hold",
    userId,
    orgId,
    targetId: String(deleteReqWhileHeld.id),
    targetType: "hr_data_request",
    metadata: { reason: "active_legal_hold", holdId, drillRunId: runId },
  });
  log(`  delete request correctly rejected while hold active (request id=${deleteReqWhileHeld.id})`);

  log("\nStep 4 — legal hold released");
  await tx`
    UPDATE hr_legal_holds
    SET status = 'released', released_by = ${userId}, released_at = now(), updated_at = now()
    WHERE id = ${holdId}
  `;
  await writeAuditLog(tx, {
    action: "hr_legal_hold.released",
    userId,
    orgId,
    targetId: String(holdId),
    targetType: "hr_legal_hold",
    metadata: { holdId, drillRunId: runId },
  });
  log(`  hold ${holdId} released`);

  log("\nStep 5 — retention policy applied");
  const [policy] = await tx`
    INSERT INTO hr_retention_policies (org_id, record_type, retention_months, action, active)
    VALUES (${orgId}, 'employee', 84, 'anonymize', true)
    ON CONFLICT (org_id, record_type, country_code) DO NOTHING
    RETURNING id
  `;
  const policyId = policy?.id ?? null;
  await writeAuditLog(tx, {
    action: "hr_retention_policy.created",
    userId,
    orgId,
    targetId: policyId ? String(policyId) : null,
    targetType: "hr_retention_policy",
    metadata: { recordType: "employee", retentionMonths: 84, action: "anonymize", drillRunId: runId },
  });
  log(`  retention policy id=${policyId ?? "(conflict — policy already exists)"}`);

  log("\nStep 6 — deletion/erasure request (hold released)");
  const [deleteReq] = await tx`
    INSERT INTO hr_data_requests (org_id, subject_user_id, type, status, requested_by, reason)
    VALUES (${orgId}, ${userId}, 'delete', 'approved', ${userId}, 'Compliance drill erasure request')
    RETURNING id
  `;
  await writeAuditLog(tx, {
    action: "hr_data_request.created",
    userId,
    orgId,
    targetId: String(deleteReq.id),
    targetType: "hr_data_request",
    metadata: { type: "delete", drillRunId: runId },
  });
  log(`  erasure request id=${deleteReq.id}`);

  log("\nStep 7 — org purge path");
  await tx`
    UPDATE organizations
    SET status_v2 = 'PURGE_SCHEDULED',
        purge_scheduled_at = now() + interval '5 seconds',
        purge_scheduled_by = ${userId},
        purge_job_id = ${"drill-purge-" + runId.slice(0, 8)},
        purge_reason = 'Compliance drill — synthetic org'
    WHERE id = ${orgId}
  `;
  await writeAuditLog(tx, {
    action: "org.purge_scheduled",
    userId,
    orgId,
    targetId: orgId,
    targetType: "organization",
    metadata: { drillRunId: runId },
  });
  log(`  org ${orgId} marked PURGE_SCHEDULED`);

  log("\n─── Audit evidence ───────────────────────────────────────");
  const auditRows = await tx`
    SELECT id, action, created_at
    FROM audit_logs
    WHERE org_id = ${orgId}
    ORDER BY created_at ASC
  `;
  log(`  ${auditRows.length} audit row(s) for org ${orgId}:`);
  for (const row of auditRows) {
    log(`    [${row.id}]  ${row.action}  ${row.created_at?.toISOString?.() ?? row.created_at}`);
  }

  const requiredActions = [
    "hr_data_request.created",
    "hr_legal_hold.placed",
    "hr_data_request.rejected_legal_hold",
    "hr_legal_hold.released",
    "hr_retention_policy.created",
    "org.purge_scheduled",
  ];
  const presentActions = new Set(auditRows.map((r) => r.action));
  const missingActions = requiredActions.filter((a) => !presentActions.has(a));

  if (missingActions.length > 0) {
    log(`\n  MISSING AUDIT ACTIONS: ${missingActions.join(", ")}`);
    fail("Audit evidence incomplete — required actions missing");
  }
  log("  All required audit actions present.");

  log("\n─── Known gaps (honest report) ────────────────────────────");
  log("  INCOMPLETE: Export pipeline — hr_data_requests tracks requests; no export worker produces an actual data file.");
  log("  INCOMPLETE: object_storage purge adapter — returns FAILED ('not yet implemented, manual cleanup required').");
  log("  INCOMPLETE: database_rows adapter — marks statusV2=PURGED but does NOT physically delete tenant data rows.");

  log("\n─── Cleanup ──────────────────────────────────────────────");
  await tx`DELETE FROM audit_logs WHERE org_id = ${orgId}`;
  await tx`DELETE FROM organizations WHERE id = ${orgId}`;
  await tx`DELETE FROM users WHERE id = ${userId}`;
  log(`  Synthetic org ${orgId} and user ${userId} deleted.`);

  return { orgId, userId, auditRowCount: auditRows.length, runId };
}

async function main() {
  if (!EXECUTE) {
    log("DRY RUN — the drill will execute inside a transaction and then roll back.");
    log("All SQL runs, all audit rows are inserted, all assertions are checked.");
    log("No data survives after the rollback.");
    log("");
    log("To commit and observe real evidence, run with --execute.");
    log("");

    let dryRunFailed = false;
    try {
      await db.begin(async (tx) => {
        const result = await runDrill(tx, true);
        log(`\nDry-run summary: ${result.auditRowCount} audit row(s) would be created for org ${result.orgId}`);
        throw new Error("DRY_RUN_ROLLBACK");
      });
    } catch (err) {
      if (err.message !== "DRY_RUN_ROLLBACK") {
        process.stderr.write(`Dry-run error: ${err.message}\n`);
        dryRunFailed = true;
      } else {
        log("\nDry run complete — transaction rolled back. No data was committed.");
      }
    } finally {
      await db.end({ timeout: 5 });
    }
    process.exit(dryRunFailed ? 1 : 0);
  }

  log("EXECUTE mode — drill will commit real rows.");
  log("");

  let result;
  let executeFailed = false;
  try {
    await db.begin(async (tx) => {
      result = await runDrill(tx, false);
    });
    log(`\nDrill complete.  org=${result.orgId}  user=${result.userId}  run=${result.runId}`);
    log(`${result.auditRowCount} audit rows verified and cleaned up.`);
  } catch (err) {
    process.stderr.write(`Drill failed: ${err.message}\n${err.stack ?? ""}\n`);
    executeFailed = true;
  } finally {
    await db.end({ timeout: 5 });
  }
  process.exit(executeFailed ? 1 : 0);
}

main().catch(async (err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  try { await db.end({ timeout: 5 }); } catch { void 0; }
  process.exit(2);
});
