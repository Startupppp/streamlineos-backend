import type postgres from "postgres";
import type { PartitionSecurityProfile } from "./partition-config";

export type RelationSecurityRow = {
  owner_name: string;
  current_role: string;
  row_security: boolean;
  force_row_security: boolean;
  tenant_policy_valid: boolean;
  column_grants_exist: boolean;
  public_access_denied: boolean;
  app_role_exists: boolean;
  application_access_denied: boolean;
  acl_matches_owner_default: boolean;
  sequence_access_valid: boolean;
};

function tenantPolicyExpression(tenantColumn: string): string {
  return `${tenantColumn}=app.current_org_id`;
}

export function supportsMaintainPrivilege(serverVersion: number): boolean {
  return serverVersion >= 170000;
}

async function applicationHasMaintain(
  tx: postgres.TransactionSql,
  relationName: string,
): Promise<boolean> {
  const versionRows = await tx<Array<{ server_version_num: number }>>`
    SELECT current_setting('server_version_num')::integer
      AS server_version_num
  `;
  const version = versionRows[0];
  if (!version)
    throw new Error(`${relationName} server version is unavailable`);
  if (!supportsMaintainPrivilege(version.server_version_num)) return false;
  const rows = await tx<Array<{ has_maintain: boolean }>>`
    SELECT COALESCE((
      SELECT has_table_privilege(
        role.oid,
        to_regclass(format('public.%I', ${relationName})),
        'MAINTAIN'
      )
      FROM pg_roles role
      WHERE role.rolname = coalesce(
        nullif(current_setting('app.bootstrap_role', true), ''),
        'streamline_app'
      )
    ), false) AS has_maintain
  `;
  const row = rows[0];
  if (!row)
    throw new Error(`${relationName} MAINTAIN privilege is unavailable`);
  return row.has_maintain;
}

