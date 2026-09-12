import { quoteIdent, type ParamBag } from "../emit";
import { QueryCompilationError } from "../errors";
import { QUERY_LIMITS, SORT_DIRECTIONS, type QueryDescription } from "../query-description";
import type { CompiledColumn } from "../compile.types";
import { DIRECTION_SET } from "./compile-rules";

// ── ORDER BY, LIMIT, OFFSET ──────────────────────────────────────────────────

export function compileOrderBy(
  orderBy: unknown,
  columns: readonly CompiledColumn[],
): string[] {
  if (orderBy === undefined) return [];
  if (!Array.isArray(orderBy))
    throw new QueryCompilationError("malformed_description", "orderBy must be an array", "orderBy");
  if (orderBy.length > QUERY_LIMITS.maxOrderBy)
    throw new QueryCompilationError(
      "limit_exceeded",
      `orderBy may not exceed ${QUERY_LIMITS.maxOrderBy} keys`,
      "orderBy",
    );

  return orderBy.map((entry: unknown, index) => {
    const path = `orderBy[${index}]`;
    if (entry === null || typeof entry !== "object")
      throw new QueryCompilationError("malformed_description", "sort spec must be an object", path);
    const { select, direction } = entry as { select?: unknown; direction?: unknown };

    if (typeof select !== "number" || !Number.isInteger(select) || select < 0 || select >= columns.length)
      throw new QueryCompilationError(
        "invalid_order_target",
        `orderBy must name the index of a selected column (0..${columns.length - 1})`,
        `${path}.select`,
      );
    if (typeof direction !== "string" || !DIRECTION_SET.has(direction))
      throw new QueryCompilationError(
        "malformed_description",
        `direction must be one of ${SORT_DIRECTIONS.join(", ")}`,
        `${path}.direction`,
      );

    /**
     * `NULLS LAST` in both directions, rather than Postgres's default of nulls
     * last ascending and first descending. A report sorted by "largest deal
     * first" should not open with a screen of deals that have no value, and a
     * default that flips with the direction means the same report reads
     * differently depending on which arrow was clicked.
     */
    return `${quoteIdent(columns[select]!.alias)} ${direction === "asc" ? "ASC" : "DESC"} NULLS LAST`;
  });
}

/**
 * The row window.
 *
 * Bound as parameters rather than inlined, even though they are integers this
 * function has just proved safe. Inlining "safe" numbers is how a statement
 * acquires its first concatenation, and the next person adds one beside it
 * without re-deriving the proof. Everything is a parameter; there is no
 * judgement call at the call site.
 */
export function compileWindow(
  description: QueryDescription,
  params: ParamBag,
): { limit: string; offset: string } {
  const { limit, offset = 0 } = description;

  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
    throw new QueryCompilationError(
      "malformed_description",
      "limit must be a positive integer",
      "limit",
    );
  if (limit > QUERY_LIMITS.maxLimit)
    /**
     * Refused, not clamped. A silently clamped limit gives a caller a page of
     * results it believes is the whole answer, and a report that is quietly
     * truncated is worse than one that says it asked for too much.
     */
    throw new QueryCompilationError(
      "limit_exceeded",
      `limit may not exceed ${QUERY_LIMITS.maxLimit}`,
      "limit",
    );
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
    throw new QueryCompilationError(
      "malformed_description",
      "offset must be a non-negative integer",
      "offset",
    );
  if (offset > QUERY_LIMITS.maxOffset)
    throw new QueryCompilationError(
      "limit_exceeded",
      `offset may not exceed ${QUERY_LIMITS.maxOffset}`,
      "offset",
    );

  return { limit: params.bind(limit), offset: params.bind(offset) };
}
