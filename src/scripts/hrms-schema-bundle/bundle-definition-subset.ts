import type postgres from "postgres";
import {
  assertColumnDefinition,
  assertConstraintDefinition,
  assertFunctionDefinition,
  assertIndexDefinition,
} from "./bundle-definition-assertions";
import {
  readColumnDefinition,
  readConstraintDefinition,
  readFunctionDefinitions,
  readIndexDefinition,
  relationIdentity,
} from "./bundle-definition-query";
import { bundleDefinitionRegistry } from "./bundle-definition-registry";
import {
  canonicalCheckExpression,
  canonicalColumnDefault,
  canonicalExclusionDefinition,
  canonicalIndexDefinition,
} from "./bundle-definition-shape";
import type { BundleFileName } from "./bundle-config";
import { fail } from "./bundle-error";

export async function verifyDefinitionSubset(
  tx: postgres.TransactionSql,
  fileName: BundleFileName,
  relations: Set<string>,
  functions: Set<string>,
  applicationRole: string,
  migrationRole: string,
  databaseRole: string,
): Promise<void> {
  const requirement = bundleDefinitionRegistry[fileName];
  for (const column of requirement.columns) {
    if (!relations.has(column.relation)) continue;
    const actual = await readColumnDefinition(tx, column.relation, column.name);
    const expectedDefault = await canonicalColumnDefault(tx, column);
    assertColumnDefinition(actual, column, expectedDefault);
  }
  for (const constraint of requirement.constraints) {
    if (!relations.has(constraint.relation)) continue;
    const actual = await readConstraintDefinition(
      tx,
      constraint.relation,
      constraint.name,
    );
    const expected = constraint.kind === "check"
      ? await canonicalCheckExpression(tx, constraint)
      : constraint.kind === "exclude"
        ? await canonicalExclusionDefinition(tx, constraint)
        : null;
    assertConstraintDefinition(actual, constraint, expected);
  }
  for (const index of requirement.indexes) {
    if (!relations.has(index.relation)) continue;
    const identity = relationIdentity(index.relation);
    const actual = await readIndexDefinition(tx, identity.schema, index.name);
    const canonical = await canonicalIndexDefinition(tx, index);
    assertIndexDefinition(actual, canonical, index);
  }
  for (const expected of requirement.functions) {
    if (!functions.has(expected.name)) continue;
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
}