export async function readRelationSecurity(
  tx: postgres.TransactionSql,
  relationName: string,
  tenantColumn: "org_id" | "organization_id",
): Promise<RelationSecurityRow> {
  const expression = tenantPolicyExpression(tenantColumn);
  const rows = await tx<RelationSecurityRow[]>`
    WITH target AS (
      SELECT relation.oid, relation.relowner, relation.relacl,
        relation.relrowsecurity, relation.relforcerowsecurity
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ${relationName}
    ), application_role AS (
      SELECT role.oid
      FROM pg_roles role
      WHERE role.rolname = coalesce(
        nullif(current_setting('app.bootstrap_role', true), ''),
        'streamline_app'
      )
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
    ), owned_sequences AS (
      SELECT sequence.oid, sequence.relowner, sequence.relacl
      FROM target
      JOIN pg_depend dependency
        ON dependency.refclassid = 'pg_class'::regclass
        AND dependency.refobjid = target.oid
        AND dependency.classid = 'pg_class'::regclass
        AND dependency.deptype IN ('a', 'i')
      JOIN pg_class sequence
        ON sequence.oid = dependency.objid
        AND sequence.relkind = 'S'
    )
    SELECT
      pg_get_userbyid(target.relowner) AS owner_name,
      current_user AS current_role,
      target.relrowsecurity AS row_security,
      target.relforcerowsecurity AS force_row_security,
      COALESCE((
        SELECT count(*) = 1 AND bool_and(
          policy.polname = 'tenant_isolation'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[0::oid]
          AND policy.polcmd = '*'
          AND regexp_replace(
            pg_get_expr(policy.polqual, policy.polrelid),
            '[[:space:]()"]', '', 'g'
          ) = ${expression}
          AND regexp_replace(
            pg_get_expr(policy.polwithcheck, policy.polrelid),
            '[[:space:]()"]', '', 'g'
          ) = ${expression}
        )
        FROM pg_policy policy
        WHERE policy.polrelid = target.oid
      ), false) AS tenant_policy_valid,
      EXISTS (
        SELECT 1 FROM pg_attribute attribute
        WHERE attribute.attrelid = target.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attacl IS NOT NULL
      ) AS column_grants_exist,
      NOT EXISTS (
        SELECT 1 FROM actual_acl WHERE grantee = 0
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_attribute attribute
        CROSS JOIN LATERAL aclexplode(
          COALESCE(attribute.attacl, '{}'::aclitem[])
        ) access
        WHERE attribute.attrelid = target.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND access.grantee = 0
      ) AS public_access_denied,
      EXISTS (SELECT 1 FROM application_role) AS app_role_exists,
      COALESCE((
        SELECT NOT (
          has_table_privilege(role.oid, target.oid, 'SELECT')
          OR has_table_privilege(role.oid, target.oid, 'INSERT')
          OR has_table_privilege(role.oid, target.oid, 'UPDATE')
          OR has_table_privilege(role.oid, target.oid, 'DELETE')
          OR has_table_privilege(role.oid, target.oid, 'TRUNCATE')
          OR has_table_privilege(role.oid, target.oid, 'REFERENCES')
          OR has_table_privilege(role.oid, target.oid, 'TRIGGER')
          OR has_any_column_privilege(role.oid, target.oid, 'SELECT')
          OR has_any_column_privilege(role.oid, target.oid, 'INSERT')
          OR has_any_column_privilege(role.oid, target.oid, 'UPDATE')
          OR has_any_column_privilege(role.oid, target.oid, 'REFERENCES')
        )
        FROM application_role role
      ), false) AS application_access_denied,
      NOT EXISTS (
        (SELECT * FROM actual_acl EXCEPT SELECT * FROM expected_acl)
        UNION ALL
        (SELECT * FROM expected_acl EXCEPT SELECT * FROM actual_acl)
      ) AS acl_matches_owner_default,
      NOT EXISTS (
        SELECT 1
        FROM owned_sequences sequence
        WHERE EXISTS (
          SELECT 1 FROM aclexplode(COALESCE(
            sequence.relacl,
            acldefault('S', sequence.relowner)
          )) access
          WHERE access.grantee = 0
        )
        OR EXISTS (
          SELECT 1 FROM application_role role
          WHERE has_sequence_privilege(role.oid, sequence.oid, 'USAGE')
            OR has_sequence_privilege(role.oid, sequence.oid, 'SELECT')
            OR has_sequence_privilege(role.oid, sequence.oid, 'UPDATE')
        )
        OR EXISTS (
          (SELECT access.grantee, access.privilege_type, access.is_grantable
           FROM aclexplode(COALESCE(
             sequence.relacl,
             acldefault('S', sequence.relowner)
           )) access
           EXCEPT
           SELECT access.grantee, access.privilege_type, access.is_grantable
           FROM aclexplode(acldefault('S', sequence.relowner)) access)
          UNION ALL
          (SELECT access.grantee, access.privilege_type, access.is_grantable
           FROM aclexplode(acldefault('S', sequence.relowner)) access
           EXCEPT
           SELECT access.grantee, access.privilege_type, access.is_grantable
           FROM aclexplode(COALESCE(
             sequence.relacl,
             acldefault('S', sequence.relowner)
           )) access)
        )
      ) AS sequence_access_valid
    FROM target
  `;
  const row = rows[0];
  if (!row) throw new Error(`${relationName} security catalog row is missing`);
  const hasMaintain = await applicationHasMaintain(tx, relationName);
  return {
    ...row,
    application_access_denied:
      row.application_access_denied && !hasMaintain,
  };
}

export async function assertRelationSecurityReady(
  tx: postgres.TransactionSql,
  relationName: string,
  tenantColumn: "org_id" | "organization_id",
  requireCurrentOwner: boolean,
  securityProfile: PartitionSecurityProfile,
): Promise<void> {
  const row = await readRelationSecurity(tx, relationName, tenantColumn);
  assertRelationSecurityRow(
    relationName,
    row,
    requireCurrentOwner,
    securityProfile,
  );
}

export function assertRelationSecurityRow(
  relationName: string,
  row: RelationSecurityRow,
  requireCurrentOwner: boolean,
  securityProfile: PartitionSecurityProfile,
): void {
  if (securityProfile !== "base-owner-only-v1")
    throw new Error(`${relationName} security profile is not approved`);
  if (!row.row_security || row.force_row_security || !row.tenant_policy_valid)
    throw new Error(`${relationName} has an invalid RLS configuration`);
  if (row.column_grants_exist || !row.public_access_denied)
    throw new Error(`${relationName} has forbidden public or column grants`);
  if (!row.app_role_exists || !row.application_access_denied)
    throw new Error(`${relationName} exposes access to the generic app role`);
  if (!row.acl_matches_owner_default)
    throw new Error(`${relationName} ACL differs from the approved owner-only ACL`);
  if (!row.sequence_access_valid)
    throw new Error(`${relationName} has an unsafe owned sequence ACL`);
  if (requireCurrentOwner && row.current_role !== row.owner_name)
    throw new Error(`${relationName} must be managed while SET ROLE to its owner`);
}
