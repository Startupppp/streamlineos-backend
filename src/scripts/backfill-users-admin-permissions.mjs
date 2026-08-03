/**
 * Grants the org-administration keys `/users` now requires to roles that could
 * already administer users through the old `hr:employees:*` gates. Additive and
 * idempotent. Dry run by default; pass --apply to write.
 */
import postgres from "postgres";

const apply = process.argv.includes("--apply");

const OLD_READ_KEYS = ["hr:employees:view"];
const OLD_WRITE_KEYS = [
  "hr:employees:create",
  "hr:employees:update",
  "hr:employees:delete",
  "hr:employees:manage",
  "hr:export:manage",
];

const MIGRATIONS = [
  { newKey: "settings:view", sourceKeys: [...OLD_READ_KEYS, ...OLD_WRITE_KEYS] },
  { newKey: "settings:organization:manage", sourceKeys: OLD_WRITE_KEYS },
];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required (the owner role — this writes RBAC grants).");
  process.exit(1);
}

const sql = postgres(connectionString, { prepare: false, max: 1, onnotice: () => {} });

async function findRolesNeeding(newKey, sourceKeys) {
  return sql`
    SELECT r.org_id            AS "orgId",
           r.id                AS "roleId",
           r.slug              AS "slug",
           (SELECT g2.scope
              FROM role_permission_grants g2
             WHERE g2.role_id = r.id
               AND g2.permission_key = ANY(${sourceKeys})
             ORDER BY CASE g2.scope::text
                        WHEN 'all'  THEN 4
                        WHEN 'team' THEN 3
                        WHEN 'own'  THEN 2
                        ELSE 1
                      END DESC
             LIMIT 1)          AS "scope"
      FROM roles r
      JOIN role_permission_grants g
        ON g.role_id = r.id
       AND g.permission_key = ANY(${sourceKeys})
     WHERE NOT EXISTS (
             SELECT 1 FROM role_permission_grants x
              WHERE x.role_id = r.id
                AND x.permission_key = ${newKey}
           )
     GROUP BY r.org_id, r.id, r.slug
     ORDER BY r.org_id, r.id`;
}

async function main() {
  console.log(`\n${apply ? "APPLY" : "DRY RUN"} — org-administration permission backfill\n`);

  const planned = [];
  for (const { newKey, sourceKeys } of MIGRATIONS) {
    const roles = await findRolesNeeding(newKey, sourceKeys);
    console.log(`${newKey} → ${roles.length} role(s)`);
    for (const role of roles) {
      console.log(`   org ${role.orgId.slice(0, 8)}… role#${role.roleId} ${role.slug} (scope=${role.scope})`);
      planned.push({ ...role, newKey });
    }
  }

  if (planned.length === 0) {
    console.log("\nNothing to backfill — every role already holds the new keys.");
    return;
  }

  if (!apply) {
    const orgs = new Set(planned.map((p) => p.orgId));
    console.log(`\n${planned.length} grant(s) across ${orgs.size} org(s) would be inserted.`);
    console.log("Re-run with --apply to write them.");
    return;
  }

  const orgs = new Set();
  await sql.begin(async (tx) => {
    for (const grant of planned) {
      await tx`
        INSERT INTO role_permission_grants (org_id, role_id, permission_key, scope, created_at)
        VALUES (${grant.orgId}, ${grant.roleId}, ${grant.newKey}, ${grant.scope}::data_scope, now())`;
      orgs.add(grant.orgId);
    }

    for (const orgId of orgs) {
      await tx`
        INSERT INTO access_versions (org_id, permissions_version, updated_at)
        VALUES (${orgId}, 1, now())
        ON CONFLICT (org_id) DO UPDATE
          SET permissions_version = access_versions.permissions_version + 1,
              updated_at = now()`;
    }
  });

  console.log(`\nInserted ${planned.length} grant(s); bumped permissions version for ${orgs.size} org(s).`);
}

main()
  .catch((err) => {
    console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }).catch(() => undefined));
