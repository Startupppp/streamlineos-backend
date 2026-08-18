import type postgres from "postgres";
import type { BundleFileName } from "./bundle-config";
import { fail } from "./bundle-error";
import {
  bundleCatalogRegistry,
  type ApplicationAccess,
  type RelationRequirement,
  type TriggerRecipe,
} from "./bundle-catalog-registry";
import {
  type RelationRow,
  type TriggerRow,
} from "./bundle-catalog-schema";
import { verifyBundleFileDefinitions } from "./bundle-definition-verifier";
import { verifyFileSequences } from "./bundle-sequence-verifier";
import {
  readChildren,
  readRelation,
  readTriggers,
} from "./bundle-catalog-query";
import {
  assertRangeChildren,
  type CatalogVerificationMode,
} from "./bundle-partition-shape";

function normalizePartitionKey(value: string): string {
  return value.replaceAll('"', "").replace(/\s+/g, " ").trim().toUpperCase();
}

function assertApplicationAccess(
  access: ApplicationAccess,
  row: RelationRow,
): void {
  const expectedTables = [...access.tablePrivileges].sort();
  const expectedColumns = access.columnPrivileges
    .map((grant) => `${grant.column}:${grant.privilege}`)
    .sort();
  const actualTables = [...row.application_table_privileges].sort();
  const actualColumns = [...row.application_column_privileges].sort();
  if (
    actualTables.length !== expectedTables.length ||
    actualTables.some((value, index) => value !== expectedTables[index]) ||
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((value, index) => value !== expectedColumns[index])
  )
    fail("RUNNER_CATALOG_ACCESS_MISMATCH");
}

function expectedDirectGrants(
  requirement: RelationRequirement,
  applicationRole: string,
  migrationRole: string,
): string[] {
  const grants: string[] = [];
  for (const privilege of requirement.access.tablePrivileges)
    grants.push(`${applicationRole}:TABLE:${privilege}`);
  for (const grant of requirement.access.columnPrivileges)
    grants.push(`${applicationRole}:COLUMN:${grant.column}:${grant.privilege}`);
  for (const privilege of requirement.migrationAccess.tablePrivileges)
    grants.push(`${migrationRole}:TABLE:${privilege}`);
  for (const grant of requirement.migrationAccess.columnPrivileges)
    grants.push(`${migrationRole}:COLUMN:${grant.column}:${grant.privilege}`);
  return grants.sort();
}

function assertMigrationAccess(
  requirement: RelationRequirement,
  row: RelationRow,
): void {
  const expectedTables = [...requirement.migrationAccess.tablePrivileges].sort();
  const expectedColumns = requirement.migrationAccess.columnPrivileges
    .map((grant) => `${grant.column}:${grant.privilege}`)
    .sort();
  if (
    row.migration_table_privileges.length !== expectedTables.length ||
    row.migration_table_privileges.some(
      (value, index) => value !== expectedTables[index],
    ) ||
    row.migration_column_privileges.length !== expectedColumns.length ||
    row.migration_column_privileges.some(
      (value, index) => value !== expectedColumns[index],
    )
  )
    fail("RUNNER_CATALOG_ACCESS_MISMATCH");
}

export function assertTrigger(
  actual: TriggerRow,
  expected: TriggerRecipe,
): void {
  if (
    actual.function_schema !== "app" ||
    actual.function_name !== expected.functionName ||
    actual.trigger_type !== expected.triggerType ||
    actual.enabled !== "O" ||
    actual.constraint_trigger !== expected.constraint ||
    actual.deferrable !== expected.deferrable ||
    actual.initially_deferred !== expected.initiallyDeferred ||
    actual.argument_count !== 0 ||
    actual.has_condition ||
    actual.trigger_columns.length !== expected.columns.length ||
    actual.trigger_columns.some(
      (column, index) => column !== expected.columns[index],
    )
  )
    fail("RUNNER_CATALOG_TRIGGER_MISMATCH");
}

export async function assertExactTriggers(
  tx: postgres.TransactionSql,
  relation: string,
  expected: TriggerRecipe[],
): Promise<void> {
  const rows = await readTriggers(tx, relation);
  if (rows.length !== expected.length)
    fail("RUNNER_CATALOG_TRIGGER_MISMATCH");
  for (const recipe of expected) {
    const actual = rows.find((row) => row.trigger_name === recipe.name);
    if (!actual) fail("RUNNER_CATALOG_TRIGGER_MISMATCH");
    assertTrigger(actual, recipe);
  }
}

