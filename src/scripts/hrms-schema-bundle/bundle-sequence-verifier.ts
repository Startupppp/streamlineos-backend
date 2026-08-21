import type postgres from "postgres";
import { bundleCatalogRegistry } from "./bundle-catalog-registry";
import type { BundleFileName } from "./bundle-config";
import { fail } from "./bundle-error";
import { sequenceRowsSchema } from "./bundle-catalog-schema";

function sameValues(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every(
    (value, index) => value === expected[index],
  );
}

export async function verifyFileSequences(
  tx: postgres.TransactionSql,
  fileName: BundleFileName,
  applicationRole: string,
  migrationRole: string,
  databaseRole: string,
): Promise<void> {
  const requirement = bundleCatalogRegistry[fileName];
  const expectedMigration = [...requirement.migrationSequencePrivileges].sort();
  const expectedDirect = expectedMigration.map(
    (privilege) => `${migrationRole}:${privilege}`,
  );
  for (const sequence of requirement.sequences) {
    const rawRows: unknown = await tx`
      SELECT pg_get_userbyid(relation.relowner) AS owner_name,
        EXISTS (
          SELECT 1
          FROM aclexplode(COALESCE(
            relation.relacl,
            acldefault('S', relation.relowner)
          )) privilege
          WHERE privilege.grantee = 0
        ) AS public_access,
        ARRAY(
          SELECT privilege_name
          FROM unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']::text[])
            privilege_name
          WHERE has_sequence_privilege(
            ${applicationRole}::name,
            relation.oid,
            privilege_name
          )
          ORDER BY privilege_name
        ) AS application_privileges,
        ARRAY(
          SELECT privilege_name
          FROM unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']::text[])
            privilege_name
          WHERE has_sequence_privilege(
            ${migrationRole}::name,
            relation.oid,
            privilege_name
          )
          ORDER BY privilege_name
        ) AS migration_privileges,
        ARRAY(
          SELECT format(
            '%s:%s%s',
            CASE WHEN access.grantee = 0
              THEN 'PUBLIC' ELSE pg_get_userbyid(access.grantee) END,
            access.privilege_type,
            CASE WHEN access.is_grantable THEN ':GRANT' ELSE '' END
          )
          FROM aclexplode(COALESCE(
            relation.relacl,
            acldefault('S', relation.relowner)
          )) access
          WHERE access.grantee <> relation.relowner
          ORDER BY 1
        ) AS direct_grants,
        NOT EXISTS (
          (SELECT access.privilege_type, access.is_grantable
           FROM aclexplode(COALESCE(
             relation.relacl,
             acldefault('S', relation.relowner)
           )) access
           WHERE access.grantee = relation.relowner
           EXCEPT
           SELECT access.privilege_type, access.is_grantable
           FROM aclexplode(acldefault('S', relation.relowner)) access
           WHERE access.grantee = relation.relowner)
          UNION ALL
          (SELECT access.privilege_type, access.is_grantable
           FROM aclexplode(acldefault('S', relation.relowner)) access
           WHERE access.grantee = relation.relowner
           EXCEPT
           SELECT access.privilege_type, access.is_grantable
           FROM aclexplode(COALESCE(
             relation.relacl,
             acldefault('S', relation.relowner)
           )) access
           WHERE access.grantee = relation.relowner)
        ) AS owner_acl_valid
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ${sequence}
        AND relation.relkind = 'S'
    `;
    const rows = sequenceRowsSchema.parse(rawRows);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.owner_name !== databaseRole ||
      row.public_access ||
      row.application_privileges.length !== 0 ||
      !sameValues(row.migration_privileges, expectedMigration) ||
      !sameValues(row.direct_grants, expectedDirect) ||
      !row.owner_acl_valid
    )
      fail("RUNNER_CATALOG_SEQUENCE_MISMATCH");
  }
}
