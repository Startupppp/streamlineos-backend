import type postgres from "postgres";
import { z } from "zod";
import { relationIdentity } from "./bundle-definition-query";

const constraintRowsSchema = z.array(z.object({
  name: z.string(),
  type: z.string(),
}));

const indexRowsSchema = z.array(z.object({
  name: z.string(),
}));

const columnRowsSchema = z.array(z.object({
  name: z.string(),
}));

export type ConstraintIdentity = z.infer<
  typeof constraintRowsSchema
>[number];

export async function readRelationColumnNames(
  tx: postgres.TransactionSql,
  relation: string,
): Promise<string[]> {
  const identity = relationIdentity(relation);
  const rawRows: unknown = await tx`
    SELECT attribute.attname AS name
    FROM pg_attribute attribute
    JOIN pg_class target ON target.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = target.relnamespace
    WHERE namespace.nspname = ${identity.schema}
      AND target.relname = ${identity.name}
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  `;
  return columnRowsSchema.parse(rawRows).map((row) => row.name);
}

export async function readRelationConstraintSet(
  tx: postgres.TransactionSql,
  relation: string,
): Promise<ConstraintIdentity[]> {
  const identity = relationIdentity(relation);
  const rawRows: unknown = await tx`
    SELECT catalog_constraint.conname AS name,
      catalog_constraint.contype::text AS type
    FROM pg_constraint catalog_constraint
    JOIN pg_class target ON target.oid = catalog_constraint.conrelid
    JOIN pg_namespace namespace ON namespace.oid = target.relnamespace
    WHERE namespace.nspname = ${identity.schema}
      AND target.relname = ${identity.name}
    ORDER BY catalog_constraint.conname
  `;
  return constraintRowsSchema.parse(rawRows);
}

export async function readRelationIndexSet(
  tx: postgres.TransactionSql,
  relation: string,
): Promise<string[]> {
  const identity = relationIdentity(relation);
  const rawRows: unknown = await tx`
    SELECT index_relation.relname AS name
    FROM pg_index catalog_index
    JOIN pg_class target ON target.oid = catalog_index.indrelid
    JOIN pg_namespace namespace ON namespace.oid = target.relnamespace
    JOIN pg_class index_relation
      ON index_relation.oid = catalog_index.indexrelid
    WHERE namespace.nspname = ${identity.schema}
      AND target.relname = ${identity.name}
    ORDER BY index_relation.relname
  `;
  return indexRowsSchema.parse(rawRows).map((row) => row.name);
}
