import type postgres from "postgres";
import { z } from "zod";
import { fail } from "./bundle-error";
import { readIndexDefinition, relationIdentity } from "./bundle-definition-query";
import type {
  CheckConstraintRequirement,
  ColumnRequirement,
  ExclusionConstraintRequirement,
  IndexRequirement,
} from "./bundle-definition-types";
import type { IndexRow } from "./bundle-definition-schema";

const expressionRowsSchema = z.array(z.object({
  expression: z.string(),
}));

const nullableExpressionRowsSchema = z.array(z.object({
  expression: z.string().nullable(),
}));

const definitionRowsSchema = z.array(z.object({
  definition: z.string(),
}));

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    fail("RUNNER_CATALOG_RECIPE_INVALID");
  return `"${value}"`;
}

function assertSqlFragment(value: string): void {
  if (
    value.trim().length === 0 ||
    value.includes(";") ||
    value.includes("--") ||
    value.includes("/*") ||
    value.includes("*/") ||
    value.includes("\0")
  )
    fail("RUNNER_CATALOG_RECIPE_INVALID");
}

function quotedRelation(relation: string): string {
  const identity = relationIdentity(relation);
  return `${quoteIdentifier(identity.schema)}.${quoteIdentifier(identity.name)}`;
}

function onlyRow<T>(rows: T[]): T {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined)
    fail("RUNNER_CATALOG_RECIPE_INVALID");
  return row;
}

export async function canonicalColumnDefault(
  tx: postgres.TransactionSql,
  requirement: ColumnRequirement,
): Promise<string | null> {
  if (requirement.defaultExpression === null) return null;
  assertSqlFragment(requirement.defaultExpression);
  const tempName = "__hrms_expected_default_shape";
  await tx.unsafe(`DROP TABLE IF EXISTS pg_temp.${quoteIdentifier(tempName)}`);
  await tx.unsafe(
    `CREATE TEMP TABLE ${quoteIdentifier(tempName)} ` +
    `(LIKE ${quotedRelation(requirement.relation)}) ON COMMIT DROP`,
  );
  await tx.unsafe(
    `ALTER TABLE pg_temp.${quoteIdentifier(tempName)} ` +
    `ALTER COLUMN ${quoteIdentifier(requirement.name)} ` +
    `SET DEFAULT ${requirement.defaultExpression}`,
  );
  const rawRows: unknown = await tx`
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid, true)
      AS expression
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_attrdef default_value
      ON default_value.adrelid = relation.oid
      AND default_value.adnum = attribute.attnum
    WHERE relation.oid = to_regclass(format('pg_temp.%I', ${tempName}))
      AND attribute.attname = ${requirement.name}
  `;
  return onlyRow(nullableExpressionRowsSchema.parse(rawRows)).expression;
}

export async function canonicalCheckExpression(
  tx: postgres.TransactionSql,
  requirement: CheckConstraintRequirement,
): Promise<string> {
  assertSqlFragment(requirement.expression);
  const tempName = "__hrms_expected_check_shape";
  const constraintName = "__hrms_expected_check";
  await tx.unsafe(
    `DROP TABLE IF EXISTS pg_temp.${quoteIdentifier(tempName)}`,
  );
  await tx.unsafe(
    `CREATE TEMP TABLE ${quoteIdentifier(tempName)} ` +
    `(LIKE ${quotedRelation(requirement.relation)}) ON COMMIT DROP`,
  );
  await tx.unsafe(
    `ALTER TABLE pg_temp.${quoteIdentifier(tempName)} ` +
    `ADD CONSTRAINT ${quoteIdentifier(constraintName)} ` +
    `CHECK (${requirement.expression})`,
  );
  const rawRows: unknown = await tx`
    SELECT pg_get_expr(
      catalog_constraint.conbin,
      catalog_constraint.conrelid,
      true
    ) AS expression
    FROM pg_constraint catalog_constraint
    WHERE catalog_constraint.conrelid = to_regclass(
      format('pg_temp.%I', ${tempName})
    )
      AND catalog_constraint.conname = ${constraintName}
  `;
  const rows = expressionRowsSchema.parse(rawRows);
  return onlyRow(rows).expression;
}

export async function canonicalExclusionDefinition(
  tx: postgres.TransactionSql,
  requirement: ExclusionConstraintRequirement,
): Promise<string> {
  for (const element of requirement.elements) {
    assertSqlFragment(element.expression);
    assertSqlFragment(element.operator);
  }
  if (requirement.predicate !== null)
    assertSqlFragment(requirement.predicate);
  const tempName = "__hrms_expected_exclusion_shape";
  const constraintName = "__hrms_expected_exclusion";
  await tx.unsafe(`DROP TABLE IF EXISTS pg_temp.${quoteIdentifier(tempName)}`);
  await tx.unsafe(
    `CREATE TEMP TABLE ${quoteIdentifier(tempName)} ` +
    `(LIKE ${quotedRelation(requirement.relation)}) ON COMMIT DROP`,
  );
  const elements = requirement.elements.map(
    (element) => `${element.expression} WITH ${element.operator}`,
  ).join(", ");
  const predicate = requirement.predicate === null
    ? ""
    : ` WHERE (${requirement.predicate})`;
  await tx.unsafe(
    `ALTER TABLE pg_temp.${quoteIdentifier(tempName)} ` +
    `ADD CONSTRAINT ${quoteIdentifier(constraintName)} ` +
    `EXCLUDE USING gist (${elements})${predicate}`,
  );
  const rawRows: unknown = await tx`
    SELECT pg_get_constraintdef(catalog_constraint.oid, true) AS definition
    FROM pg_constraint catalog_constraint
    WHERE catalog_constraint.conrelid = to_regclass(
      format('pg_temp.%I', ${tempName})
    )
      AND catalog_constraint.conname = ${constraintName}
  `;
  return onlyRow(definitionRowsSchema.parse(rawRows)).definition;
}

export async function canonicalIndexDefinition(
  tx: postgres.TransactionSql,
  requirement: IndexRequirement,
): Promise<IndexRow> {
  for (const key of requirement.keys) assertSqlFragment(key);
  if (requirement.predicate !== null)
    assertSqlFragment(requirement.predicate);
  const tempName = "__hrms_expected_index_shape";
  const indexName = "__hrms_expected_index";
  await tx.unsafe(
    `DROP TABLE IF EXISTS pg_temp.${quoteIdentifier(tempName)}`,
  );
  await tx.unsafe(
    `CREATE TEMP TABLE ${quoteIdentifier(tempName)} ` +
    `(LIKE ${quotedRelation(requirement.relation)}) ON COMMIT DROP`,
  );
  const unique = requirement.unique ? "UNIQUE " : "";
  const predicate = requirement.predicate === null
    ? ""
    : ` WHERE ${requirement.predicate}`;
  await tx.unsafe(
    `CREATE ${unique}INDEX ${quoteIdentifier(indexName)} ` +
    `ON pg_temp.${quoteIdentifier(tempName)} USING btree ` +
    `(${requirement.keys.join(", ")})${predicate}`,
  );
  return readIndexDefinition(tx, "pg_temp", indexName);
}
