import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import postgres from "postgres";

const args = process.argv.slice(2);
const emailArg = args.find((a) => !a.startsWith("--"));
const execute = args.includes("--execute");
const keepOwnedOrgs = args.includes("--keep-owned-orgs");
const assumeYes = args.includes("--yes");
const skipLegalHoldCheck = args.includes("--skip-legal-hold-check");

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

export function assertDisposableTarget(url) {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((p) => url.includes(p));
  if (matched) return { allowed: false, reason: `DATABASE_URL names production host '${matched}'` };
  let host, dbName;
  try {
    const u = new URL(url.replace(/^postgresql:\/\//, "http://").replace(/^postgres:\/\//, "http://"));
    host = u.hostname;
    dbName = u.pathname.replace(/^\//, "");
  } catch {
    return { allowed: false, reason: "DATABASE_URL does not parse" };
  }
  if (host === "127.0.0.1" || host === "localhost") return { allowed: true, reason: `loopback target '${host}'` };
  if (/scratch|test/i.test(dbName)) return { allowed: true, reason: `scratch/test database '${dbName}'` };
  return { allowed: false, reason: `host '${host}' is not loopback and database '${dbName}' is not a scratch/test database` };
}

if (args.includes("--self-test")) {
  const cases = [
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/app"), true],
    [assertDisposableTarget("postgresql://u:p@localhost:5432/app"), true],
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local"), true],
    [assertDisposableTarget("postgresql://u:p@10.0.0.5:5432/scratch_e2e"), true],
    [assertDisposableTarget("postgresql://u:p@prod.cluster.amazonaws.com/app"), false],
    [assertDisposableTarget("postgresql://u:p@prod.cluster.amazonaws.com/scratch_test"), false],
    [assertDisposableTarget("postgresql://u:p@db.neon.tech/neondb"), false],
    [assertDisposableTarget("postgresql://u:p@10.0.0.5:5432/production"), false],
    [assertDisposableTarget(null), false],
  ];
  let failed = 0;
  for (const [verdict, expected] of cases)
    if (verdict.allowed !== expected) { console.error(`FAIL: expected allowed=${expected}, got ${verdict.reason}`); failed++; }
  if (failed) process.exit(1);
  console.log("PASS: purge-user target refusal, 9 cases.");
  process.exit(0);
}

if (!emailArg) {
  console.error(`
Purge every trace of a user, and by default every organization they own.

  node src/scripts/purge-user.mjs <email> [--execute] [--keep-owned-orgs] [--yes] [--skip-legal-hold-check]

  (no flags)              Dry run. Performs the real deletes inside a transaction,
                          reports exact row counts, then ROLLS BACK. Changes nothing.
  --execute               Actually commit the deletion. Irreversible.
  --keep-owned-orgs       Only remove this user and their memberships. Organizations
                          they own are left intact (ownership must be transferred
                          separately or the org is left without an owner).
  --yes                   Skip the interactive confirmation prompt.
  --skip-legal-hold-check Bypass the legal hold gate. USE ONLY when you have verified
                          the hold is released and the check is a false positive.
                          Requires an explicit audit note — the operator will be prompted.

Storage deletion:
  Object-storage blobs are NOT deleted by this script — storage keys have no
  org_id segment (format: folder/uuid-filename) so they cannot be enumerated
  from the DB alone.  After committing, run the storage audit separately:
    node src/scripts/audit-storage-keys.mjs <email> --delete
  That script queries all file_key columns for this user's data and issues
  S3/R2 DeleteObject calls.  Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME in env before running.
`);
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();

function loadDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in environment (set it explicitly; never relies on .env fallback)");
  return url;
}

const _dbUrl = loadDatabaseUrl();
const _guard = assertDisposableTarget(_dbUrl);
if (!_guard.allowed) {
  process.stderr.write(
    `PURGE BLOCKED — ${_guard.reason}\n` +
    "  Set DATABASE_URL to a loopback or named scratch/test database before running a user purge.\n",
  );
  process.exit(1);
}
const sql = postgres(_dbUrl, { prepare: false, max: 1, onnotice: () => {} });

const APP_SCHEMAS = ["public", "build", "build_events"];

function qualifiedIdentifier(name) {
  const [schema, table] = name.split(".");
  return `"${schema}"."${table}"`;
}

async function fkEdges() {
  return sql`
    SELECT n.nspname || '.' || c.relname AS child, pn.nspname || '.' || p.relname AS parent
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_class p ON p.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    WHERE k.contype = 'f'
      AND n.nspname = ANY(${APP_SCHEMAS}) AND pn.nspname = ANY(${APP_SCHEMAS})
      AND c.oid <> p.oid`;
}

/**
 * Order tables so that every table is deleted before the tables it references.
 * Edge child -> parent means "child must be deleted first".
 */
function deletionOrder(tables, edges) {
  const set = new Set(tables);
  const indegree = new Map([...set].map((t) => [t, 0]));
  const out = new Map([...set].map((t) => [t, []]));
  for (const { child, parent } of edges) {
    if (!set.has(child) || !set.has(parent)) continue;
    out.get(child).push(parent);
    indegree.set(parent, indegree.get(parent) + 1);
  }
  const queue = [...set].filter((t) => indegree.get(t) === 0);
  const ordered = [];
  while (queue.length > 0) {
    const node = queue.shift();
    ordered.push(node);
    for (const parent of out.get(node)) {
      indegree.set(parent, indegree.get(parent) - 1);
      if (indegree.get(parent) === 0) queue.push(parent);
    }
  }
  const cyclic = [...set].filter((t) => !ordered.includes(t));
  return { ordered, cyclic };
}

async function tablesWithColumn(column) {
  const rows = await sql`
    SELECT n.nspname || '.' || c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = ANY(${APP_SCHEMAS}) AND c.relkind = 'r' AND a.attname = ${column}`;
  return rows.map((r) => r.name);
}

async function userReferencingColumns() {
  return sql`
    SELECT n.nspname || '.' || c.relname AS table_name, a.attname AS column_name
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_class p ON p.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    JOIN LATERAL unnest(k.conkey) AS ck(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum
    WHERE k.contype = 'f' AND n.nspname = ANY(${APP_SCHEMAS})
      AND pn.nspname = 'public' AND p.relname = 'users'
      AND array_length(k.conkey, 1) = 1`;
}

/**
 * Runs a delete, tolerating tables that no longer match (dropped column, view, etc.).
 * FK violations are retried by the caller in a later pass.
 */
async function tryDelete(tx, statement, tally, label) {
  await tx.unsafe("SAVEPOINT sp_try");
  try {
    const result = await tx.unsafe(statement.text, statement.values);
    if (result.count > 0) tally.set(label, (tally.get(label) ?? 0) + result.count);
    await tx.unsafe("RELEASE SAVEPOINT sp_try");
    return { ok: true };
  } catch (err) {
    await tx.unsafe("ROLLBACK TO SAVEPOINT sp_try");
    if (err.code === "23503") return { ok: false, err };
    if (err.code === "42P01" || err.code === "42703") return { ok: true };
    throw err;
  }
}

async function deleteWithRetries(tx, jobs, tally) {
  let pending = jobs;
  for (let pass = 0; pass < 6 && pending.length > 0; pass += 1) {
    const failed = [];
    for (const job of pending) {
      const res = await tryDelete(tx, job.statement, tally, job.label);
      if (!res.ok) failed.push(job);
    }
    if (failed.length === pending.length) {
      throw new Error(
        `Deletion stalled on foreign keys for: ${failed.map((f) => f.label).join(", ")}`,
      );
    }
    pending = failed;
  }
  if (pending.length > 0) {
    throw new Error(`Could not delete: ${pending.map((p) => p.label).join(", ")}`);
  }
}

async function checkLegalHolds(userId) {
  const hrHolds = await sql`
    SELECT h.id, h.org_id, h.reason, h.placed_at
    FROM hr_legal_holds h
    WHERE h.subject_user_id = ${userId}
      AND h.status = 'active'
      AND h.deleted_at IS NULL`;

  const orgHolds = await sql`
    SELECT h.hold_id, h.org_id, h.reason, h.placed_at
    FROM organization_legal_holds h
    WHERE h.released_at IS NULL
      AND h.org_id IN (
        SELECT org_id FROM organization_members WHERE user_id = ${userId}
      )`;

  return { hrHolds, orgHolds };
}

async function main() {
  const [user] = await sql`
    SELECT id, is_active, user_status
    FROM users WHERE lower(email) = ${email} LIMIT 1`;

  if (!user) {
    console.error(`No user found for the given address`);
    await sql.end();
    process.exit(1);
  }

  const { hrHolds, orgHolds } = await checkLegalHolds(user.id);
  const hasHolds = hrHolds.length > 0 || orgHolds.length > 0;

  if (hasHolds) {
    console.error(`\n⚠  LEGAL HOLD DETECTED — erasure is blocked.`);
    if (hrHolds.length > 0) {
      console.error(`\n  HR legal holds (${hrHolds.length}): see hold ids ${hrHolds.map((h) => h.id).join(", ")}`);
    }
    if (orgHolds.length > 0) {
      console.error(`\n  Org-level legal holds (${orgHolds.length}): see hold ids ${orgHolds.map((h) => h.hold_id).join(", ")}`);
    }
    if (!skipLegalHoldCheck) {
      console.error(`\n  Aborting. Release all active legal holds before running an erasure.`);
      console.error(`  To bypass (use only when holds are confirmed released): --skip-legal-hold-check`);
      await sql.end();
      process.exit(1);
    }
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const auditNote = await rl2.question(`\n  Legal hold bypassed. Enter audit justification (required): `);
    rl2.close();
    if (!auditNote.trim()) {
      console.error("  Justification required. Aborted.");
      await sql.end();
      process.exit(1);
    }
    console.log(`\n  Bypass recorded: "${auditNote.trim()}"`);
  }

  const memberships = await sql`
    SELECT m.org_id, m.is_owner, o.name AS org_name,
           (SELECT count(*) FROM organization_members x WHERE x.org_id = m.org_id) AS member_count
    FROM organization_members m
    LEFT JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ${user.id}`;

  const actualOwnedOrgs = memberships.filter((m) => m.is_owner);

  if (keepOwnedOrgs && actualOwnedOrgs.length > 0) {
    console.error(
      `\nPURGE BLOCKED — --keep-owned-orgs was given but the subject owns ${actualOwnedOrgs.length} organization(s).\n` +
      `  Removing their membership would leave those organizations without an owner.\n` +
      `  Transfer ownership to another member first, then re-run.\n`,
    );
    await sql.end();
    process.exit(1);
  }

  const ownedOrgs = keepOwnedOrgs ? [] : actualOwnedOrgs;
  const otherOrgs = memberships.filter((m) => !ownedOrgs.some((o) => o.org_id === m.org_id));

  console.log(`\nUser id=${user.id} status=${user.user_status} active=${user.is_active}`);
  console.log(`\nOrganizations OWNED (will be purged entirely): ${ownedOrgs.length}`);
  for (const o of ownedOrgs) {
    console.log(`  - id=${o.org_id}  members=${o.member_count}`);
  }
  const collateral = ownedOrgs.reduce((sum, o) => sum + Number(o.member_count) - 1, 0);
  if (collateral > 0) {
    console.log(`\n  WARNING: ${collateral} other member(s) will lose their organization and all its data.`);
  }
  console.log(`\nOrganizations where this user is only a member (membership removed, org kept): ${otherOrgs.length}`);
  for (const o of otherOrgs) console.log(`  - id=${o.org_id}`);

  if (execute && !assumeYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nType "DELETE" to permanently remove this subject: `);
    rl.close();
    if (answer.trim() !== "DELETE") {
      console.error("Confirmation did not match. Aborted.");
      await sql.end();
      process.exit(1);
    }
  }

  const [edges, orgScoped, emailScoped, userCols] = await Promise.all([
    fkEdges(),
    tablesWithColumn("org_id"),
    tablesWithColumn("email"),
    userReferencingColumns(),
  ]);

  const { ordered, cyclic } = deletionOrder(orgScoped, edges);
  const orgTableOrder = [...ordered, ...cyclic];
  const tally = new Map();

  await sql
    .begin(async (tx) => {
      const orgIds = ownedOrgs.map((o) => o.org_id);

      if (orgIds.length > 0) {
        await tx`
          UPDATE organizations
          SET owner_membership_id = NULL
          WHERE id = ANY(${orgIds})
            AND owner_membership_id IN (
              SELECT id FROM organization_members
              WHERE user_id = ${user.id} AND org_id = ANY(${orgIds})
            )
        `;

        const jobs = orgTableOrder
          .filter((t) => t !== "public.organizations")
          .map((table) => ({
            label: table,
            statement: {
              text: `DELETE FROM ${qualifiedIdentifier(table)} WHERE org_id = ANY($1)`,
              values: [orgIds],
            },
          }));
        await deleteWithRetries(tx, jobs, tally);

        const removedOrgs = await tx`DELETE FROM organizations WHERE id = ANY(${orgIds})`;
        if (removedOrgs.count > 0) tally.set("organizations", removedOrgs.count);
      }

      const userJobs = userCols.map(({ table_name, column_name }) => ({
        label: `${table_name}.${column_name}`,
        statement: {
          text: `DELETE FROM ${qualifiedIdentifier(table_name)} WHERE "${column_name}" = $1`,
          values: [user.id],
        },
      }));
      await deleteWithRetries(tx, userJobs, tally);

      const emailJobs = emailScoped
        .filter((t) => t !== "public.users")
        .map((table) => ({
          label: `${table}.email`,
          statement: {
            text: `DELETE FROM ${qualifiedIdentifier(table)} WHERE lower(email) = $1`,
            values: [email],
          },
        }));
      await deleteWithRetries(tx, emailJobs, tally);

      const removedUser = await tx`DELETE FROM users WHERE id = ${user.id}`;
      if (removedUser.count > 0) tally.set("users", removedUser.count);

      if (!execute) throw new DryRun();
    })
    .catch((err) => {
      if (!(err instanceof DryRun)) throw err;
    });

  const rows = [...tally.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, n]) => sum + n, 0);

  console.log(`\n${execute ? "DELETED" : "WOULD DELETE"} ${total} row(s) across ${rows.length} table(s):`);
  for (const [table, count] of rows) console.log(`  ${String(count).padStart(7)}  ${table}`);
  if (rows.length === 0) console.log("  (nothing)");

  if (!execute) {
    console.log(`\nDry run only — transaction rolled back, nothing was changed.`);
    console.log(`Re-run with --execute to commit.`);
  } else {
    console.log(`\n⚠  OBJECT STORAGE: database rows are deleted, but blobs in R2/S3 are NOT.`);
    console.log(`   Enumerate and delete storage objects separately:`);
    console.log(`   node src/scripts/audit-storage-keys.mjs <subject-email> --delete`);
    console.log(`   (set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME in env)`);
  }

  await sql.end();
}

class DryRun extends Error {}

main().catch(async (err) => {
  console.error(`\nFailed: ${err.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
