import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const args = process.argv.slice(2);
const execute = args.includes("--execute");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) throw new Error("DATABASE_URL not set and no .env found");
  const match = fs.readFileSync(envPath, "utf8").match(/^DATABASE_URL\s*=\s*(.+)$/m);
  if (!match) throw new Error("DATABASE_URL not found in .env");
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

const sql = postgres(loadDatabaseUrl(), { prepare: false, max: 1, onnotice: () => {} });

class DryRun extends Error {}

async function main() {
  console.log(`
Backfills role_assignments for existing MEMBER memberships.

Run "pnpm -C backend backfill:system-roles" FIRST — it seeds the MEMBER role
row per org. This script only links existing members to that role.
${execute ? "\nMODE: EXECUTE (changes will be committed)\n" : "\nMODE: dry run (rolls back; pass --execute to commit)\n"}`);

  const orgsMissingRole = await sql`
    SELECT o.id, o.name
    FROM organizations o
    WHERE NOT EXISTS (
      SELECT 1 FROM roles r WHERE r.org_id = o.id AND r.slug = 'MEMBER'
    )`;

  if (orgsMissingRole.length > 0) {
    console.log(`${orgsMissingRole.length} organization(s) still have NO MEMBER role row.`);
    console.log(`Run backfill:system-roles first, or their members cannot be linked:`);
    for (const o of orgsMissingRole.slice(0, 10)) {
      console.log(`  - ${o.name ?? "(unnamed)"}  ${o.id}`);
    }
    if (orgsMissingRole.length > 10) console.log(`  ... and ${orgsMissingRole.length - 10} more`);
    console.log("");
  }

  const pending = await sql`
    SELECT om.org_id, count(*)::int AS member_count
    FROM organization_members om
    JOIN roles r ON r.org_id = om.org_id AND r.slug = 'MEMBER'
    WHERE om.role = 'MEMBER'
      AND NOT EXISTS (
        SELECT 1 FROM role_assignments ra
        WHERE ra.org_id = om.org_id
          AND ra.organization_membership_id = om.id
          AND ra.role_id = r.id
      )
    GROUP BY om.org_id
    ORDER BY 2 DESC`;

  const totalMembers = pending.reduce((sum, r) => sum + r.member_count, 0);
  console.log(`${totalMembers} member(s) across ${pending.length} organization(s) need a MEMBER assignment.`);

  if (totalMembers === 0) {
    console.log("Nothing to do.");
    await sql.end();
    return;
  }

  let inserted = 0;
  let bumped = 0;

  await sql
    .begin(async (tx) => {
      const rows = await tx`
        INSERT INTO role_assignments (org_id, organization_membership_id, role_id, assigned_by_membership_id)
        SELECT om.org_id, om.id, r.id, NULL
        FROM organization_members om
        JOIN roles r ON r.org_id = om.org_id AND r.slug = 'MEMBER'
        WHERE om.role = 'MEMBER'
          AND NOT EXISTS (
            SELECT 1 FROM role_assignments ra
            WHERE ra.org_id = om.org_id
              AND ra.organization_membership_id = om.id
              AND ra.role_id = r.id
          )
        ON CONFLICT DO NOTHING
        RETURNING org_id`;
      inserted = rows.length;

      const affectedOrgIds = [...new Set(rows.map((r) => r.org_id))];
      if (affectedOrgIds.length > 0) {
        const bumpedRows = await tx`
          INSERT INTO access_versions (org_id, permissions_version, updated_at)
          SELECT id, 1, now() FROM organizations WHERE id = ANY(${affectedOrgIds})
          ON CONFLICT (org_id) DO UPDATE
            SET permissions_version = access_versions.permissions_version + 1,
                updated_at = now()
          RETURNING org_id`;
        bumped = bumpedRows.length;
      }

      if (!execute) throw new DryRun();
    })
    .catch((err) => {
      if (!(err instanceof DryRun)) throw err;
    });

  console.log(`\n${execute ? "INSERTED" : "WOULD INSERT"} ${inserted} role assignment(s)`);
  console.log(`${execute ? "BUMPED" : "WOULD BUMP"} permissions version for ${bumped} organization(s)`);

  if (!execute) {
    console.log(`\nDry run only — rolled back. Re-run with --execute to commit.`);
  } else {
    console.log(`\nDone. Cached permission maps are invalidated by the version bump.`);
  }

  await sql.end();
}

main().catch(async (err) => {
  console.error(`\nFailed: ${err.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
