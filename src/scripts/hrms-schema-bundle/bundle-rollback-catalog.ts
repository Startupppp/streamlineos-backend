import type postgres from "postgres";
import { z } from "zod";
import type { BundleFileName } from "./bundle-config";
import {
  assertTrigger,
} from "./bundle-catalog";
import { readTriggers } from "./bundle-catalog-query";
import { bundleCatalogRegistry } from "./bundle-catalog-registry";
import { verifyDefinitionSubset } from "./bundle-definition-subset";
import { bundleDefinitionRegistry } from "./bundle-definition-registry";
import { fail } from "./bundle-error";
import { verifyRetainedBundleLedger } from "./bundle-retained-ledger";

const namesSchema = z.array(z.object({ name: z.string() }));

function retainedExactRelations(fileName: BundleFileName): Set<string> {
  if (fileName === "0000_hrms_profiles_workforce.sql")
    return new Set(["app.hrms_sql_bundle_operations"]);
  return new Set();
}

function retainedFunctions(fileName: BundleFileName): Set<string> {
  if (fileName === "0000_hrms_profiles_workforce.sql")
    return new Set([
      "enforce_hrms_bundle_operation_transition",
      "reject_hrms_append_only_mutation",
    ]);
  if (
    fileName === "0001_hrms_effective_history.sql" ||
    fileName === "0002_hrms_leave_ledger.sql"
  )
    return new Set(["reject_hrms_append_only_mutation"]);
  if (fileName === "0004_hrms_hierarchy_audit.sql")
    return new Set(["verify_org_unit_parent_cycle"]);
  return new Set();
}

async function assertRelationsAbsent(
  tx: postgres.TransactionSql,
  relations: string[],
): Promise<void> {
  const qualified = relations.map((relation) =>
    relation.includes(".") ? relation : `public.${relation}`);
  const rawRows: unknown = await tx`
    SELECT relation_name AS name
    FROM unnest(${qualified}::text[]) relation_name
    WHERE to_regclass(relation_name) IS NOT NULL
  `;
  if (namesSchema.parse(rawRows).length > 0)
    fail("RUNNER_ROLLBACK_CATALOG_RELATION_PRESENT");
}

async function assertFunctionsAbsent(
  tx: postgres.TransactionSql,
  functions: string[],
): Promise<void> {
  const rawRows: unknown = await tx`
    SELECT routine.proname AS name
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'app'
      AND routine.proname = ANY(${functions}::text[])
  `;
  if (namesSchema.parse(rawRows).length > 0)
    fail("RUNNER_ROLLBACK_CATALOG_FUNCTION_PRESENT");
}

async function assertEnumsAbsent(
  tx: postgres.TransactionSql,
  enums: string[],
): Promise<void> {
  const rawRows: unknown = await tx`
    SELECT type.typname AS name
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public'
      AND type.typname = ANY(${enums}::text[])
  `;
  if (namesSchema.parse(rawRows).length > 0)
    fail("RUNNER_ROLLBACK_CATALOG_ENUM_PRESENT");
}

async function assertTriggersAbsent(
  tx: postgres.TransactionSql,
  triggers: string[],
): Promise<void> {
  const rawRows: unknown = await tx`
    SELECT catalog_trigger.tgname AS name
    FROM pg_trigger catalog_trigger
    JOIN pg_class relation ON relation.oid = catalog_trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('app', 'public')
      AND NOT catalog_trigger.tgisinternal
      AND catalog_trigger.tgname = ANY(${triggers}::text[])
  `;
  if (namesSchema.parse(rawRows).length > 0)
    fail("RUNNER_ROLLBACK_CATALOG_TRIGGER_PRESENT");
}

async function verifyRetainedCycleTrigger(
  tx: postgres.TransactionSql,
  fileName: BundleFileName,
): Promise<void> {
  if (fileName !== "0004_hrms_hierarchy_audit.sql") return;
  const expected = bundleCatalogRegistry[fileName].triggers.find(
    (trigger) => trigger.name === "verify_org_unit_parent_cycle",
  );
  if (!expected) fail("RUNNER_ROLLBACK_CATALOG_RECIPE_INVALID");
  const rows = await readTriggers(tx, expected.relation);
  const actual = rows.find((trigger) => trigger.trigger_name === expected.name);
  if (!actual) fail("RUNNER_CATALOG_TRIGGER_MISMATCH");
  assertTrigger(actual, expected);
}

export async function verifyRolledBackCatalog(
  tx: postgres.TransactionSql,
  fileName: BundleFileName,
  applicationRole: string,
  migrationRole: string,
  databaseRole: string,
): Promise<void> {
  const definitions = bundleDefinitionRegistry[fileName];
  const catalog = bundleCatalogRegistry[fileName];
  const retainedRelations = retainedExactRelations(fileName);
  const removedRelations = definitions.exactColumnRelations.filter(
    (relation) => !retainedRelations.has(relation),
  );
  const compatibilityRelations = new Set(
    definitions.columns
      .map((column) => column.relation)
      .filter((relation) =>
        !definitions.exactColumnRelations.includes(relation)),
  );
  const retainedFunctionNames = retainedFunctions(fileName);
  const removedFunctions = definitions.functions
    .map((routine) => routine.name)
    .filter((name) => !retainedFunctionNames.has(name));
  const retainedTriggerNames = new Set([
    "enforce_hrms_bundle_operation_transition",
    "reject_hrms_bundle_operation_delete",
    "reject_hrms_bundle_operation_truncate",
    "verify_org_unit_parent_cycle",
  ]);
  const removedTriggers = catalog.triggers
    .map((trigger) => trigger.name)
    .filter((name) => !retainedTriggerNames.has(name));
  await assertRelationsAbsent(tx, [
    ...removedRelations,
    ...catalog.sequences,
  ]);
  await assertFunctionsAbsent(tx, removedFunctions);
  await assertEnumsAbsent(tx, definitions.enums.map((value) => value.name));
  await assertTriggersAbsent(tx, removedTriggers);
  await verifyDefinitionSubset(
    tx,
    fileName,
    compatibilityRelations,
    retainedFunctionNames,
    applicationRole,
    migrationRole,
    databaseRole,
  );
  await verifyRetainedCycleTrigger(tx, fileName);
  await verifyRetainedBundleLedger(
    tx,
    applicationRole,
    migrationRole,
    databaseRole,
  );
}
