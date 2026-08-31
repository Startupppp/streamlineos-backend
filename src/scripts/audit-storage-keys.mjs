/**
 * Enumerate and (optionally) delete every object-storage key belonging to a
 * data subject. Run AFTER purge-user.mjs to satisfy the blob-storage leg of
 * a DPDP/GDPR erasure.
 *
 * Usage:
 *   node src/scripts/audit-storage-keys.mjs <email> [--execute] [--yes]
 *
 *   (no flags)   Dry run. Lists every object key the subject's rows reference.
 *                Does NOT delete anything. Exit 2 if R2 credentials are absent.
 *   --execute    Issue DeleteObject for every enumerated key. Idempotent —
 *                R2/S3 returns success for a key that no longer exists.
 *   --yes        Skip the interactive confirmation prompt when --execute is set.
 *
 * Prerequisites (must be set in env or .env):
 *   DATABASE_URL          Neon/Postgres connection string
 *   R2_ENDPOINT           https://<account>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID      Cloudflare R2 Access Key ID
 *   R2_SECRET_ACCESS_KEY  Cloudflare R2 Secret Access Key
 *   R2_BUCKET_NAME        Target bucket
 *   R2_REGION             (optional, defaults to "auto")
 *
 * Exit codes:
 *   0  Verified — dry-run completed with credentials present, or
 *      execute completed successfully.
 *   1  Failed — user not found, legal hold active, or runtime error.
 *   2  Prerequisite missing — R2 credentials absent. Printed list of what.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import postgres from "postgres";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const args = process.argv.slice(2);
const emailArg = args.find((a) => !a.startsWith("--"));
const execute = args.includes("--execute");
const assumeYes = args.includes("--yes");

if (!emailArg) {
  console.error(`
Enumerate and delete object-storage blobs for a data subject.

  node src/scripts/audit-storage-keys.mjs <email> [--execute] [--yes]

  (no flags)   Dry run: list object keys. Exit 2 if R2 credentials absent.
  --execute    Issue DeleteObject for every enumerated key (idempotent).
  --yes        Skip interactive confirmation.

Required env vars for --execute (and to exit 0 on dry-run):
  R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME

Set DATABASE_URL or have a .env file at the project root.
`);
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) throw new Error("DATABASE_URL not set and no .env found");
  const raw = fs.readFileSync(envPath, "utf8");
  const m = raw.match(/^DATABASE_URL\s*=\s*(.+)$/m);
  if (!m) throw new Error("DATABASE_URL not found in .env");
  return m[1].trim().replace(/^['"]|['"]$/g, "");
}

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

loadEnvFile();

function checkR2Credentials() {
  const required = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"];
  const missing = required.filter((k) => !process.env[k]);
  return missing;
}

const APP_SCHEMAS = ["public", "build", "build_events"];

function qi(schema, table) {
  return `"${schema}"."${table}"`;
}

function qc(col) {
  return `"${col}"`;
}

function splitTable(qualifiedName) {
  const [schema, table] = qualifiedName.split(".");
  return { schema, table };
}

/**
 * Discovers all text columns whose name ends with _key (or matches known
 * storage-key naming variants) across the application schemas.
 * Catalog-driven — survives schema evolution without code changes.
 */
async function discoverFileKeyColumns(sql) {
  const rows = await sql`
    SELECT
      n.nspname || '.' || c.relname AS table_name,
      a.attname                     AS col_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type      t ON t.oid = a.atttypid
    WHERE n.nspname = ANY(${APP_SCHEMAS})
      AND c.relkind = 'r'
      AND t.typname IN ('text', 'varchar', 'bpchar')
      AND (
        a.attname = 'file_key'
        OR a.attname = 'object_key'
        OR a.attname = 'storage_key'
        OR a.attname LIKE '%\_file\_key'
        OR a.attname LIKE '%\_object\_key'
        OR a.attname LIKE '%\_storage\_key'
      )
    ORDER BY table_name, col_name
  `;
  return rows;
}

/**
 * Discovers all single-column FK columns pointing to public.users across the
 * application schemas. Returns a map: qualified_table_name → [col, ...].
 * Catalog-driven via pg_constraint — a new table with a user FK is included
 * automatically.
 */
