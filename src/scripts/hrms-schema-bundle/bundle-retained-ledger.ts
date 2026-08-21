import type postgres from "postgres";
import { assertExactTriggers } from "./bundle-catalog";
import { bundleCatalogRegistry } from "./bundle-catalog-registry";
import {
  assertColumnDefinition,
  assertConstraintDefinition,
  assertExactColumnNames,
  assertExactConstraintSet,
  assertExactIndexSet,
  assertFunctionDefinition,
  assertIndexDefinition,
} from "./bundle-definition-assertions";
import {
  readColumnDefinition,
  readConstraintDefinition,
  readFunctionDefinitions,
  readIndexDefinition,
} from "./bundle-definition-query";
import {
  canonicalCheckExpression,
  canonicalColumnDefault,
  canonicalIndexDefinition,
} from "./bundle-definition-shape";
import {
  readRelationColumnNames,
  readRelationConstraintSet,
  readRelationIndexSet,
} from "./bundle-definition-set-query";
import type { ConstraintDefinitionRequirement } from "./bundle-definition-types";
import { definitions0000 } from "./bundle-definitions-0000";
import { fail } from "./bundle-error";
import { verifyOperationLedger } from "./bundle-ledger";

const relation = "app.hrms_sql_bundle_operations";
const retainedFunctions = new Set([
  "enforce_hrms_bundle_operation_transition",
  "reject_hrms_append_only_mutation",
]);

function constraintType(
  requirement: ConstraintDefinitionRequirement,
): string {
  if (requirement.kind === "primary") return "p";
  if (requirement.kind === "unique") return "u";
  if (requirement.kind === "foreign") return "f";
  if (requirement.kind === "check") return "c";
  return "x";
}

export async function verifyRetainedBundleLedger(
  tx: postgres.TransactionSql,
  applicationRole: string,
  migrationRole: string,
  databaseRole: string,
): Promise<void> {
  await verifyOperationLedger(tx, applicationRole, migrationRole);
  const columns = definitions0000.columns.filter(
    (column) => column.relation === relation,
  );
  assertExactColumnNames(
    await readRelationColumnNames(tx, relation),
    columns.map((column) => column.name),
  );
  for (const column of columns) {
    const actual = await readColumnDefinition(tx, relation, column.name);
    const expectedDefault = await canonicalColumnDefault(tx, column);
    assertColumnDefinition(actual, column, expectedDefault);
  }
  const constraints = definitions0000.constraints.filter(
    (constraint) => constraint.relation === relation,
  );
  assertExactConstraintSet(
    await readRelationConstraintSet(tx, relation),
    constraints.map((constraint) => ({
      name: constraint.name,
      type: constraintType(constraint),
    })),
  );
  for (const constraint of constraints) {
    const actual = await readConstraintDefinition(
      tx,
      relation,
      constraint.name,
    );
    const expected = constraint.kind === "check"
      ? await canonicalCheckExpression(tx, constraint)
      : null;
    assertConstraintDefinition(actual, constraint, expected);
  }
  const indexes = definitions0000.indexes.filter(
    (index) => index.relation === relation,
  );
  const indexNames = [
    ...indexes.map((index) => index.name),
    ...constraints
      .filter((constraint) =>
        ["primary", "unique", "exclude"].includes(constraint.kind))
      .map((constraint) => constraint.name),
  ];
  assertExactIndexSet(await readRelationIndexSet(tx, relation), indexNames);
  for (const index of indexes) {
    const actual = await readIndexDefinition(tx, "app", index.name);
    const canonical = await canonicalIndexDefinition(tx, index);
    assertIndexDefinition(actual, canonical, index);
  }
  for (const expected of definitions0000.functions) {
    if (!retainedFunctions.has(expected.name)) continue;
    const rows = await readFunctionDefinitions(
      tx,
      expected.name,
      applicationRole,
      migrationRole,
    );
    const actual = rows[0];
    if (rows.length !== 1 || !actual)
      fail("RUNNER_CATALOG_FUNCTION_MISMATCH");
    assertFunctionDefinition(actual, expected, databaseRole);
  }
  const catalog = bundleCatalogRegistry["0000_hrms_profiles_workforce.sql"];
  await assertExactTriggers(
    tx,
    relation,
    catalog.triggers.filter((trigger) => trigger.relation === relation),
  );
}
