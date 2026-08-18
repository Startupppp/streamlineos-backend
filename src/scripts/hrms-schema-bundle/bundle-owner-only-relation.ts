import type postgres from "postgres";
import { z } from "zod";
import { fail } from "./bundle-error";
import { relationIdentity } from "./bundle-definition-query";
import { readMaintainPrivileges } from "./bundle-maintain-privilege";

const rowsSchema = z.array(z.object({
  owner_name: z.string(),
  current_role: z.string(),
  relation_kind: z.string(),
  row_security: z.boolean(),
  force_row_security: z.boolean(),
  policy_count: z.number(),
  owner_default_acl: z.boolean(),
  column_acl_exists: z.boolean(),
  application_access: z.boolean(),
  migration_access: z.boolean(),
}));

export type OwnerOnlyRelationRow = z.infer<typeof rowsSchema>[number];

export function assertOwnerOnlyRelation(
  row: OwnerOnlyRelationRow,
  databaseRole: string,
  maintain: { application: boolean; migration: boolean },
): void {
  if (
    row.owner_name !== databaseRole ||
    row.current_role !== databaseRole ||
    row.relation_kind !== "r" ||
    row.row_security ||
    row.force_row_security ||
    row.policy_count !== 0 ||
    !row.owner_default_acl ||
    row.column_acl_exists ||
    row.application_access ||
    row.migration_access ||
    maintain.application ||
    maintain.migration
  )
    fail("RUNNER_CATALOG_ACCESS_MISMATCH");
}

export async function verifyOwnerOnlyRelation(
  tx: postgres.TransactionSql,
  relation: string,
  applicationRole: string,
  migrationRole: string,
  databaseRole: string,
): Promise<void> {
  const identity = relationIdentity(relation);
  const rawRows: unknown = await tx`
    WITH target AS (
      SELECT catalog_relation.oid, catalog_relation.relowner,
        catalog_relation.relacl, catalog_relation.relkind,
        catalog_relation.relrowsecurity,
        catalog_relation.relforcerowsecurity
      FROM pg_class catalog_relation
      JOIN pg_namespace namespace
        ON namespace.oid = catalog_relation.relnamespace
      WHERE namespace.nspname = ${identity.schema}
        AND catalog_relation.relname = ${identity.name}
    ), actual_acl AS (
      SELECT access.grantee, access.privilege_type, access.is_grantable
      FROM target
      CROSS JOIN LATERAL aclexplode(COALESCE(
        target.relacl,
        acldefault('r', target.relowner)
      )) access
    ), expected_acl AS (
      SELECT access.grantee, access.privilege_type, access.is_grantable
      FROM target
      CROSS JOIN LATERAL aclexplode(acldefault('r', target.relowner)) access
    )
    SELECT pg_get_userbyid(target.relowner) AS owner_name,
      current_user AS current_role,
      target.relkind::text AS relation_kind,
      target.relrowsecurity AS row_security,
      target.relforcerowsecurity AS force_row_security,
      (SELECT count(*)::integer FROM pg_policy
       WHERE polrelid = target.oid) AS policy_count,
      NOT EXISTS (
        (SELECT * FROM actual_acl EXCEPT SELECT * FROM expected_acl)
        UNION ALL
        (SELECT * FROM expected_acl EXCEPT SELECT * FROM actual_acl)
      ) AS owner_default_acl,
      EXISTS (
        SELECT 1 FROM pg_attribute attribute
        WHERE attribute.attrelid = target.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attacl IS NOT NULL
      ) AS column_acl_exists,
      has_table_privilege(${applicationRole}::name, target.oid, 'SELECT')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'INSERT')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'UPDATE')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'DELETE')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'TRUNCATE')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'REFERENCES')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'TRIGGER')
        OR has_any_column_privilege(${applicationRole}::name, target.oid, 'SELECT')
        OR has_any_column_privilege(${applicationRole}::name, target.oid, 'INSERT')
        OR has_any_column_privilege(${applicationRole}::name, target.oid, 'UPDATE')
        OR has_any_column_privilege(${applicationRole}::name, target.oid, 'REFERENCES')
        AS application_access,
      has_table_privilege(${migrationRole}::name, target.oid, 'SELECT')
        OR has_table_privilege(${migrationRole}::name, target.oid, 'INSERT')
        OR has_table_privilege(${migrationRole}::name, target.oid, 'UPDATE')
        OR has_table_privilege(${migrationRole}::name, target.oid, 'DELETE')
        OR has_table_privilege(${migrationRole}::name, target.oid, 'TRUNCATE')
        OR has_table_privilege(${migrationRole}::name, target.oid, 'REFERENCES')
        OR has_table_privilege(${migrationRole}::name, target.oid, 'TRIGGER')
        OR has_any_column_privilege(${migrationRole}::name, target.oid, 'SELECT')
        OR has_any_column_privilege(${migrationRole}::name, target.oid, 'INSERT')
        OR has_any_column_privilege(${migrationRole}::name, target.oid, 'UPDATE')
        OR has_any_column_privilege(${migrationRole}::name, target.oid, 'REFERENCES')
        AS migration_access
    FROM target
  `;
  const rows = rowsSchema.parse(rawRows);
  const row = rows[0];
  if (!row || rows.length !== 1)
    fail("RUNNER_CATALOG_RELATION_MISMATCH");
  const maintain = await readMaintainPrivileges(
    tx,
    identity.schema,
    identity.name,
    applicationRole,
    migrationRole,
  );
  assertOwnerOnlyRelation(row, databaseRole, maintain);
}
