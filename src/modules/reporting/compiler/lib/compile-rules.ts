import {
  AGGREGATES,
  BINARY_OPERATORS,
  COMPARISON_OPERATORS,
  LIST_OPERATORS,
  RANGE_OPERATORS,
  SORT_DIRECTIONS,
  UNARY_OPERATORS,
  type Aggregate,
  type FieldType,
} from "../query-description";

/**
 * The compiler's fixed tables: which operators, aggregates and casts exist, and
 * which apply to which field type. Data, not behaviour — the clause compilers
 * beside this file consult them; `compile.ts` is the gate that runs them.
 */

export const OPERATOR_SET = new Set<string>(COMPARISON_OPERATORS);
export const UNARY_SET = new Set<string>(UNARY_OPERATORS);
export const BINARY_SET = new Set<string>(BINARY_OPERATORS);
export const LIST_SET = new Set<string>(LIST_OPERATORS);
export const RANGE_SET = new Set<string>(RANGE_OPERATORS);
export const AGGREGATE_SET = new Set<string>(AGGREGATES);
export const DIRECTION_SET = new Set<string>(SORT_DIRECTIONS);

/**
 * The cast every value of a given type is bound under.
 *
 * `numeric` for all numbers, so a `bigint` money column and an `integer` score
 * compare identically and neither route goes through a float. There is no entry
 * for `text` — a text parameter needs no help, and `$1::text` on a `party_type`
 * enum column would fail where the bare parameter is inferred correctly.
 */
export const CAST_FOR_TYPE: Partial<Record<FieldType, string>> = {
  number: "numeric",
  timestamp: "timestamp",
  date: "date",
  boolean: "boolean",
};

/** Which comparisons mean anything for which type. */
export const OPERATORS_FOR_TYPE: Record<FieldType, ReadonlySet<string>> = {
  text: new Set([...UNARY_OPERATORS, ...BINARY_OPERATORS, ...LIST_OPERATORS, "between"]),
  /**
   * Membership and equality, and nothing else. An enum's values are a closed
   * set the tenant did not choose, so substring matching over them answers no
   * real question — and Postgres would reject it outright rather than run it
   * slowly. Ordering comparisons are excluded for the same reason they are
   * excluded on booleans: `party_type > $1` is legal, follows declaration order,
   * and means nothing anybody intended.
   */
  enum: new Set([...UNARY_OPERATORS, "eq", "ne", ...LIST_OPERATORS]),
  /**
   * Ordering and ranges, but no substring matching. `contains` on a number would
   * have to cast the column to text to work, which silently discards every index
   * on it — a filter that turns a report into a sequential scan of the table.
   */
  number: new Set([
    ...UNARY_OPERATORS,
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    ...LIST_OPERATORS,
    "between",
  ]),
  timestamp: new Set([
    ...UNARY_OPERATORS,
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "between",
  ]),
  date: new Set([...UNARY_OPERATORS, "eq", "ne", "lt", "lte", "gt", "gte", "between"]),
  /**
   * Equality and nullness only. `>` on a boolean is legal Postgres and means
   * nothing anybody intended.
   */
  boolean: new Set([...UNARY_OPERATORS, "eq", "ne"]),
};

/** Which aggregates mean anything for which type, and what they return. */
export const AGGREGATE_RULES: Record<Aggregate, { readonly types: ReadonlySet<FieldType> | null }> = {
  /** Counting works on anything, including nothing — `COUNT(*)`. */
  count: { types: null },
  count_distinct: { types: null },
  sum: { types: new Set<FieldType>(["number"]) },
  avg: { types: new Set<FieldType>(["number"]) },
  /** Enums are omitted: Postgres orders them by declaration, which is not a fact about the business. */
  min: { types: new Set<FieldType>(["number", "timestamp", "date", "text"]) },
  max: { types: new Set<FieldType>(["number", "timestamp", "date", "text"]) },
};

export const SQL_AGGREGATE: Record<Aggregate, string> = {
  count: "COUNT",
  count_distinct: "COUNT",
  sum: "SUM",
  avg: "AVG",
  min: "MIN",
  max: "MAX",
};
