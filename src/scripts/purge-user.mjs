import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import postgres from "postgres";

const args = process.argv.slice(2);
const emailArg = args.find((a) => !a.startsWith("--"));
const execute = args.includes("--execute");
const keepOwnedOrgs = args.includes("--keep-owned-orgs");
const assumeYes = args.includes("--yes");

if (!emailArg) {
  console.error(`
Purge every trace of a user, and by default every organization they own.

  node src/scripts/purge-user.mjs <email> [--execute] [--keep-owned-orgs] [--yes]

  (no flags)          Dry run. Performs the real deletes inside a transaction,
                      reports exact row counts, then ROLLS BACK. Changes nothing.
  --execute           Actually commit the deletion. Irreversible.
  --keep-owned-orgs   Only remove this user and their memberships. Organizations
                      they own are left intact (ownership must be transferred
                      separately or the org is left without an owner).
  --yes               Skip the interactive confirmation prompt.
`);
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
  try {
    const result = await tx.unsafe(statement.text, statement.values);
    if (result.count > 0) tally.set(label, (tally.get(label) ?? 0) + result.count);
    return { ok: true };
  } catch (err) {
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

async function main() {
  const [user] = await sql`
    SELECT id, email, name, is_active, user_status
    FROM users WHERE lower(email) = ${email} LIMIT 1`;

  if (!user) {
    console.error(`No user found with email ${email}`);
    await sql.end();
    process.exit(1);
  }

  const memberships = await sql`
    SELECT m.org_id, m.is_owner, o.name AS org_name,
           (SELECT count(*) FROM organization_members x WHERE x.org_id = m.org_id) AS member_count
    FROM organization_members m
    LEFT JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ${user.id}`;

  const ownedOrgs = keepOwnedOrgs ? [] : memberships.filter((m) => m.is_owner);
  const otherOrgs = memberships.filter((m) => !ownedOrgs.some((o) => o.org_id === m.org_id));

  console.log(`\nUser:  ${user.email}  (${user.name ?? "no name"})`);
  console.log(`       id=${user.id} status=${user.user_status} active=${user.is_active}`);
  console.log(`\nOrganizations OWNED (will be purged entirely):`);
  if (ownedOrgs.length === 0) console.log("  (none)");
  for (const o of ownedOrgs) {
    console.log(`  - ${o.org_name ?? "(unnamed)"}  id=${o.org_id}  members=${o.member_count}`);
  }
  const collateral = ownedOrgs.reduce((sum, o) => sum + Number(o.member_count) - 1, 0);
  if (collateral > 0) {
    console.log(`\n  WARNING: ${collateral} other member(s) will lose their organization and all its data.`);
  }
  console.log(`\nOrganizations where this user is only a member (membership removed, org kept):`);
  if (otherOrgs.length === 0) console.log("  (none)");
  for (const o of otherOrgs) console.log(`  - ${o.org_name ?? "(unnamed)"}  id=${o.org_id}`);

  if (execute && !assumeYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nType the email again to permanently delete: `);
    rl.close();
    if (answer.trim().toLowerCase() !== email) {
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
        // organizations.owner_membership_id -> organization_members is a cycle; break it first.
        await tx`UPDATE organizations SET owner_membership_id = NULL WHERE id = ANY(${orgIds})`;

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
  }

  await sql.end();
}

class DryRun extends Error {}

main().catch(async (err) => {
  console.error(`\nFailed: ${err.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
