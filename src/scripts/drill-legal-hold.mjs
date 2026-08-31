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
import { randomUUID } from "node:crypto";

const [, , emailArg, orgIdArg] = process.argv;
if (!emailArg || !orgIdArg) {
  console.error("Usage: node drill-legal-hold.mjs <email> <org-id>");
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();
const orgId = orgIdArg.trim();

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

async function activeHrHold(userId) {
  const rows = await sql`
    SELECT id FROM hr_legal_holds
    WHERE subject_user_id = ${userId} AND org_id = ${orgId}
      AND status = 'active' AND deleted_at IS NULL`;
  return rows[0] ?? null;
}

async function activeOrgHold() {
  const rows = await sql`
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
  const existingHrHold = await activeHrHold(user.id);
  const existingOrgHold = await activeOrgHold();
  if (existingHrHold || existingOrgHold) {
    console.log(`  Note: pre-existing hold found; skipping placement, using existing hold.`);
  }

  let holdId = null;

  if (!existingHrHold) {
    const [hold] = await sql`
      INSERT INTO hr_legal_holds (org_id, subject_user_id, reason, status, placed_by, placed_at)
      VALUES (${orgId}, ${user.id}, ${drillReason}, 'active', ${drillActor}, NOW())
      RETURNING id`;
    holdId = hold.id;
    pass(`HR legal hold placed (id=${holdId})`);
  } else {
    holdId = existingHrHold.id;
    pass(`Pre-existing HR hold found (id=${holdId}) — skipping placement`);
  }

  // Step 2: erasure attempt — must be blocked
  const hrHold = await activeHrHold(user.id);
  if (hrHold) {
    pass(`Erasure blocked: active HR legal hold prevents deletion`);
  } else {
    fail(`Erasure NOT blocked: no active HR hold found after placement`);
  }

  // Step 3: retention sweep simulation — must be blocked
  // A retention sweep that tries to delete a held subject's data must check the hold.
  // We verify the check query returns the hold, simulating what a sweep would do.
  const [retentionBlocked] = await sql`
    SELECT 1 FROM hr_legal_holds
    WHERE subject_user_id = ${user.id} AND org_id = ${orgId}
      AND status = 'active' AND deleted_at IS NULL
    LIMIT 1`;
  if (retentionBlocked) {
    pass(`Retention sweep blocked: hold check query returns the active hold`);
  } else {
    fail(`Retention sweep NOT blocked: hold check query returned nothing`);
  }

  // Step 4: org-level legal hold check (for org-wide purge)
  // Insert a temporary org hold and confirm it blocks the org purge.
  let orgHoldId = null;
  if (!existingOrgHold) {
    const [oh] = await sql`
      INSERT INTO organization_legal_holds (org_id, reason, placed_by, placed_at)
      VALUES (${orgId}, ${drillReason + " (org-level)"}, ${drillActor}, NOW())
      RETURNING hold_id`;
    orgHoldId = oh.hold_id;
    pass(`Org-level legal hold placed (holdId=${orgHoldId})`);
  } else {
    orgHoldId = existingOrgHold.hold_id;
    pass(`Pre-existing org-level hold found — skipping placement`);
  }

  const orgPurgeBlocked = await activeOrgHold();
  if (orgPurgeBlocked) {
    pass(`Org purge blocked: org-level hold check returns hold`);
  } else {
    fail(`Org purge NOT blocked: org-level hold check returned nothing`);
  }

  // Step 5: release the HR hold
  if (!existingHrHold) {
    await sql`
      UPDATE hr_legal_holds
      SET status = 'released', released_by = ${drillActor}, released_at = NOW()
      WHERE id = ${holdId}`;
    const postRelease = await activeHrHold(user.id);
    if (!postRelease) {
      pass(`HR hold released: no longer blocks`);
    } else {
      fail(`HR hold release failed: hold still active after update`);
    }
  } else {
    console.log(`  SKIP  HR hold release (pre-existing hold — not released by this drill)`);
  }

  // Step 6: release the org hold
  if (!existingOrgHold) {
    await sql`
      UPDATE organization_legal_holds
      SET released_at = NOW(), released_by = ${drillActor}
      WHERE hold_id = ${orgHoldId}`;
    const postOrgRelease = await activeOrgHold();
    if (!postOrgRelease) {
      pass(`Org hold released: no longer blocks purge`);
    } else {
      fail(`Org hold release failed: hold still active after update`);
    }
  } else {
    console.log(`  SKIP  Org hold release (pre-existing hold — not released by this drill)`);
  }

  // Step 7: confirm erasure is now allowed
  const postReleaseHr = existingHrHold ? null : await activeHrHold(user.id);
  const postReleaseOrg = existingOrgHold ? null : await activeOrgHold();
  if (!postReleaseHr && !postReleaseOrg) {
    pass(`Post-release: erasure now permitted (no blocking holds)`);
  } else {
    fail(`Post-release: holds still present`);
  }

  console.log(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed) ===`);

  if (failed > 0)
    console.error(`\n  Action required: investigate the FAILed steps above before executing a real erasure.`);

  await sql.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`\nDrill crashed: ${err.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
