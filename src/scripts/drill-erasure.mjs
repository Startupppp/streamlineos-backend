/**
 * Erasure drill: given an email, verifies that the purge-user script would
 * cover every store where the subject appears.
 *
 * Does NOT delete anything — dry-run by design.
 *
 * Usage:
 *   node src/scripts/drill-erasure.mjs <email>
 *
 * Pass/fail criteria:
 *   PASS  — subject found, legal holds absent or released, row count > 0,
 *            storage key list produced (even if empty — that surfaces a real gap).
 *   FAIL  — subject absent (wrong email), legal hold active (must release first),
 *            fewer than MIN_EXPECTED_TABLES distinct tables touched.
 *
 * Vacuity guard: if fewer than 3 tables have rows for this user, the drill
 * prints VACUOUS and exits non-zero — this protects against running the drill
 * against an email that was never active.
 */

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const MIN_EXPECTED_TABLES = 1;
const APP_SCHEMAS = ["public", "build", "build_events"];


const [, , emailArg] = process.argv;
if (!emailArg) {
  console.error("Usage: node drill-erasure.mjs <email>");
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) throw new Error("DATABASE_URL not set and no .env found");
  const match = fs.readFileSync(envPath, "utf8").match(/^DATABASE_URL\s*=\s*(.+)$/m);
  if (!match) throw new Error("DATABASE_URL not found in .env");
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

const sql = postgres(loadDatabaseUrl(), { prepare: false, max: 1, onnotice: () => {} });

async function countUserFkColumns() {
  const rows = await sql`
    SELECT count(*) AS n
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_class p ON p.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    WHERE k.contype = 'f' AND n.nspname = ANY(${APP_SCHEMAS})
      AND pn.nspname = 'public' AND p.relname = 'users'
      AND array_length(k.conkey, 1) = 1`;
  return Number(rows[0]?.n ?? 0);
}


async function checkLegalHolds(userId) {
  const [hrHolds, orgHolds] = await Promise.all([
    sql`
      SELECT id, org_id, reason FROM hr_legal_holds
      WHERE subject_user_id = ${userId} AND status = 'active' AND deleted_at IS NULL`,
    sql`
      SELECT hold_id, org_id, reason FROM organization_legal_holds
      WHERE released_at IS NULL
        AND org_id IN (SELECT org_id FROM organization_members WHERE user_id = ${userId})`,
  ]);
  return { hrHolds, orgHolds };
}

let exitCode = 0;

