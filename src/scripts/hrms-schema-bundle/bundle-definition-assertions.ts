import { createHash } from "node:crypto";
import {
  relationIdentity,
} from "./bundle-definition-query";
import type {
  ColumnRow,
  ConstraintRow,
  FunctionRow,
  IndexRow,
} from "./bundle-definition-schema";
import type { ConstraintIdentity } from "./bundle-definition-set-query";
import type {
  ColumnRequirement,
  ConstraintDefinitionRequirement,
  FunctionRequirement,
  IndexRequirement,
} from "./bundle-definition-types";
import { fail } from "./bundle-error";

function sameValues(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every(
    (value, index) => value === expected[index],
  );
}

function normalizeExpression(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/\s+/g, " ").trim();
}

export function assertExactConstraintSet(
  actual: ConstraintIdentity[],
  expected: ConstraintIdentity[],
): void {
  const actualRows = actual.map((row) => `${row.name}:${row.type}`).sort();
  const expectedRows = expected.map((row) => `${row.name}:${row.type}`).sort();
  if (!sameValues(actualRows, expectedRows))
    fail("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
}

export function assertExactIndexSet(
  actual: string[],
  expected: string[],
): void {
  if (!sameValues([...actual].sort(), [...expected].sort()))
    fail("RUNNER_CATALOG_INDEX_MISMATCH");
}

export function assertColumnDefinition(
  actual: ColumnRow,
  expected: ColumnRequirement,
  expectedDefault = expected.defaultExpression,
): void {
  if (
    actual.data_type !== expected.dataType ||
    actual.not_null !== expected.notNull ||
    actual.identity !== expected.identity ||
    normalizeExpression(actual.default_expression) !==
      normalizeExpression(expectedDefault)
  )
    fail("RUNNER_CATALOG_COLUMN_MISMATCH");
}

function assertConstraintBase(
  actual: ConstraintRow,
  expected: ConstraintDefinitionRequirement,
): void {
  if (
    actual.validated !== expected.validated ||
    actual.deferrable !== expected.deferrable ||
    actual.initially_deferred !== expected.initiallyDeferred ||
    actual.no_inherit ||
    !actual.is_local ||
    actual.inheritance_count !== 0 ||
    actual.has_parent_constraint
  )
    fail("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
}

function assertBackingIndex(
  actual: ConstraintRow,
  method: "btree" | "gist",
): void {
  if (
    actual.backing_index_valid !== true ||
    actual.backing_index_ready !== true ||
    actual.backing_index_live !== true ||
    actual.backing_index_method !== method
  )
    fail("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
}

export function assertConstraintDefinition(
  actual: ConstraintRow,
  expected: ConstraintDefinitionRequirement,
  expectedShape: string | null,
): void {
  assertConstraintBase(actual, expected);
  if (expected.kind === "check") {
    if (
      actual.constraint_type !== "c" ||
      actual.referenced_relation !== null ||
      actual.referenced_schema !== null ||
      actual.match_type !== null ||
      actual.update_action !== null ||
      actual.delete_action !== null ||
      actual.nulls_not_distinct ||
      actual.backing_index_valid !== null ||
      actual.backing_index_ready !== null ||
      actual.backing_index_live !== null ||
      actual.backing_index_method !== null ||
      normalizeExpression(actual.check_expression) !==
        normalizeExpression(expectedShape)
    )
      fail("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
    return;
  }
  if (expected.kind === "exclude") {
    assertBackingIndex(actual, "gist");
    if (
      actual.constraint_type !== "x" ||
      actual.referenced_relation !== null ||
      actual.referenced_schema !== null ||
      actual.referenced_columns.length !== 0 ||
      actual.match_type !== null ||
      actual.update_action !== null ||
      actual.delete_action !== null ||
      actual.check_expression !== null ||
      actual.nulls_not_distinct ||
      normalizeExpression(actual.constraint_definition) !==
        normalizeExpression(expectedShape)
    )
      fail("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
    return;
  }
  if (expected.kind === "foreign") {
    if (
      actual.constraint_type !== "f" ||
      !sameValues(actual.columns, expected.columns) ||
      actual.referenced_schema !== "public" ||
      actual.referenced_relation !== expected.referencedRelation ||
      !sameValues(actual.referenced_columns, expected.referencedColumns) ||
      actual.match_type !== expected.matchType ||
      actual.update_action !== expected.updateAction ||
      actual.delete_action !== expected.deleteAction ||
      actual.check_expression !== null ||
      actual.nulls_not_distinct
    )
      fail("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
    return;
  }
  assertBackingIndex(actual, "btree");
  if (
    actual.constraint_type !== (expected.kind === "primary" ? "p" : "u") ||
    !sameValues(actual.columns, expected.columns) ||
    actual.referenced_relation !== null ||
    actual.referenced_schema !== null ||
    actual.referenced_columns.length !== 0 ||
    actual.match_type !== null ||
    actual.update_action !== null ||
    actual.delete_action !== null ||
    actual.check_expression !== null ||
    actual.nulls_not_distinct
  )
    fail("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
}

export function assertExactColumnNames(
  actual: string[],
  expected: string[],
): void {
  if (!sameValues(actual, expected))
    fail("RUNNER_CATALOG_COLUMN_MISMATCH");
}

export function assertIndexDefinition(
  actual: IndexRow,
  canonical: IndexRow,
  expected: IndexRequirement,
): void {
  const relation = relationIdentity(expected.relation);
  if (
    actual.relation_name !== relation.name ||
    actual.access_method !== "btree" ||
    actual.unique !== expected.unique ||
    actual.primary ||
    !actual.valid ||
    !actual.ready ||
    !actual.live ||
    actual.nulls_not_distinct ||
    actual.key_count !== expected.keys.length ||
    actual.attribute_count !== expected.keys.length ||
    !sameValues(actual.keys, canonical.keys) ||
    normalizeExpression(actual.predicate) !==
      normalizeExpression(canonical.predicate)
  )
    fail("RUNNER_CATALOG_INDEX_MISMATCH");
}

function normalizedSourceHash(source: string): string {
  return createHash("sha256")
    .update(source.replaceAll("\r\n", "\n").trim())
    .digest("hex");
}

export function assertFunctionDefinition(
  actual: FunctionRow,
  expected: FunctionRequirement,
  databaseRole: string,
): void {
  const directGrants = [`${databaseRole}:EXECUTE`];
  if (expected.publicExecute) directGrants.push("PUBLIC:EXECUTE");
  directGrants.sort();
  if (
    actual.owner_name !== databaseRole ||
    !sameValues(actual.argument_types, expected.argumentTypes) ||
    actual.result_type !== expected.resultType ||
    actual.language_name !== expected.language ||
    actual.security_definer !== expected.securityDefiner ||
    actual.volatility !== expected.volatility ||
    actual.strict !== expected.strict ||
    actual.leakproof ||
    actual.parallel_safety !== "u" ||
    !sameValues(actual.configuration, ["search_path=pg_catalog, public"]) ||
    !sameValues(actual.direct_grants, directGrants) ||
    actual.application_execute !== expected.publicExecute ||
    actual.migration_execute !== expected.publicExecute ||
    !expected.bodySha256.includes(normalizedSourceHash(actual.source))
  )
    fail("RUNNER_CATALOG_FUNCTION_MISMATCH");
}
