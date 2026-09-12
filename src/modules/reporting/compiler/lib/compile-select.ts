import { quoteIdent } from "../emit";
import { QueryCompilationError } from "../errors";
import { QUERY_LIMITS, type Projection, type QueryDescription } from "../query-description";
import type { CompiledColumn, ResolvedField } from "../compile.types";
import { AGGREGATE_RULES, AGGREGATE_SET, SQL_AGGREGATE } from "./compile-rules";
import { qualified } from "./compile-resolution";

// ── SELECT ───────────────────────────────────────────────────────────────────

export function compileSelect(
  select: unknown,
  resolve: (name: unknown, path: string) => ResolvedField,
): { projections: string[]; columns: CompiledColumn[] } {
  if (!Array.isArray(select) || select.length === 0)
    throw new QueryCompilationError(
      "malformed_description",
      "select must be a non-empty array",
      "select",
    );
  if (select.length > QUERY_LIMITS.maxSelect)
    throw new QueryCompilationError(
      "limit_exceeded",
      `select may not exceed ${QUERY_LIMITS.maxSelect} columns`,
      "select",
    );

  const projections: string[] = [];
  const columns: CompiledColumn[] = [];

  select.forEach((entry: unknown, index) => {
    const path = `select[${index}]`;
    if (entry === null || typeof entry !== "object")
      throw new QueryCompilationError("malformed_description", "projection must be an object", path);

    /**
     * The output alias is `c${index}` — generated here, never the caller's
     * label. A caller-chosen alias would be the one identifier in the statement
     * that came from outside the registry, which is precisely the hole this
     * module exists to not have. The caller gets its labels back in `columns`
     * and joins them to the rows by position.
     */
    const alias = `c${index}`;
    const projection = entry as Projection;

    if (projection.kind === "field") {
      const field = resolve(projection.field, `${path}.field`);
      projections.push(`${qualified(field.alias, field.column)} AS ${quoteIdent(alias)}`);
      columns.push({ alias, projection: { kind: "field", field: projection.field }, type: field.type });
      return;
    }

    if (projection.kind !== "aggregate")
      throw new QueryCompilationError(
        "malformed_description",
        "projection kind must be 'field' or 'aggregate'",
        path,
      );

    const aggregate = projection.aggregate;
    if (typeof aggregate !== "string" || !AGGREGATE_SET.has(aggregate))
      throw new QueryCompilationError(
        "unknown_aggregate",
        `unknown aggregate ${JSON.stringify(aggregate)}`,
        `${path}.aggregate`,
      );

    if (projection.field === undefined) {
      if (aggregate !== "count")
        throw new QueryCompilationError(
          "malformed_description",
          `aggregate ${aggregate} requires a field`,
          `${path}.field`,
        );
      projections.push(`COUNT(*) AS ${quoteIdent(alias)}`);
      columns.push({ alias, projection: { kind: "aggregate", aggregate }, type: "number" });
      return;
    }

    const field = resolve(projection.field, `${path}.field`);
    const allowed = AGGREGATE_RULES[aggregate].types;
    if (allowed !== null && !allowed.has(field.type))
      throw new QueryCompilationError(
        "operator_type_mismatch",
        `aggregate ${aggregate} does not apply to a ${field.type} field`,
        `${path}.aggregate`,
      );

    const inner = qualified(field.alias, field.column);
    const distinct = aggregate === "count_distinct" ? "DISTINCT " : "";
    projections.push(
      `${SQL_AGGREGATE[aggregate]}(${distinct}${inner}) AS ${quoteIdent(alias)}`,
    );
    columns.push({
      alias,
      projection: { kind: "aggregate", aggregate, field: projection.field },
      /** Counts and sums come back as numbers; min/max keep the column's type. */
      type:
        aggregate === "count" || aggregate === "count_distinct" || aggregate === "sum" || aggregate === "avg"
          ? "number"
          : field.type,
    });
  });

  return { projections, columns };
}

// ── GROUP BY ─────────────────────────────────────────────────────────────────

export function compileGroupBy(
  groupBy: unknown,
  resolve: (name: unknown, path: string) => ResolvedField,
): string[] {
  if (groupBy === undefined) return [];
  if (!Array.isArray(groupBy))
    throw new QueryCompilationError("malformed_description", "groupBy must be an array", "groupBy");
  if (groupBy.length > QUERY_LIMITS.maxGroupBy)
    throw new QueryCompilationError(
      "limit_exceeded",
      `groupBy may not exceed ${QUERY_LIMITS.maxGroupBy} keys`,
      "groupBy",
    );
  return groupBy.map((name: unknown, index) => {
    const field = resolve(name, `groupBy[${index}]`);
    return qualified(field.alias, field.column);
  });
}

/**
 * Refuse a grouped projection Postgres would reject, before it reaches Postgres.
 *
 * The rule is the SQL one: once anything is aggregated, every bare column in the
 * projection must be grouped. Postgres enforces it too — the reason to do it
 * here is that its error arrives as a database exception at run time, after the
 * report was saved, shared and scheduled, whereas this one arrives at the moment
 * somebody builds the report. A saved report that has never run is the thing to
 * avoid; a compiler that only fails in production is how you get one.
 */
export function assertGroupingIsValid(
  description: QueryDescription,
  columns: readonly CompiledColumn[],
): void {
  const hasAggregate = columns.some((c) => c.projection.kind === "aggregate");
  if (!hasAggregate) return;

  const groupedNames = new Set((description.groupBy ?? []).map(String));
  const ungrouped = columns
    .filter((c) => c.projection.kind === "field" && !groupedNames.has(c.projection.field))
    .map((c) => (c.projection.kind === "field" ? c.projection.field : ""));

  if (ungrouped.length > 0)
    throw new QueryCompilationError(
      "invalid_grouping",
      `these fields are selected alongside an aggregate but not grouped: ${ungrouped.join(", ")}`,
      "groupBy",
    );
}
