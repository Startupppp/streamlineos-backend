import type postgres from "postgres";
import { fail } from "./bundle-error";
import { ledgerAccessRowsSchema } from "./bundle-ledger-schema";
import { readMaintainPrivileges } from "./bundle-maintain-privilege";

export async function verifyLedgerAccess(
  client: postgres.Sql | postgres.TransactionSql,
  applicationRole: string,
  migrationRole: string,
): Promise<void> {
  const rawRows: unknown = await client`
    WITH target AS (
      SELECT relation.oid, relation.relowner, relation.relacl
      FROM pg_class relation
      WHERE relation.oid = 'app.hrms_sql_bundle_operations'::regclass
    )
    SELECT
      pg_get_userbyid(target.relowner) = current_user AS owner_matches,
      NOT EXISTS (
        (SELECT access.privilege_type, access.is_grantable
         FROM aclexplode(COALESCE(
           target.relacl,
           acldefault('r', target.relowner)
         )) access
         WHERE access.grantee = target.relowner
         EXCEPT
         SELECT access.privilege_type, access.is_grantable
         FROM aclexplode(acldefault('r', target.relowner)) access
         WHERE access.grantee = target.relowner)
        UNION ALL
        (SELECT access.privilege_type, access.is_grantable
         FROM aclexplode(acldefault('r', target.relowner)) access
         WHERE access.grantee = target.relowner
         EXCEPT
         SELECT access.privilege_type, access.is_grantable
         FROM aclexplode(COALESCE(
           target.relacl,
           acldefault('r', target.relowner)
         )) access
         WHERE access.grantee = target.relowner)
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_attribute attribute
        CROSS JOIN LATERAL aclexplode(
          COALESCE(attribute.attacl, '{}'::aclitem[])
        ) access
        WHERE attribute.attrelid = target.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND access.grantee = target.relowner
      ) AS owner_acl_valid,
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(
          target.relacl,
          acldefault('r', target.relowner)
        )) access
        WHERE access.grantee = 0
      ) OR EXISTS (
        SELECT 1 FROM pg_attribute attribute
        CROSS JOIN LATERAL aclexplode(
          COALESCE(attribute.attacl, '{}'::aclitem[])
        ) access
        WHERE attribute.attrelid = target.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND access.grantee = 0
      ) AS public_access,
      ARRAY(
        SELECT grant_row
        FROM (
          SELECT format(
            '%s:TABLE:%s%s',
            CASE WHEN access.grantee = 0
              THEN 'PUBLIC' ELSE pg_get_userbyid(access.grantee) END,
            access.privilege_type,
            CASE WHEN access.is_grantable THEN ':GRANT' ELSE '' END
          ) AS grant_row
          FROM aclexplode(COALESCE(
            target.relacl,
            acldefault('r', target.relowner)
          )) access
          WHERE access.grantee <> target.relowner
          UNION ALL
          SELECT format(
            '%s:COLUMN:%s:%s%s',
            CASE WHEN access.grantee = 0
              THEN 'PUBLIC' ELSE pg_get_userbyid(access.grantee) END,
            attribute.attname,
            access.privilege_type,
            CASE WHEN access.is_grantable THEN ':GRANT' ELSE '' END
          )
          FROM pg_attribute attribute
          CROSS JOIN LATERAL aclexplode(
            COALESCE(attribute.attacl, '{}'::aclitem[])
          ) access
          WHERE attribute.attrelid = target.oid
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) grants
        ORDER BY 1
      ) AS direct_grants,
      (
        has_table_privilege(${applicationRole}::name, target.oid, 'SELECT')
        OR has_any_column_privilege(${applicationRole}::name, target.oid, 'SELECT')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'INSERT')
        OR has_any_column_privilege(${applicationRole}::name, target.oid, 'INSERT')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'UPDATE')
        OR has_any_column_privilege(${applicationRole}::name, target.oid, 'UPDATE')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'DELETE')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'TRUNCATE')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'REFERENCES')
        OR has_any_column_privilege(${applicationRole}::name, target.oid, 'REFERENCES')
        OR has_table_privilege(${applicationRole}::name, target.oid, 'TRIGGER')
      ) AS application_access,
      has_table_privilege(${migrationRole}::name, target.oid, 'SELECT')
        AS migration_select,
      has_table_privilege(${migrationRole}::name, target.oid, 'INSERT')
        AS migration_insert,
      has_table_privilege(${migrationRole}::name, target.oid, 'UPDATE')
        AS migration_update,
      has_table_privilege(${migrationRole}::name, target.oid, 'DELETE')
        AS migration_delete,
      has_table_privilege(${migrationRole}::name, target.oid, 'TRUNCATE')
        AS migration_truncate,
      has_table_privilege(${migrationRole}::name, target.oid, 'REFERENCES')
        OR has_any_column_privilege(${migrationRole}::name, target.oid, 'REFERENCES')
        AS migration_references,
      has_table_privilege(${migrationRole}::name, target.oid, 'TRIGGER')
        AS migration_trigger,
      false AS migration_maintain
    FROM target
  `;
  const row = ledgerAccessRowsSchema.parse(rawRows)[0];
  const maintain = await readMaintainPrivileges(
    client,
    "app",
    "hrms_sql_bundle_operations",
    applicationRole,
    migrationRole,
  );
  const expectedGrants = [
    `${migrationRole}:TABLE:INSERT`,
    `${migrationRole}:TABLE:SELECT`,
    `${migrationRole}:TABLE:UPDATE`,
  ];
  if (
    !row ||
    !row.owner_matches ||
    !row.owner_acl_valid ||
    row.public_access ||
    row.direct_grants.length !== expectedGrants.length ||
    row.direct_grants.some((grant, index) => grant !== expectedGrants[index]) ||
    row.application_access ||
    maintain.application ||
    !row.migration_select ||
    !row.migration_insert ||
    !row.migration_update ||
    row.migration_delete ||
    row.migration_truncate ||
    row.migration_references ||
    row.migration_trigger ||
    row.migration_maintain ||
    maintain.migration
  )
    fail("RUNNER_LEDGER_ACCESS_MISMATCH");
}
