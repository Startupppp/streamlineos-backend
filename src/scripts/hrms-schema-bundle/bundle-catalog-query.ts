import type postgres from "postgres";
import { fail } from "./bundle-error";
import type { RelationRequirement } from "./bundle-catalog-registry";
import {
  childRowsSchema,
  relationRowsSchema,
  triggerRowsSchema,
  type ChildRows,
  type RelationRow,
  type TriggerRows,
} from "./bundle-catalog-schema";
import { readMaintainPrivileges } from "./bundle-maintain-privilege";
import { relationIdentity } from "./bundle-definition-query";

export async function readRelation(
  tx: postgres.TransactionSql,
  requirement: RelationRequirement,
  applicationRole: string,
  migrationRole: string,
): Promise<RelationRow> {
  const policyExpression = `${requirement.tenantColumn}=app.current_org_id`;
  const rawRows: unknown = await tx`
    WITH target AS (
      SELECT relation.oid, relation.relkind, relation.relowner, relation.relacl,
        relation.relrowsecurity, relation.relforcerowsecurity
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ${requirement.name}
    )
    SELECT
      pg_get_userbyid(target.relowner) AS owner_name,
      target.relkind::text AS relation_kind,
      partitioned.partstrat::text AS partition_strategy,
      pg_get_partkeydef(target.oid) AS partition_key,
      target.relrowsecurity AS rls_enabled,
      target.relforcerowsecurity AS force_rls_enabled,
      (SELECT count(*)::integer FROM pg_policy WHERE polrelid = target.oid)
        AS policy_count,
      COALESCE((
        SELECT bool_and(
          policy.polname = 'tenant_isolation'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[0::oid]
          AND policy.polcmd = '*'
          AND regexp_replace(
            pg_get_expr(policy.polqual, policy.polrelid),
            '[[:space:]()"]', '', 'g'
          ) = ${policyExpression}
          AND regexp_replace(
            pg_get_expr(policy.polwithcheck, policy.polrelid),
            '[[:space:]()"]', '', 'g'
          ) = ${policyExpression}
        )
        FROM pg_policy policy
        WHERE policy.polrelid = target.oid
      ), false) AS tenant_policy_valid,
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(
          target.relacl,
          acldefault('r', target.relowner)
        )) privilege
        WHERE privilege.grantee = 0
      ) AS public_access_exists,
      ARRAY(
        SELECT privilege_name
        FROM unnest(ARRAY[
          'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
          'REFERENCES', 'TRIGGER'
        ]::text[]) privilege_name
        WHERE has_table_privilege(
          ${applicationRole}::name, target.oid, privilege_name
        )
        ORDER BY 1
      ) AS application_table_privileges,
      ARRAY(
        SELECT attribute.attname || ':' || privilege_name
        FROM pg_attribute attribute
        CROSS JOIN unnest(
          ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
        ) privilege_name
        WHERE attribute.attrelid = target.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND has_column_privilege(
            ${applicationRole}::name,
            target.oid,
            attribute.attnum,
            privilege_name
          )
          AND NOT has_table_privilege(
            ${applicationRole}::name, target.oid, privilege_name
          )
        ORDER BY 1
      ) AS application_column_privileges,
      ARRAY(
        SELECT privilege_name
        FROM unnest(ARRAY[
          'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
          'REFERENCES', 'TRIGGER'
        ]::text[]) privilege_name
        WHERE has_table_privilege(
          ${migrationRole}::name, target.oid, privilege_name
        )
        ORDER BY 1
      ) AS migration_table_privileges,
      ARRAY(
        SELECT attribute.attname || ':' || privilege_name
        FROM pg_attribute attribute
        CROSS JOIN unnest(
          ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
        ) privilege_name
        WHERE attribute.attrelid = target.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND has_column_privilege(
            ${migrationRole}::name,
            target.oid,
            attribute.attnum,
            privilege_name
          )
          AND NOT has_table_privilege(
            ${migrationRole}::name, target.oid, privilege_name
          )
        ORDER BY 1
      ) AS migration_column_privileges,
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
        ORDER BY grant_row
      ) AS direct_grants,
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
          AND access.grantee = target.relowner
      ) AS owner_acl_valid
    FROM target
    LEFT JOIN pg_partitioned_table partitioned
      ON partitioned.partrelid = target.oid
  `;
  const rows = relationRowsSchema.parse(rawRows);
  if (rows.length !== 1) fail("RUNNER_CATALOG_RELATION_MISMATCH");
  const row = rows[0];
  if (!row) fail("RUNNER_CATALOG_RELATION_MISMATCH");
  const maintain = await readMaintainPrivileges(
    tx,
    "public",
    requirement.name,
    applicationRole,
    migrationRole,
  );
  return {
    ...row,
    application_table_privileges: maintain.application
      ? [...row.application_table_privileges, "MAINTAIN"].sort()
      : row.application_table_privileges,
    migration_table_privileges: maintain.migration
      ? [...row.migration_table_privileges, "MAINTAIN"].sort()
      : row.migration_table_privileges,
  };
}

export async function readChildren(
  tx: postgres.TransactionSql,
  parent: string,
): Promise<ChildRows> {
  const rawRows: unknown = await tx`
    SELECT child.relname AS child_name,
      pg_get_expr(child.relpartbound, child.oid, true) AS partition_bound
    FROM pg_inherits inheritance
    JOIN pg_class parent ON parent.oid = inheritance.inhparent
    JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = inheritance.inhrelid
    WHERE namespace.nspname = 'public' AND parent.relname = ${parent}
    ORDER BY child.relname
  `;
  return childRowsSchema.parse(rawRows);
}

export async function readTriggers(
  tx: postgres.TransactionSql,
  relation: string,
): Promise<TriggerRows> {
  const identity = relationIdentity(relation);
  const rawRows: unknown = await tx`
    SELECT catalog_trigger.tgname AS trigger_name,
      function_namespace.nspname AS function_schema,
      routine.proname AS function_name,
      catalog_trigger.tgtype::integer AS trigger_type,
      catalog_trigger.tgenabled::text AS enabled,
      catalog_trigger.tgconstraint <> 0 AS constraint_trigger,
      COALESCE(trigger_constraint.condeferrable, false) AS deferrable,
      COALESCE(trigger_constraint.condeferred, false) AS initially_deferred
      , ARRAY(
        SELECT attribute.attname
        FROM unnest(catalog_trigger.tgattr) WITH ORDINALITY
          trigger_column(attribute_number, ordinal)
        JOIN pg_attribute attribute
          ON attribute.attrelid = catalog_trigger.tgrelid
          AND attribute.attnum = trigger_column.attribute_number
        ORDER BY trigger_column.ordinal
      ) AS trigger_columns,
      catalog_trigger.tgnargs::integer AS argument_count,
      catalog_trigger.tgqual IS NOT NULL AS has_condition
    FROM pg_trigger catalog_trigger
    JOIN pg_class relation ON relation.oid = catalog_trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_proc routine ON routine.oid = catalog_trigger.tgfoid
    JOIN pg_namespace function_namespace
      ON function_namespace.oid = routine.pronamespace
    LEFT JOIN pg_constraint trigger_constraint
      ON trigger_constraint.oid = catalog_trigger.tgconstraint
    WHERE namespace.nspname = ${identity.schema}
      AND relation.relname = ${identity.name}
      AND NOT catalog_trigger.tgisinternal
    ORDER BY catalog_trigger.tgname
  `;
  return triggerRowsSchema.parse(rawRows);
}