async function assertRelation(
  tx: postgres.TransactionSql,
  requirement: RelationRequirement,
  applicationRole: string,
  migrationRole: string,
  databaseRole: string,
  mode: CatalogVerificationMode,
): Promise<void> {
  const row = await readRelation(
    tx,
    requirement,
    applicationRole,
    migrationRole,
  );
  if (
    row.relation_kind !== requirement.kind ||
    row.partition_strategy !== requirement.partitionStrategy ||
    !row.rls_enabled ||
    row.force_rls_enabled ||
    row.owner_name !== databaseRole ||
    row.policy_count !== 1 ||
    !row.tenant_policy_valid
  )
    fail("RUNNER_CATALOG_RELATION_MISMATCH");
  const expectedKey = requirement.partitionStrategy === null
    ? null
    : `${requirement.partitionStrategy === "h" ? "HASH" : "RANGE"} (${requirement.partitionKey})`;
  if (
    expectedKey === null
      ? row.partition_key !== null
      : row.partition_key === null ||
        normalizePartitionKey(row.partition_key) !== expectedKey.toUpperCase()
  )
    fail("RUNNER_CATALOG_PARTITION_MISMATCH");
  assertApplicationAccess(requirement.access, row);
  assertMigrationAccess(requirement, row);
  const expectedGrants = expectedDirectGrants(
    requirement,
    applicationRole,
    migrationRole,
  );
  if (
    row.public_access_exists ||
    !row.owner_acl_valid ||
    row.direct_grants.length !== expectedGrants.length ||
    row.direct_grants.some((value, index) => value !== expectedGrants[index])
  )
    fail("RUNNER_CATALOG_ACCESS_MISMATCH");
  if (requirement.partitionStrategy === null) return;

  const parentTriggers = await readTriggers(tx, requirement.name);
  const parentTruncate = parentTriggers.find(
    (candidate) => candidate.trigger_name === "reject_hrms_truncate",
  );
  if (!parentTruncate) fail("RUNNER_CATALOG_TRIGGER_MISMATCH");
  assertTrigger(parentTruncate, {
    name: "reject_hrms_truncate",
    functionName: "reject_hrms_append_only_mutation",
    triggerType: 34,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
    columns: [],
  });

  const children = await readChildren(tx, requirement.name);
  if (requirement.hashModulus !== null) {
    if (children.length !== requirement.hashModulus)
      fail("RUNNER_CATALOG_PARTITION_MISMATCH");
    for (let remainder = 0; remainder < requirement.hashModulus; remainder += 1) {
      const expectedName = `${requirement.name}_h${String(remainder).padStart(2, "0")}`;
      const expectedBound = `FOR VALUES WITH (modulus ${requirement.hashModulus}, remainder ${remainder})`.toLowerCase();
      const actual = children.find((child) => child.child_name === expectedName);
      if (!actual || actual.partition_bound.toLowerCase() !== expectedBound)
        fail("RUNNER_CATALOG_PARTITION_MISMATCH");
    }
  }
  if (requirement.partitionStrategy === "r") {
    if (requirement.expectedRangeChildren === null)
      fail("RUNNER_CATALOG_RECIPE_INVALID");
    assertRangeChildren(children, requirement.expectedRangeChildren, mode);
  }
  for (const child of children) {
    await assertRelation(
      tx,
      {
        ...requirement,
        name: child.child_name,
        kind: "r",
        partitionKey: null,
        partitionStrategy: null,
        hashModulus: null,
        expectedRangeChildren: null,
        leafTriggers: [],
      },
      applicationRole,
      migrationRole,
      databaseRole,
      mode,
    );
    await assertExactTriggers(tx, child.child_name, requirement.leafTriggers);
  }
}

export async function verifyBundleFileCatalog(
  tx: postgres.TransactionSql,
  fileName: BundleFileName,
  applicationRole: string,
  migrationRole: string,
  databaseRole: string,
  mode: CatalogVerificationMode,
): Promise<void> {
  const requirement = bundleCatalogRegistry[fileName];
  for (const relation of requirement.relations)
    await assertRelation(
      tx,
      relation,
      applicationRole,
      migrationRole,
      databaseRole,
      mode,
    );
  for (const expected of requirement.triggers) {
    const rows = await readTriggers(tx, expected.relation);
    const actual = rows.find((row) => row.trigger_name === expected.name);
    if (!actual) fail("RUNNER_CATALOG_TRIGGER_MISMATCH");
    assertTrigger(actual, expected);
  }
  for (const relation of requirement.exactTriggerRelations) {
    const expected = requirement.triggers
      .filter((triggerRecipe) => triggerRecipe.relation === relation);
    await assertExactTriggers(tx, relation, expected);
  }
  await verifyBundleFileDefinitions(
    tx,
    fileName,
    applicationRole,
    migrationRole,
    databaseRole,
  );
  await verifyFileSequences(
    tx,
    fileName,
    applicationRole,
    migrationRole,
    databaseRole,
  );
}
