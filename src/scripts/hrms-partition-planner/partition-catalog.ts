import type postgres from "postgres";
import type {
  PartitionFamily,
  PartitionSecurityProfile,
  PartitionTable,
} from "./partition-config";
import { assertRelationSecurityReady } from "./partition-security";
import { assertExactTriggerRecipes } from "./partition-trigger-verification";

export type DatabaseIdentity = {
  database: string;
  databaseRole: string;
  configuredEnvironment: string | null;
};

type ParentRow = {
  partition_strategy: string;
  partition_key: string;
};

function normalizePartitionKey(value: string): string {
  return value.replaceAll('"', "").replace(/\s+/g, " ").trim().toUpperCase();
}

export async function readDatabaseIdentity(
  client: postgres.Sql,
): Promise<DatabaseIdentity> {
  const rows = await client<
    Array<{
      database_name: string;
      role_name: string;
      configured_environment: string | null;
    }>
  >`
    SELECT
      current_database() AS database_name,
      current_user AS role_name,
      current_setting('app.environment', true) AS configured_environment
  `;
  const row = rows[0];
  if (!row) throw new Error("database identity query returned no rows");
  return {
    database: row.database_name,
    databaseRole: row.role_name,
    configuredEnvironment: row.configured_environment || null,
  };
}

export async function assertTenantAllowlist(
  client: postgres.Sql,
  tenantIds: string[],
): Promise<void> {
  if (tenantIds.length === 0) return;
  const rows = await client<Array<{ id: string }>>`
    SELECT id FROM organizations WHERE id = ANY(${tenantIds}::text[])
  `;
  const found = new Set(rows.map((row) => row.id));
  const missing = tenantIds.filter((tenantId) => !found.has(tenantId));
  if (missing.length > 0)
    throw new Error(`tenant allowlist contains unknown IDs: ${missing.join(",")}`);
}

export async function assertParentReady(
  tx: postgres.TransactionSql,
  family: PartitionFamily,
  securityProfile: PartitionSecurityProfile,
): Promise<void> {
  const rows = await tx<ParentRow[]>`
    SELECT
      partitioned.partstrat AS partition_strategy,
      pg_get_partkeydef(parent.oid) AS partition_key
    FROM pg_class parent
    JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
    JOIN pg_partitioned_table partitioned ON partitioned.partrelid = parent.oid
    WHERE namespace.nspname = 'public'
      AND parent.relname = ${family.table}
      AND parent.relkind = 'p'
  `;
  const row = rows[0];
  if (!row) throw new Error(`${family.table} is not a partitioned parent`);
  const expectedStrategy = family.kind === "range" ? "r" : "h";
  const expectedKey = `${family.kind.toUpperCase()} (${family.key.toUpperCase()})`;
  if (row.partition_strategy !== expectedStrategy)
    throw new Error(`${family.table} uses the wrong partition strategy`);
  if (normalizePartitionKey(row.partition_key) !== expectedKey)
    throw new Error(`${family.table} uses the wrong partition key`);
  await assertRelationSecurityReady(
    tx,
    family.table,
    "organization_id",
    true,
    securityProfile,
  );
  await assertExactTriggerRecipes(tx, family.table, family.parentGuards);
}

export async function assertNoDefaultPartition(
  tx: postgres.TransactionSql,
  parent: PartitionTable,
): Promise<void> {
  const rows = await tx<Array<{ has_default: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_inherits inheritance
      JOIN pg_class parent ON parent.oid = inheritance.inhparent
      JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
      JOIN pg_class child ON child.oid = inheritance.inhrelid
      WHERE namespace.nspname = 'public'
        AND parent.relname = ${parent}
        AND pg_get_expr(child.relpartbound, child.oid, true) = 'DEFAULT'
    ) AS has_default
  `;
  if (rows[0]?.has_default === true)
    throw new Error(`${parent} has a forbidden default partition`);
}

export async function relationExists(
  tx: postgres.TransactionSql,
  relation: string,
): Promise<boolean> {
  const rows = await tx<Array<{ relation_name: string | null }>>`
    SELECT to_regclass(format('public.%I', ${relation}))::text AS relation_name
  `;
  return rows[0]?.relation_name !== null && rows[0]?.relation_name !== undefined;
}
