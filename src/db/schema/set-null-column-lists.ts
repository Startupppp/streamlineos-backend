import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

/**
 * Drizzle's `onDelete("set null")` emits a bare `ON DELETE SET NULL`, and the
 * `UpdateDeleteAction` union has no room for Postgres's optional column list.
 * On a composite key whose members are not all nullable that bare form is a
 * defect: the delete tries to write NULL into a non-nullable column and raises
 * 23502 rather than doing anything. The database therefore has to carry
 * `ON DELETE SET NULL (<nullable members>)`, which the declaration cannot say
 * and which `information_schema.referential_constraints.delete_rule` — the only
 * thing drizzle-kit introspects — cannot see either.
 *
 * This module states the rule the database is expected to follow, derived from
 * the declaration itself so it can never go stale: for every declared SET NULL
 * foreign key, the columns Postgres may null are exactly its nullable members.
 * `set-null-column-lists.db.spec.ts` holds the catalog to it.
 */

export type DeclaredSetNullForeignKey = {
  schema: string;
  table: string;
  constraint: string;
  /** Every referencing column, in key order. */
  columns: string[];
  /** The nullable subset — the column list the constraint must carry. */
  setNullColumns: string[];
  /** False when every member is nullable and a bare SET NULL is already correct. */
  requiresColumnList: boolean;
};

export type UnreachableSetNullForeignKey = {
  schema: string;
  table: string;
  constraint: string;
  columns: string[];
};

export type SetNullDeclarations = {
  /** SET NULL foreign keys that have at least one nullable member. */
  declared: DeclaredSetNullForeignKey[];
  /**
   * SET NULL foreign keys with no nullable member at all. No column list can
   * rescue these; the delete action itself is wrong and every parent delete
   * raises 23502. This list must stay empty.
   */
  unreachable: UnreachableSetNullForeignKey[];
};

export function deriveSetNullDeclarations(
  schemaModule: Record<string, unknown>,
): SetNullDeclarations {
  const declared: DeclaredSetNullForeignKey[] = [];
  const unreachable: UnreachableSetNullForeignKey[] = [];

  for (const value of Object.values(schemaModule)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);

    for (const fk of config.foreignKeys) {
      if (fk.onDelete !== "set null") continue;
      const reference = fk.reference();
      const columns = reference.columns.map((column) => column.name);
      const setNullColumns = reference.columns
        .filter((column) => !column.notNull)
        .map((column) => column.name);
      const identity = {
        schema: config.schema ?? "public",
        table: config.name,
        constraint: fk.getName(),
        columns,
      };

      if (setNullColumns.length === 0) {
        unreachable.push(identity);
        continue;
      }
      declared.push({
        ...identity,
        setNullColumns,
        requiresColumnList: setNullColumns.length < columns.length,
      });
    }
  }

  const byName = (a: { schema: string; table: string; constraint: string }, b: typeof a) =>
    `${a.schema}.${a.table}.${a.constraint}`.localeCompare(`${b.schema}.${b.table}.${b.constraint}`);

  return { declared: declared.sort(byName), unreachable: unreachable.sort(byName) };
}

/**
 * Every SET NULL foreign key in the catalog whose effective set-null column set
 * contains a non-nullable column — the no-column-list form (0923/0927) and the
 * stale-column-list form (0916 against 0865) in one predicate. Lifted verbatim
 * from the sweep in 0770 and generalised to cover both.
 */
export const UNREACHABLE_SET_NULL_QUERY = `
SELECT nsp.nspname                  AS schema,
       rel.relname                  AS "table",
       con.conname                  AS constraint_name,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE con.contype = 'f'
  AND con.confdeltype = 'n'
  AND EXISTS (
    SELECT 1
    FROM unnest(COALESCE(con.confdelsetcols, con.conkey)) z(attnum)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = z.attnum
    WHERE a.attnotnull
  )
ORDER BY nsp.nspname, rel.relname, con.conname
`;

/** The set-null column set the catalog actually carries, per SET NULL constraint. */
export const SET_NULL_COLUMN_SETS_QUERY = `
SELECT nsp.nspname AS schema,
       rel.relname AS "table",
       con.conname AS constraint_name,
       (SELECT array_agg(a.attname ORDER BY x.ord)
          FROM unnest(con.conkey) WITH ORDINALITY x(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum)
         AS key_columns,
       (SELECT array_agg(a.attname ORDER BY a.attnum)
          FROM unnest(COALESCE(con.confdelsetcols, con.conkey)) k(attnum)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
         AS set_null_columns
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE con.contype = 'f'
  AND con.confdeltype = 'n'
ORDER BY nsp.nspname, rel.relname, con.conname
`;
