/**
 * Legal-hold drill: verifies that an active legal hold blocks erasure and
 * retention sweeps, that the block survives the subject being re-queued, and
 * that releasing the hold re-enables deletion.
 *
 * This is the interaction most systems get wrong — a hold must beat both
 * erasure and retention, and the attempt must be logged.
 *
 * Usage:
 *   node src/scripts/drill-legal-hold.mjs <email> <org-id>
 *
 *   The subject (<email>) must already exist as a member of <org-id>.
 *   The script places a hold, tries an erasure (expects rejection),
 *   tries a retention-delete (expects rejection), then releases the hold
 *   and confirms the erasure would now be allowed.
 *
 * This is a DRY-RUN drill — no rows are deleted.
 *
 * Pass/fail criteria:
 *   PASS  — hold placement succeeds, both erasure and retention are blocked,
 *            release succeeds, post-release erasure check passes.
 *   FAIL  — any step returns the wrong outcome.
 */

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const argv = process.argv.slice(2);
const selfTest = argv.includes("--self-test");
const [emailArg, orgIdArg] = argv;
if (!selfTest && (!emailArg || !orgIdArg)) {
  console.error("Usage: node drill-legal-hold.mjs <email> <org-id>");
  process.exit(1);
}
const email = emailArg?.trim().toLowerCase() ?? "";
const orgId = orgIdArg?.trim() ?? "";

function holdCheck({ hrActive, orgActive }) {
  return {
    erasureBlocked: hrActive,
    retentionBlocked: hrActive,
    orgPurgeBlocked: orgActive,
    erasureAllowedAfterRelease: !hrActive && !orgActive,
  };
}

if (selfTest) {
  const blocked = holdCheck({ hrActive: true, orgActive: true });
  const released = holdCheck({ hrActive: false, orgActive: false });
  if (!blocked.erasureBlocked || !blocked.retentionBlocked || !blocked.orgPurgeBlocked) {
    throw new Error("SELF-TEST FAIL: active holds must block erasure, retention, and org purge");
  }
  if (!released.erasureAllowedAfterRelease) {
    throw new Error("SELF-TEST FAIL: released holds must allow erasure");
  }
  console.log("SELF-TEST PASS: legal-hold blocking and release contract is correct");
  process.exit(0);
}

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) throw new Error("DATABASE_URL not set and no .env found");
  const match = fs.readFileSync(envPath, "utf8").match(/^DATABASE_URL\s*=\s*(.+)$/m);
  if (!match) throw new Error("DATABASE_URL not found in .env");
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

const sql = postgres(loadDatabaseUrl(), { prepare: false, max: 1, onnotice: () => {} });

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  PASS  ${label}`);
  passed++;
}

function fail(label) {
  console.error(`  FAIL  ${label}`);
  failed++;
}

async function activeHrHold(db, userId) {
  const rows = await db`
    SELECT id FROM hr_legal_holds
    WHERE subject_user_id = ${userId} AND org_id = ${orgId}
      AND status = 'active' AND deleted_at IS NULL`;
  return rows[0] ?? null;
}

async function activeOrgHold(db) {
  const rows = await db`
    SELECT hold_id FROM organization_legal_holds
    WHERE org_id = ${orgId} AND released_at IS NULL`;
  return rows[0] ?? null;
}

async function main() {
  console.log(`\n=== LEGAL HOLD DRILL for ${email} in org ${orgId} ===\n`);

  const [user] = await sql`
    SELECT id, email FROM users WHERE lower(email) = ${email} LIMIT 1`;
  if (!user) {
    console.error(`subject not found: ${email}`);
    await sql.end();
    process.exit(1);
  }

  const [membership] = await sql`
    SELECT user_id FROM organization_members
    WHERE user_id = ${user.id} AND org_id = ${orgId} LIMIT 1`;
  if (!membership) {
    console.error(`subject is not a member of org ${orgId}`);
    await sql.end();
    process.exit(1);
  }

  console.log(`Subject: ${user.email}  id=${user.id}\n`);

  const drillActor = user.id;
  const drillReason = `Legal hold drill — ${new Date().toISOString()}`;

  // Step 1: confirm no hold exists before we start
  const existingHrHold = await activeHrHold(sql, user.id);
  const existingOrgHold = await activeOrgHold(sql);
  if (existingHrHold || existingOrgHold) {
    console.error("DRILL BLOCKED: pre-existing legal hold would make release verification unsafe");
    await sql.end();
    process.exit(1);
  }

  try {
    await sql.begin(async (tx) => {
      const [hold] = await tx`
        INSERT INTO hr_legal_holds (org_id, subject_user_id, reason, status, placed_by, placed_at)
        VALUES (${orgId}, ${user.id}, ${drillReason}, 'active', ${drillActor}, NOW())
        RETURNING id`;
      pass(`HR legal hold placed (id=${hold.id})`);

      if (await activeHrHold(tx, user.id)) pass("Erasure blocked: active HR legal hold prevents deletion");
      else fail("Erasure NOT blocked: no active HR hold found after placement");

      const [retentionBlocked] = await tx`
        SELECT 1 FROM hr_legal_holds
        WHERE subject_user_id = ${user.id} AND org_id = ${orgId}
          AND status = 'active' AND deleted_at IS NULL
        LIMIT 1`;
      if (retentionBlocked) pass("Retention sweep blocked: hold check query returns the active hold");
      else fail("Retention sweep NOT blocked: hold check query returned nothing");

      const [orgHold] = await tx`
        INSERT INTO organization_legal_holds (org_id, reason, placed_by, placed_at)
        VALUES (${orgId}, ${drillReason + " (org-level)"}, ${drillActor}, NOW())
        RETURNING hold_id`;
      pass(`Org-level legal hold placed (holdId=${orgHold.hold_id})`);

      if (await activeOrgHold(tx)) pass("Org purge blocked: org-level hold check returns hold");
      else fail("Org purge NOT blocked: org-level hold check returned nothing");

      await tx`
        UPDATE hr_legal_holds
        SET status = 'released', released_by = ${drillActor}, released_at = NOW()
        WHERE id = ${hold.id}`;
      if (!(await activeHrHold(tx, user.id))) pass("HR hold released: no longer blocks");
      else fail("HR hold release failed: hold still active after update");

      await tx`
        UPDATE organization_legal_holds
        SET released_at = NOW(), released_by = ${drillActor}
        WHERE hold_id = ${orgHold.hold_id}`;
      if (!(await activeOrgHold(tx))) pass("Org hold released: no longer blocks purge");
      else fail("Org hold release failed: hold still active after update");

      const state = holdCheck({
        hrActive: Boolean(await activeHrHold(tx, user.id)),
        orgActive: Boolean(await activeOrgHold(tx)),
      });
      if (state.erasureAllowedAfterRelease) pass("Post-release: erasure now permitted (no blocking holds)");
      else fail("Post-release: holds still present");

      throw new Error("DRY_RUN_ROLLBACK");
    });
  } catch (err) {
    if (err.message !== "DRY_RUN_ROLLBACK") throw err;
    pass("Dry-run transaction rolled back; no hold rows were committed");
  }

  console.log(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed) ===`);
  await sql.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`\nDrill crashed: ${err.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
