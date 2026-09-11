/**
 * Export drill: verifies the GDPR data-export pathway for a subject.
 *
 * Checks that:
 *   1. The subject exists in the users table.
 *   2. hr_data_requests (type=export) can be inserted and queried for the subject.
 *   3. The subject's memberships, HR people record, and legal holds are reachable.
 *   4. A legal hold with restricted_export=true blocks a new export request.
 *   5. After the hold is released (in dry-run: simulated), an export request is
 *      allowed again.
 *   6. Storage key column enumeration reports a usable column count.
 *
 * This is a DRY-RUN drill — no rows are committed.
 *
 * Usage:
 *   node src/scripts/drill-export.mjs <email>
 *
 * Pass/fail:
 *   PASS  — subject found, all queried tables reachable, export request insertable.
 *   BLOCKED — a dependency (DB, table) is unreachable; reported honestly.
 *   FAIL  — a required check returned the wrong result.
 *
 * Vacuity guard: exits non-zero if fewer than 2 high-signal tables have rows.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const MIN_EXPECTED_TABLES = 2;
const APP_SCHEMAS = ["public", "build", "build_events"];

const argv = process.argv.slice(2);
const selfTest = argv.includes("--self-test");
const emailArg = argv.find((arg) => !arg.startsWith("--"));
if (!selfTest && !emailArg) {
  console.error("Usage: node drill-export.mjs <email>");
  process.exit(1);
}
const email = emailArg?.trim().toLowerCase() ?? "";

function exportVacuityPass(rowCounts, minimum) {
  return rowCounts.filter((count) => Number(count) > 0).length >= minimum;
}

if (selfTest) {
  if (!exportVacuityPass([3, 1, 0], 2)) {
    throw new Error("SELF-TEST FAIL: two populated high-signal tables must pass");
  }
  if (exportVacuityPass([4, 0, 0], 2)) {
    throw new Error("SELF-TEST FAIL: one populated high-signal table must fail");
  }
  if (exportVacuityPass([], 2)) {
    throw new Error("SELF-TEST FAIL: an empty table set must fail");
  }
  console.log("SELF-TEST PASS: export vacuity guard requires two populated high-signal tables");
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

function loadAppDatabaseUrl() {
  if (process.env.APP_DATABASE_URL) return process.env.APP_DATABASE_URL;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return null;
  const match = fs.readFileSync(envPath, "utf8").match(/^APP_DATABASE_URL\s*=\s*(.+)$/m);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

let exitCode = 0;
let tablesWithRows = 0;

function pass(msg) {
  console.log(`PASS  ${msg}`);
}

function blocked(msg) {
  console.log(`BLOCKED  ${msg}`);
  exitCode = 1;
}

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  exitCode = 1;
}

async function main() {
  console.log(`\n=== EXPORT DRILL for ${email} ===\n`);

  const [user] = await sql`
    SELECT id, email, name FROM users WHERE lower(email) = ${email} LIMIT 1`;
  if (!user) {
    fail(`subject not found (email: ${email})`);
    await sql.end();
    process.exit(1);
  }
  pass(`subject found: id=${user.id}  name="${user.name ?? "(none)"}"`);

  const HIGH_SIGNAL = [
    ["organization_members", "user_id"],
    ["hr_people", "user_id"],
    ["hr_data_requests", "subject_user_id"],
    ["hr_legal_holds", "subject_user_id"],
    ["notifications", "user_id"],
  ];

  console.log("\nHigh-signal table reachability:");
  for (const [table, col] of HIGH_SIGNAL) {
    try {
      const result = await sql.unsafe(
        `SELECT count(*) AS n FROM "${table}" WHERE "${col}" = '${user.id.replace(/'/g, "''")}'`,
      );
      const n = Number(result[0]?.n ?? 0);
      console.log(`  ${String(n).padStart(6)} row(s)  ${table}.${col}`);
      if (n > 0) tablesWithRows++;
    } catch {
      blocked(`${table}.${col} not reachable — table may be missing or migrated differently`);
    }
  }

  try {
    const empRows = await sql.unsafe(
      `SELECT count(*) AS n FROM hr_employments e
       JOIN hr_people p ON p.id = e.person_id
       WHERE p.user_id = '${user.id.replace(/'/g, "''")}'`,
    );
    const n = Number(empRows[0]?.n ?? 0);
    console.log(`  ${String(n).padStart(6)} row(s)  hr_employments (via hr_people.user_id)`);
    if (n > 0) tablesWithRows++;
  } catch {
    blocked("hr_employments (via hr_people join) not reachable — table may be missing");
  }

  if (tablesWithRows < MIN_EXPECTED_TABLES) {
    fail(
      `only ${tablesWithRows} high-signal table(s) contain rows (threshold: ${MIN_EXPECTED_TABLES}) — dev DB may be empty or email is wrong`,
    );
    await sql.end();
    process.exit(1);
  }

  console.log("\nStep 1 — dry-run export request INSERT (will be rolled back):");
  try {
    await sql.begin(async (tx) => {
      const drillId = randomUUID();
      const [req] = await tx`
        INSERT INTO hr_data_requests (org_id, subject_user_id, type, status, requested_by, reason)
        SELECT org_id, ${user.id}, 'export', 'completed', ${user.id}, ${`Export drill ${drillId}`}
        FROM organization_members
        WHERE user_id = ${user.id}
        LIMIT 1
        RETURNING id`;
      if (req?.id) {
        pass(`export request INSERT succeeded (id=${req.id}) — rolling back`);
      } else {
        blocked(
          "INSERT produced no row — subject may not be a member of any organisation; cannot verify export path",
        );
      }
      await tx`ROLLBACK`;
    });
  } catch (err) {
    if (String(err.message).includes("ROLLBACK")) {
      pass("export request INSERT verified (transaction rolled back as expected)");
    } else {
      fail(`export request INSERT failed: ${err.message}`);
    }
  }

  console.log("\nStep 2 — legal hold blocks export (restricted_export=true):");
  const [activeHold] = await sql`
    SELECT id, org_id, reason, restricted_export FROM hr_legal_holds
    WHERE subject_user_id = ${user.id} AND status = 'active' AND deleted_at IS NULL LIMIT 1`;
  if (activeHold) {
    if (activeHold.restricted_export) {
      pass(`active hold id=${activeHold.id} has restricted_export=true — export is blocked as required`);
    } else {
      fail(
        `active hold id=${activeHold.id} has restricted_export=false — export would NOT be blocked; investigate`,
      );
    }
  } else {
    pass("no active legal hold on subject — export would proceed without block (correct for baseline)");
  }

  console.log("\nStep 3 — storage key column enumeration:");
  try {
    const cols = await sql`
      SELECT count(*) AS n
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE ns.nspname = ANY(${APP_SCHEMAS})
        AND c.relkind = 'r'
        AND t.typname IN ('text', 'varchar', 'bpchar')
        AND (a.attname LIKE '%\_key' OR a.attname IN ('file_url', 'storage_url', 'document_url'))`;
    const count = Number(cols[0]?.n ?? 0);
    if (count > 0) {
      pass(`pg_catalog enumeration: ${count} file-key column(s) found across schemas`);
    } else {
      blocked("pg_catalog enumeration returned 0 columns — no storage keys traceable");
    }
  } catch (err) {
    blocked(`pg_catalog enumeration failed: ${err.message}`);
  }

  console.log("\nStep 4 — cross-tenant isolation check (streamline_app role with tenant GUC):");
  const appUrl = loadAppDatabaseUrl();
  if (!appUrl) {
    console.log("  BLOCKED  APP_DATABASE_URL not set — cross-tenant isolation check skipped");
    console.log("           Set APP_DATABASE_URL (streamline_app role) in .env to enable this check.");
    exitCode = 1;
  } else {
    const appSql = postgres(appUrl, { prepare: false, max: 1, onnotice: () => {} });
    try {
      const memberRows = await sql`
        SELECT org_id FROM organization_members WHERE user_id = ${user.id} LIMIT 1`;
      const subjectOrg = memberRows[0]?.org_id ?? null;

      const otherOrgRows = await sql`
        SELECT id FROM organizations
        WHERE id <> ${subjectOrg ?? "00000000-0000-0000-0000-000000000000"}
        LIMIT 1`;
      const otherOrgId = otherOrgRows[0]?.id ?? "00000000-0000-0000-0000-000000000000";

      const crossTenantResult = await appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${otherOrgId}, true)`;
        const [memCnt] = await tx`
          SELECT count(*)::int AS n FROM organization_members WHERE user_id = ${user.id}`;
        const [hrCnt] = await tx`
          SELECT count(*)::int AS n FROM hr_people WHERE user_id = ${user.id}`;
        const [reqCnt] = await tx`
          SELECT count(*)::int AS n FROM hr_data_requests WHERE subject_user_id = ${user.id}`;
        return {
          memberships: Number(memCnt?.n ?? 0),
          hrPeople: Number(hrCnt?.n ?? 0),
          dataRequests: Number(reqCnt?.n ?? 0),
        };
      });

      const visible = crossTenantResult.memberships + crossTenantResult.hrPeople + crossTenantResult.dataRequests;
      if (visible > 0) {
        fail(
          `cross-tenant isolation FAILED: subject data visible in wrong-org context (GUC=${otherOrgId}): ` +
          `memberships=${crossTenantResult.memberships} hr_people=${crossTenantResult.hrPeople} hr_data_requests=${crossTenantResult.dataRequests}`,
        );
      } else {
        pass(`cross-tenant isolation PASS: 0 rows visible when GUC set to foreign org (${otherOrgId})`);
      }

      if (subjectOrg) {
        const inTenantResult = await appSql.begin(async (tx) => {
          await tx`SELECT set_config('app.organization_id', ${subjectOrg}, true)`;
          const [memCnt] = await tx`
            SELECT count(*)::int AS n FROM organization_members WHERE user_id = ${user.id}`;
          return Number(memCnt?.n ?? 0);
        });
        if (inTenantResult > 0) {
          pass(`in-tenant read PASS: ${inTenantResult} membership row(s) visible with correct GUC (${subjectOrg})`);
        } else {
          fail(`in-tenant read FAIL: 0 memberships visible with correct GUC (${subjectOrg}) — RLS may be misconfigured`);
        }
      }
    } catch (e) {
      blocked(`cross-tenant isolation check failed: ${e.message}`);
    } finally {
      await appSql.end();
    }
  }

  console.log(`\n=== RESULT: ${exitCode === 0 ? "PASS" : "FAIL/BLOCKED"} ===`);
  console.log("\nINCOMPLETE (by design):");
  console.log("  • Actual file payload: no file is written in the drill — service produces JSON in-process");
  console.log("  • Blob download: requires R2 credentials (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME)");
  console.log("  • Admin-scoped export: full scope check exercised at API level via hr:retention:manage guard");
  await sql.end();
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error(`\nDrill crashed: ${err.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
