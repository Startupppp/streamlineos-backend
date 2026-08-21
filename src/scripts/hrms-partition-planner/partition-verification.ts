import type postgres from "postgres";
import {
  partitionFamilies,
  type PartitionSecurityProfile,
  type PartitionTable,
} from "./partition-config";
import type { PartitionPlanItem } from "./partition-plan";
import { assertRelationSecurityReady } from "./partition-security";
import { assertExactTriggerRecipes } from "./partition-trigger-verification";

type ChildRow = {
  parent_name: string;
  partition_bound: string;
};

type SecurityRow = {
  owner_matches: boolean;
  rls_matches: boolean;
  force_rls_matches: boolean;
  tenant_policy_exists: boolean;
  column_grants_exist: boolean;
  policy_differences: number;
  grant_differences: number;
};

function assertRangeBound(
  bound: string,
  item: Extract<PartitionPlanItem, { kind: "range" }>,
): void {
  const dates = item.parent === "hr_audit_events"
    ? Array.from(
        bound.matchAll(
          /(\d{4}-\d{2}-\d{2})[ T]00:00:00(?:\.0+)?(?:\+00(?::?00)?|Z)/gi,
        ),
        (match) => match[1] ?? "",
      )
    : bound.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  if (
    !/^FOR VALUES FROM/i.test(bound) ||
    dates.length !== 2 ||
    dates[0] !== item.from ||
    dates[1] !== item.to
  )
    throw new Error(`${item.child} has unexpected range bound: ${bound}`);
}

function assertHashBound(
  bound: string,
  item: Extract<PartitionPlanItem, { kind: "hash" }>,
): void {
  const match = /^FOR VALUES WITH \(modulus (\d+), remainder (\d+)\)$/i.exec(
    bound,
  );
  const modulus = Number(match?.[1] ?? Number.NaN);
  const remainder = Number(match?.[2] ?? Number.NaN);
  if (modulus !== item.modulus || remainder !== item.remainder)
    throw new Error(`${item.child} has unexpected hash bound: ${bound}`);
}

async function readChild(
  tx: postgres.TransactionSql,
  child: string,
): Promise<ChildRow> {
  const rows = await tx<ChildRow[]>`
    SELECT
      parent.relname AS parent_name,
      pg_get_expr(child.relpartbound, child.oid, true) AS partition_bound
    FROM pg_class child
    JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
    JOIN pg_inherits inheritance ON inheritance.inhrelid = child.oid
    JOIN pg_class parent ON parent.oid = inheritance.inhparent
    WHERE namespace.nspname = 'public'
      AND child.relname = ${child}
      AND child.relispartition
  `;
  const row = rows[0];
  if (!row) throw new Error(`${child} is not a direct partition`);
  return row;
}

async function readSecurityParity(
  tx: postgres.TransactionSql,
  parent: PartitionTable,
  child: string,
): Promise<SecurityRow> {
  const rows = await tx<SecurityRow[]>`
    WITH parent_relation AS (
      SELECT relation.oid, relation.relowner, relation.relacl,
        relation.relrowsecurity, relation.relforcerowsecurity
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = ${parent}
    ), child_relation AS (
      SELECT relation.oid, relation.relowner, relation.relacl,
        relation.relrowsecurity, relation.relforcerowsecurity
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = ${child}
    ), parent_policies AS (
      SELECT polname, polpermissive,
        ARRAY(SELECT unnest(polroles) ORDER BY 1) AS polroles,
        polcmd,
        pg_get_expr(polqual, polrelid) AS using_expression,
        pg_get_expr(polwithcheck, polrelid) AS check_expression
      FROM pg_policy WHERE polrelid = (SELECT oid FROM parent_relation)
    ), child_policies AS (
      SELECT polname, polpermissive,
        ARRAY(SELECT unnest(polroles) ORDER BY 1) AS polroles,
        polcmd,
        pg_get_expr(polqual, polrelid) AS using_expression,
        pg_get_expr(polwithcheck, polrelid) AS check_expression
      FROM pg_policy WHERE polrelid = (SELECT oid FROM child_relation)
    ), parent_grants AS (
      SELECT grantee, privilege_type, bool_or(is_grantable) AS is_grantable
      FROM parent_relation
      CROSS JOIN LATERAL aclexplode(COALESCE(relacl, '{}'::aclitem[]))
      GROUP BY grantee, privilege_type
    ), child_grants AS (
      SELECT grantee, privilege_type, bool_or(is_grantable) AS is_grantable
      FROM child_relation
      CROSS JOIN LATERAL aclexplode(COALESCE(relacl, '{}'::aclitem[]))
      GROUP BY grantee, privilege_type
    )
    SELECT
      child_relation.relowner = parent_relation.relowner AS owner_matches,
      child_relation.relrowsecurity = parent_relation.relrowsecurity AS rls_matches,
      child_relation.relforcerowsecurity = parent_relation.relforcerowsecurity AS force_rls_matches,
      EXISTS (
        SELECT 1 FROM child_policies WHERE polname = 'tenant_isolation'
      ) AS tenant_policy_exists,
      EXISTS (
        SELECT 1 FROM pg_attribute attribute
        WHERE attribute.attrelid = child_relation.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attacl IS NOT NULL
      ) AS column_grants_exist,
      (
        SELECT count(*)::int FROM (
          (SELECT * FROM parent_policies EXCEPT SELECT * FROM child_policies)
          UNION ALL
          (SELECT * FROM child_policies EXCEPT SELECT * FROM parent_policies)
        ) policy_difference
      ) AS policy_differences,
      (
        SELECT count(*)::int FROM (
          (SELECT * FROM parent_grants EXCEPT SELECT * FROM child_grants)
          UNION ALL
          (SELECT * FROM child_grants EXCEPT SELECT * FROM parent_grants)
        ) grant_difference
      ) AS grant_differences
    FROM parent_relation CROSS JOIN child_relation
  `;
  const row = rows[0];
  if (!row) throw new Error(`could not verify controls for ${child}`);
  return row;
}

export async function verifyPartition(
  tx: postgres.TransactionSql,
  item: PartitionPlanItem,
  securityProfile: PartitionSecurityProfile,
): Promise<void> {
  const child = await readChild(tx, item.child);
  if (child.parent_name !== item.parent)
    throw new Error(`${item.child} belongs to ${child.parent_name}, not ${item.parent}`);
  if (item.kind === "range") assertRangeBound(child.partition_bound, item);
  else assertHashBound(child.partition_bound, item);

  const family = partitionFamilies[item.parent];
  const controls = await readSecurityParity(
    tx,
    item.parent,
    item.child,
  );
  if (!controls.owner_matches)
    throw new Error(`${item.child} owner differs from its parent`);
  if (!controls.rls_matches || !controls.force_rls_matches)
    throw new Error(`${item.child} RLS state differs from its parent`);
  if (!controls.tenant_policy_exists || controls.policy_differences !== 0)
    throw new Error(`${item.child} RLS policies differ from its parent`);
  if (controls.column_grants_exist)
    throw new Error(`${item.child} has unsupported column-level grants`);
  if (controls.grant_differences !== 0)
    throw new Error(`${item.child} grants differ from its parent`);
  await assertRelationSecurityReady(
    tx,
    item.child,
    "organization_id",
    true,
    securityProfile,
  );
  await assertExactTriggerRecipes(tx, item.child, family.leafTriggers);
}
