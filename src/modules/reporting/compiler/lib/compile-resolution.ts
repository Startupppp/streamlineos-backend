import { quoteIdent } from "../emit";
import { QueryCompilationError } from "../errors";
import {
  BASE_ALIAS,
  fieldsOf,
  joinsOf,
  type JoinSpec,
  type QueryRegistry,
  type SourceSpec,
} from "../registry";
import type { ResolvedField } from "../compile.types";

/**
 * Names to registry entries, and registry entries to emitted identifiers.
 *
 * Every identifier in a compiled statement comes through this file, and every
 * one of them is the registry's own string passed through `quoteIdent` — a
 * caller's name is only ever a lookup key. See the safety notes in `compile.ts`.
 */

export function lookupSource(registry: QueryRegistry, name: unknown): SourceSpec {
  if (typeof name !== "string")
    throw new QueryCompilationError("malformed_description", "source must be a string", "source");
  const spec = registry.get(name);
  if (!spec)
    /**
     * The message names the *caller's* string but the string never reaches SQL,
     * only an error a person reads. Echoing it is what makes a typo diagnosable;
     * the reason that is safe is that this throw happens before any emit.
     */
    throw new QueryCompilationError(
      "unknown_source",
      `no queryable source named ${JSON.stringify(name)}`,
      "source",
    );
  return spec;
}

/**
 * A name to a column, or a refusal.
 *
 * `"stage"` is a field of the base source. `"party.industry"` is a field reached
 * through the join declared as `party`. Exactly one dot: a second one is not a
 * deeper path, it is a name with a dot in it, and there is no such field. That
 * matters more than it looks — "split on the first dot and treat the rest as a
 * path" is how a resolver acquires a recursive traversal nobody bounded.
 */
export function resolveField(source: SourceSpec, name: unknown, path: string): ResolvedField {
  if (typeof name !== "string")
    throw new QueryCompilationError("malformed_description", "field must be a string", path);

  const parts = name.split(".");
  if (parts.length > 2)
    throw new QueryCompilationError(
      "unknown_field",
      `no field named ${JSON.stringify(name)}`,
      path,
    );

  if (parts.length === 1) {
    const field = fieldsOf(source).get(name);
    if (!field)
      throw new QueryCompilationError(
        "unknown_field",
        `source ${JSON.stringify(source.table)} has no field ${JSON.stringify(name)}`,
        path,
      );
    return { alias: BASE_ALIAS, column: field.column, type: field.type };
  }

  const [joinName, fieldName] = parts as [string, string];
  const join = joinsOf(source).get(joinName);
  if (!join)
    throw new QueryCompilationError(
      "unknown_field",
      `source ${JSON.stringify(source.table)} declares no relation ${JSON.stringify(joinName)}`,
      path,
    );
  const field = fieldsOf(join).get(fieldName);
  if (!field)
    throw new QueryCompilationError(
      "unknown_field",
      `relation ${JSON.stringify(joinName)} has no field ${JSON.stringify(fieldName)}`,
      path,
    );
  return { alias: join.alias, column: field.column, type: field.type, join };
}

export const qualified = (alias: string, column: string): string =>
  `${quoteIdent(alias)}.${quoteIdent(column)}`;

/**
 * A join carries the tenant predicate too.
 *
 * On a `LEFT JOIN` the org predicate has to sit in the `ON` clause, not the
 * `WHERE`: in the `WHERE` it would discard the rows where the join found
 * nothing, quietly turning the outer join into an inner one and dropping every
 * deal with no party from the report. Putting it in `ON` is what keeps "left
 * join" and "tenant isolated" from being in tension.
 *
 * It is also not redundant with RLS. The policies are the backstop; this is the
 * predicate the planner can actually use an index for, and a report that scans
 * every tenant's rows before RLS filters them is a report that times out.
 */
export function emitJoin(join: JoinSpec, orgParam: string): string {
  const conditions = [
    `${qualified(join.alias, join.foreignColumn)} = ${qualified(BASE_ALIAS, join.localColumn)}`,
    `${qualified(join.alias, join.organizationColumn)} = ${orgParam}`,
    ...(join.softDeleteColumn
      ? [`${qualified(join.alias, join.softDeleteColumn)} IS NULL`]
      : []),
  ];
  return `LEFT JOIN ${quoteIdent(join.table)} AS ${quoteIdent(join.alias)} ON ${conditions.join(" AND ")}`;
}