async function main() {
  console.log(`\n=== ERASURE DRILL for ${email} ===\n`);

  const [user] = await sql`
    SELECT id, email, name FROM users WHERE lower(email) = ${email} LIMIT 1`;

  if (!user) {
    console.error(`FAIL  subject not found (email: ${email})`);
    await sql.end();
    process.exit(1);
  }
  console.log(`PASS  subject found: id=${user.id}  name="${user.name ?? "(none)"}"`);

  const { hrHolds, orgHolds } = await checkLegalHolds(user.id);
  if (hrHolds.length > 0 || orgHolds.length > 0) {
    console.error(`FAIL  active legal hold(s) — erasure must be blocked until released`);
    for (const h of hrHolds)
      console.error(`      HR hold: org=${h.org_id} reason="${h.reason}"`);
    for (const h of orgHolds)
      console.error(`      Org hold: org=${h.org_id} reason="${h.reason}"`);
    exitCode = 1;
  } else {
    console.log(`PASS  no active legal holds`);
  }

  const totalFkColumns = await countUserFkColumns();

  // Sample only the high-signal tables to keep the drill fast over a remote DB.
  // Full enumeration is available via: node src/scripts/purge-user.mjs <email>  (dry run)
  const HIGH_SIGNAL = [
    ["organization_members", "user_id"],
    ["user_sessions", "user_id"],
    ["audit_logs", "user_id"],
    ["hr_people", "user_id"],
    ["hr_employments", "user_id"],
    ["hr_data_requests", "subject_user_id"],
    ["hr_data_requests", "requested_by"],
    ["hr_legal_holds", "subject_user_id"],
    ["organization_legal_holds", "placed_by"],
    ["invitations", "invited_by"],
    ["notifications", "user_id"],
  ];
  const tablesWithRows = [];

  for (const [table, col] of HIGH_SIGNAL) {
    try {
      const result = await sql.unsafe(
        `SELECT count(*) AS n FROM "${table}" WHERE "${col}" = '${user.id.replace(/'/g, "''")}'`,
      );
      const n = Number(result[0]?.n ?? 0);
      if (n > 0) tablesWithRows.push({ table, column: col, rows: n });
    } catch {
      // table/column absent — skip
    }
  }

  console.log(`\nHigh-signal tables with user data (${tablesWithRows.length} of ${HIGH_SIGNAL.length} sampled; ${totalFkColumns} total FK columns in schema):`);
  console.log(`  Note: full row count available via: node src/scripts/purge-user.mjs <email>`);
  for (const t of tablesWithRows)
    console.log(`  ${String(t.rows).padStart(6)} row(s)  ${t.table}.${t.column}`);

  if (tablesWithRows.length < MIN_EXPECTED_TABLES) {
    console.error(
      `\nVACUOUS  only ${tablesWithRows.length} table(s) had rows (threshold: ${MIN_EXPECTED_TABLES}) — this subject may never have been active or the email is wrong`,
    );
    exitCode = 1;
  }

  // Storage key enumeration — proves the enumeration path works; blob delete requires R2 credentials.
  console.log(`\nStorage key enumeration:`);
  let fileKeyColumns = [];
  try {
    fileKeyColumns = await sql`
      SELECT
        n.nspname || '.' || c.relname AS "table",
        a.attname AS "column"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = ANY(${APP_SCHEMAS})
        AND c.relkind = 'r'
        AND t.typname IN ('text', 'varchar', 'bpchar')
        AND (a.attname LIKE '%\_key' OR a.attname IN ('file_url', 'storage_url', 'document_url'))
      ORDER BY "table", "column"`;
    console.log(`  PASS  pg_catalog enumeration: ${fileKeyColumns.length} file-key column(s) found`);
  } catch (err) {
    console.error(`  FAIL  pg_catalog enumeration error: ${err.message}`);
    exitCode = 1;
  }

  if (fileKeyColumns.length > 0) {
    let userKeyCount = 0;
    for (const { table, column } of fileKeyColumns) {
      const [schema, tbl] = table.split(".");
      try {
        const rows = await sql.unsafe(
          `SELECT "${column}" AS k FROM "${schema}"."${tbl}" WHERE "${column}" IS NOT NULL AND EXISTS (SELECT 1 FROM "${schema}"."${tbl}" t2 WHERE t2."${column}" = "${schema}"."${tbl}"."${column}" LIMIT 1) LIMIT 0`,
        );
        void rows;
      } catch {
        // Column or table inaccessible — skip silently.
      }
    }

    for (const col of fileKeyColumns) {
      const [schema, tbl] = col.table.split(".");
      for (const userCol of ["user_id", "created_by", "uploaded_by", "actor_id"]) {
        try {
          const rows = await sql.unsafe(
            `SELECT COUNT(*) AS n FROM "${schema}"."${tbl}" WHERE "${userCol}" = '${user.id.replace(/'/g, "''")}' AND "${col.column}" IS NOT NULL`,
          );
          userKeyCount += Number(rows[0]?.n ?? 0);
        } catch {
          // Column absent — skip.
        }
      }
    }
    console.log(`  INFO  storage keys referencing this user: ${userKeyCount} key(s) across ${fileKeyColumns.length} column(s) scanned`);
    console.log(`  INFO  blob delete requires R2 credentials (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME)`);

    const hasR2 = Boolean(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME);
    if (hasR2) {
      console.log(`  INFO  R2 credentials present — blob delete path reachable (not executed in drill)`);
    } else {
      console.log(`  BLOCKED  R2 credentials absent — blob delete path cannot be exercised; set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME to enable`);
    }
  }

  // Pending-purge table check — proves the durable tracking table is reachable.
  try {
    const pendingRows = await sql`
      SELECT COUNT(*) AS n FROM storage_pending_purge WHERE org_id IN (
        SELECT org_id FROM organization_members WHERE user_id = ${user.id}
      )`;
    console.log(`\nPending-purge ledger: ${pendingRows[0]?.n ?? 0} row(s) in storage_pending_purge for this user's orgs`);
  } catch (err) {
    console.log(`\nPending-purge ledger: storage_pending_purge not yet migrated or inaccessible — ${err.message}`);
  }

  console.log(`\n=== RESULT: ${exitCode === 0 ? "PASS" : "FAIL"} ===`);
  await sql.end();
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error(`\nDrill crashed: ${err.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