async function discoverUserFkMap(sql) {
  const rows = await sql`
    SELECT
      n.nspname || '.' || c.relname AS table_name,
      a.attname                     AS col_name
    FROM pg_constraint k
    JOIN pg_class   c  ON c.oid = k.conrelid
    JOIN pg_class   p  ON p.oid = k.confrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    JOIN LATERAL unnest(k.conkey) ck(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum
    WHERE k.contype = 'f'
      AND n.nspname = ANY(${APP_SCHEMAS})
      AND pn.nspname = 'public' AND p.relname = 'users'
      AND array_length(k.conkey, 1) = 1
  `;
  const map = new Map();
  for (const { table_name, col_name } of rows) {
    if (!map.has(table_name)) map.set(table_name, []);
    map.get(table_name).push(col_name);
  }
  return map;
}

/**
 * Check for active legal holds. Both subject-specific (hr_legal_holds) and
 * organisation-wide (organization_legal_holds for any org the subject belongs to).
 * Returns the hold records; empty arrays = no holds.
 */
async function checkLegalHolds(sql, userId) {
  const hrHolds = await sql`
    SELECT id, org_id, reason, placed_at
    FROM public.hr_legal_holds
    WHERE subject_user_id = ${userId}
      AND status = 'active'
      AND deleted_at IS NULL
  `;
  const orgHolds = await sql`
    SELECT hold_id, org_id, reason, placed_at
    FROM public.organization_legal_holds
    WHERE released_at IS NULL
      AND org_id IN (
        SELECT org_id FROM public.organization_members WHERE user_id = ${userId}
      )
  `;
  return { hrHolds, orgHolds };
}

/**
 * Enumerate every storage key for the subject across all file-key columns.
 * The legal hold is enforced IN THE SQL PREDICATE of every per-table query so
 * the exclusion is atomic at the database level, not filtered in application
 * code after the fact.
 *
 * Returns an array of { key, tableName, colName, source } objects.
 */
async function enumerateSubjectKeys(sql, userId, orgIds, fileKeyCols, userFkMap) {
  const seen = new Set();
  const results = [];
  const skippedNoScope = [];

  const orgScoped = new Set(
    (
      await sql`
        SELECT n.nspname || '.' || c.relname AS t
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r'
      `
    ).map((r) => r.t),
  );

  for (const { table_name, col_name } of fileKeyCols) {
    const { schema, table } = splitTable(table_name);
    const userCols = userFkMap.get(table_name) ?? [];

    if (userCols.length > 0) {
      for (const userCol of userCols) {
        const rows = await sql.unsafe(
          `SELECT ${qc(col_name)} AS k
           FROM ${qi(schema, table)}
           WHERE ${qc(userCol)} = $1
             AND ${qc(col_name)} IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM public.hr_legal_holds
               WHERE subject_user_id = $1
                 AND status = 'active'
                 AND deleted_at IS NULL
             )`,
          [userId],
        );
        for (const { k } of rows) {
          if (typeof k === "string" && k.length > 0 && !seen.has(k)) {
            seen.add(k);
            results.push({ key: k, tableName: table_name, colName: col_name, source: "user-fk" });
          }
        }
      }
    } else if (orgIds.length > 0 && orgScoped.has(table_name)) {
      const rows = await sql.unsafe(
        `SELECT ${qc(col_name)} AS k
         FROM ${qi(schema, table)}
         WHERE org_id = ANY($1)
           AND ${qc(col_name)} IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM public.hr_legal_holds
             WHERE subject_user_id = $2
               AND status = 'active'
               AND deleted_at IS NULL
           )`,
        [orgIds, userId],
      );
      for (const { k } of rows) {
        if (typeof k === "string" && k.length > 0 && !seen.has(k)) {
          seen.add(k);
          results.push({ key: k, tableName: table_name, colName: col_name, source: "org-id" });
        }
      }
    } else {
      skippedNoScope.push(`${table_name}.${col_name}`);
    }
  }

  if (skippedNoScope.length > 0) {
    console.error(
      `\n  NOT SEARCHED — ${skippedNoScope.length} file-key column(s) on tables with neither a users FK nor org_id:`,
    );
    for (const s of skippedNoScope) console.error(`    ${s}`);
    console.error("  These cannot be attributed to a subject from the schema alone.");
  }

  return results;
}

