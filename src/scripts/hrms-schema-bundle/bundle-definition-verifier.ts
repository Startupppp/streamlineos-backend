import type postgres from "postgres";
import type { BundleFileName } from "./bundle-config";
import { bundleDefinitionRegistry } from "./bundle-definition-registry";
import {
  readColumnDefinition,
  readConstraintDefinition,
  readEnumDefinition,
  readFunctionDefinitions,
  readIndexDefinition,
} from "./bundle-definition-query";
import {
  canonicalCheckExpression,
  canonicalColumnDefault,
  canonicalExclusionDefinition,
  canonicalIndexDefinition,
} from "./bundle-definition-shape";
import { fail } from "./bundle-error";
import { verifyOwnerOnlyRelation } from "./bundle-owner-only-relation";
import {
  readRelationConstraintSet,
  readRelationColumnNames,
  readRelationIndexSet,
} from "./bundle-definition-set-query";
import {
  assertColumnDefinition,
  assertConstraintDefinition,
  assertExactColumnNames,
  assertExactConstraintSet,
  assertExactIndexSet,
  assertFunctionDefinition,
  assertIndexDefinition,
} from "./bundle-definition-assertions";
export {
  assertColumnDefinition,
  assertConstraintDefinition,
  assertExactColumnNames,
  assertExactConstraintSet,
  assertExactIndexSet,
  assertFunctionDefinition,
  assertIndexDefinition,
} from "./bundle-definition-assertions";

function sameValues(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every(
    (value, index) => value === expected[index],
  );
}

function constraintType(requirement: { kind: string }): string {
  if (requirement.kind === "primary") return "p";
  if (requirement.kind === "unique") return "u";
  if (requirement.kind === "foreign") return "f";
  if (requirement.kind === "check") return "c";
  return "x";
}

export async function verifyBundleFileDefinitions(
  tx: postgres.TransactionSql,
  fileName: BundleFileName,
  applicationRole: string,
  migrationRole: string,
  databaseRole: string,
): Promise<void> {
  const requirement = bundleDefinitionRegistry[fileName];
  for (const relation of requirement.ownerOnlyRelations)
    await verifyOwnerOnlyRelation(
      tx,
      relation,
      applicationRole,
      migrationRole,
      databaseRole,
    );
  for (const relation of requirement.exactColumnRelations) {
    const actual = await readRelationColumnNames(tx, relation);
    const expected = requirement.columns
      .filter((column) => column.relation === relation)
      .map((column) => column.name);
    assertExactColumnNames(actual, expected);
    const expectedConstraints = requirement.constraints
      .filter((constraint) => constraint.relation === relation)
      .map((constraint) => ({
        name: constraint.name,
        type: constraintType(constraint),
      }));
    assertExactConstraintSet(
      await readRelationConstraintSet(tx, relation),
      expectedConstraints,
    );
    const expectedIndexes = [
      ...requirement.indexes
        .filter((index) => index.relation === relation)
        .map((index) => index.name),
      ...requirement.constraints
        .filter(
          (constraint) =>
            constraint.relation === relation &&
            ["primary", "unique", "exclude"].includes(constraint.kind),
        )
        .map((constraint) => constraint.name),
    ];
    assertExactIndexSet(
      await readRelationIndexSet(tx, relation),
      expectedIndexes,
    );
  }
  for (const column of requirement.columns) {
    const actual = await readColumnDefinition(tx, column.relation, column.name);
    const expectedDefault = await canonicalColumnDefault(tx, column);
    assertColumnDefinition(actual, column, expectedDefault);
  }
  for (const constraint of requirement.constraints) {
    const actual = await readConstraintDefinition(
      tx,
      constraint.relation,
      constraint.name,
    );
    const expectedShape = constraint.kind === "check"
      ? await canonicalCheckExpression(tx, constraint)
      : constraint.kind === "exclude"
        ? await canonicalExclusionDefinition(tx, constraint)
        : null;
    assertConstraintDefinition(actual, constraint, expectedShape);
  }
  for (const index of requirement.indexes) {
    const actual = await readIndexDefinition(tx, "public", index.name);
    const canonical = await canonicalIndexDefinition(tx, index);
    assertIndexDefinition(actual, canonical, index);
  }
  for (const expected of requirement.functions) {
    const rows = await readFunctionDefinitions(
      tx,
      expected.name,
      applicationRole,
      migrationRole,
    );
    if (rows.length !== 1) fail("RUNNER_CATALOG_FUNCTION_MISMATCH");
    const actual = rows[0];
    if (!actual) fail("RUNNER_CATALOG_FUNCTION_MISMATCH");
    assertFunctionDefinition(actual, expected, databaseRole);
  }
  for (const expected of requirement.enums) {
    const actual = await readEnumDefinition(
      tx,
      expected.name,
      applicationRole,
      migrationRole,
    );
    if (
      actual.owner_name !== databaseRole ||
      !sameValues(actual.labels, expected.labels) ||
      !actual.acl_matches_default ||
      !actual.application_usage ||
      !actual.migration_usage
    )
      fail("RUNNER_CATALOG_ENUM_MISMATCH");
  }
}