async function main() {
  const dbUrl = loadDatabaseUrl();
  const sql = postgres(dbUrl, { prepare: false, max: 1, onnotice: () => {} });

  try {
    const [user] = await sql`
      SELECT id, email, name FROM public.users
      WHERE lower(email) = ${email} LIMIT 1
    `;

    if (!user) {
      console.error(`No user found with email ${email}`);
      process.exit(1);
    }

    console.log(`\nSubject: ${user.email}  (${user.name ?? "no name"})`);
    console.log(`        id=${user.id}`);

    const { hrHolds, orgHolds } = await checkLegalHolds(sql, user.id);
    const hasHolds = hrHolds.length > 0 || orgHolds.length > 0;

    if (hasHolds) {
      console.error(`\n⚠  LEGAL HOLD ACTIVE — storage enumeration aborted.`);
      if (hrHolds.length > 0) {
        console.error(`\n  Subject-level holds (${hrHolds.length}):`);
        for (const h of hrHolds)
          console.error(`    - id=${h.id} org=${h.org_id} reason="${h.reason}" placed=${h.placed_at}`);
      }
      if (orgHolds.length > 0) {
        console.error(`\n  Org-level holds (${orgHolds.length}):`);
        for (const h of orgHolds)
          console.error(`    - holdId=${h.hold_id} org=${h.org_id} reason="${h.reason}" placed=${h.placed_at}`);
      }
      console.error(`\n  Release all active legal holds before running an erasure.`);
      process.exit(1);
    }

    const memberships = await sql`
      SELECT org_id FROM public.organization_members WHERE user_id = ${user.id}
    `;
    const orgIds = memberships.map((m) => m.org_id);

    console.log(`\nOrganizations: ${orgIds.length > 0 ? orgIds.join(", ") : "(none)"}`);
    console.log(`\nDiscovering file-key columns from pg_catalog...`);

    const [fileKeyCols, userFkMap] = await Promise.all([
      discoverFileKeyColumns(sql),
      discoverUserFkMap(sql),
    ]);

    console.log(
      `Discovered ${fileKeyCols.length} file-key column(s) across ${new Set(fileKeyCols.map((r) => r.table_name)).size} table(s).`,
    );

    console.log(`\nEnumerating subject's object keys (legal hold predicate applied in SQL)...`);
    const subjectKeys = await enumerateSubjectKeys(sql, user.id, orgIds, fileKeyCols, userFkMap);

    if (subjectKeys.length === 0) {
      console.log(`\nNo object keys found for this subject.`);
    } else {
      console.log(`\n${execute ? "Object keys to delete" : "Object keys WOULD be deleted"} (${subjectKeys.length}):`);
      for (const { key, tableName, colName, source } of subjectKeys) {
        console.log(`  ${key}  [${tableName}.${colName} / ${source}]`);
      }
    }

    const missingCreds = checkR2Credentials();

    if (!execute) {
      if (missingCreds.length > 0) {
        console.error(`\nDry run complete. Cannot proceed to deletion — prerequisites missing:`);
        for (const v of missingCreds) console.error(`  ${v}`);
        console.error(`\nSet the above env vars, then re-run with --execute to delete.`);
        process.exit(2);
      }
      console.log(`\nDry run complete. Re-run with --execute to delete ${subjectKeys.length} object(s).`);
      process.exit(0);
    }

    if (missingCreds.length > 0) {
      console.error(`\nCannot execute deletion — prerequisites missing:`);
      for (const v of missingCreds) console.error(`  ${v}`);
      process.exit(2);
    }

    if (subjectKeys.length === 0) {
      console.log(`\nNothing to delete.`);
      process.exit(0);
    }

    if (!assumeYes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        `\nType the email again to permanently delete ${subjectKeys.length} object(s): `,
      );
      rl.close();
      if (answer.trim().toLowerCase() !== email) {
        console.error("Confirmation did not match. Aborted.");
        process.exit(1);
      }
    }

    const r2 = new S3Client({
      region: process.env.R2_REGION ?? "auto",
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });

    const bucket = process.env.R2_BUCKET_NAME;
    let deleted = 0;
    let failed = 0;

    console.log(`\nDeleting ${subjectKeys.length} object(s)...`);

    for (const { key, tableName, colName } of subjectKeys) {
      try {
        await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        deleted += 1;
        console.log(`  ✓  ${key}  [${tableName}.${colName}]`);
      } catch (err) {
        failed += 1;
        console.error(`  ✗  ${key}  — ${err.message}`);
      }
    }

    console.log(`\n${deleted} deleted, ${failed} failed.`);

    if (failed > 0) {
      console.error(`Re-run to retry the ${failed} failed deletion(s). The script is idempotent.`);
      process.exit(1);
    }

    process.exit(0);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch(async (err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
