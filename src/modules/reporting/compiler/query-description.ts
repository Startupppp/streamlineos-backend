/**
 * The whole vocabulary a tenant may speak when it asks a question.
 *
 * This file is the closed set. A description is data — named sources, named
 * fields, enumerated operators, and values — and *nothing here is SQL*. There is
 * no `expression` string, no `having` clause taking a fragment, no `raw` escape
 * hatch. That absence is the design: a reviewer auditing this module for
 * injection has to check that no field of this structure reaches the statement
 * as text, and the structure is small enough to check exhaustively.
 *
 * Every extension to reporting has to be an extension *here* first, which is the
 * point. Adding a capability means adding a case to a union and a branch to the
 * compiler, in a file whose specs attack every field. It is deliberately harder
 * than passing a string through.
 *
 * The types are the caller-facing shape; whether a given name exists is not a
 * question types can answer, and is settled against the registry at compile
 * time. See `compile.ts`.
 */

/**
 * What a field holds, as far as querying is concerned.
 *
 * Coarser than the column's Postgres type on purpose. The compiler needs to
 * decide two things — which operators mean anything, and what a value must look
 * like — and neither distinguishes `integer` from `bigint`. Collapsing them also
 * means the numeric cast is one cast (`numeric`), so a `bigint` money column and
 * an `integer` score compare the same way and no comparison silently goes
 * through a float.
 *
 * `enum` is a Postgres enum column, and it is separate from `text` because the
 * two accept different operators. `party_type ILIKE $1` is not a slow query, it
 * is an error — Postgres has no `~~*` operator between an enum and text — so a
 * `contains` filter on an enum column would be a 500 raised from inside the
 * tenant's transaction. Splitting the type is what turns that into a refusal at
 * compile time, and it is the reason this list is coarser than Postgres's types
 * but not as coarse as "text and everything else".
 */
export const FIELD_TYPES = [
  "text",
  "enum",
  "number",
  "boolean",
  "timestamp",
  "date",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Every comparison expressible. There is no other.
 *
 * Split by arity below rather than carrying an `arity` property, because the
 * compiler switches on the operator anyway and a table that can disagree with
 * the switch is a table that eventually does.
 *
 * Note the omissions. There is no `like` — a caller cannot supply a raw pattern,
 * only a substring that `contains` escapes into one, so `%` in a tenant's search
 * box means a percent sign. There is no `regex`: a caller-supplied regular
 * expression is a denial-of-service primitive against the database, and a
 * reporting surface is exactly where somebody would paste a catastrophic one.
 */
export const UNARY_OPERATORS = ["is_null", "is_not_null"] as const;
export const BINARY_OPERATORS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "starts_with",
  "ends_with",
] as const;
export const LIST_OPERATORS = ["in", "not_in"] as const;
export const RANGE_OPERATORS = ["between"] as const;

export const COMPARISON_OPERATORS = [
  ...UNARY_OPERATORS,
  ...BINARY_OPERATORS,
  ...LIST_OPERATORS,
  ...RANGE_OPERATORS,
] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

export const AGGREGATES = [
  "count",
  "count_distinct",
  "sum",
  "avg",
  "min",
  "max",
] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** A literal a tenant supplies. It always becomes a bind parameter. */
export type ScalarValue = string | number | boolean;

/**
 * One comparison.
 *
 * `field` is a *name*, resolved against the registry — either a field of the
 * base source (`"stage"`) or one reached through a declared join
 * (`"party.name"`). It is never a column, never an expression, and never
 * anything the compiler puts in the statement.
 *
 * The value is carried in three differently shaped slots rather than one
 * polymorphic `value`, so that "an `in` with no list" and "a `between` with one
 * bound" are shapes that do not typecheck, instead of runtime surprises. A
 * unary operator carries no value at all — which is how `= NULL`, the classic
 * source of silently-empty results, is made unrepresentable rather than
 * special-cased.
 */
export type FilterLeaf =
  | { kind: "compare"; field: string; operator: (typeof UNARY_OPERATORS)[number] }
  | {
      kind: "compare";
      field: string;
      operator: (typeof BINARY_OPERATORS)[number];
      value: ScalarValue;
    }
  | {
      kind: "compare";
      field: string;
      operator: (typeof LIST_OPERATORS)[number];
      values: readonly ScalarValue[];
    }
  | {
      kind: "compare";
      field: string;
      operator: (typeof RANGE_OPERATORS)[number];
      from: ScalarValue;
      to: ScalarValue;
    };

export type FilterNode =
  | FilterLeaf
  | { kind: "and"; nodes: readonly FilterNode[] }
  | { kind: "or"; nodes: readonly FilterNode[] }
  | { kind: "not"; node: FilterNode };

/**
 * One output column.
 *
 * `count` is the one aggregate that may omit its field, because `COUNT(*)` — how
 * many rows — is a different question from `COUNT(col)` — how many rows have
 * that column set, and both are worth asking.
 */
export type Projection =
  | { kind: "field"; field: string }
  | { kind: "aggregate"; aggregate: Aggregate; field?: string };

/**
 * How to sort, expressed as an index into `select`.
 *
 * Not a field name, and this is a security decision rather than an ergonomic
 * one. Sorting by a column the caller did not project is an oracle: repeated
 * queries ordered by a column you are not allowed to see will reconstruct its
 * ordering, and on a small table its values. Restricting `orderBy` to what is
 * already on its way back to the caller closes that channel by construction, and
 * has the side benefit that the emitted `ORDER BY` names a generated output
 * alias, so it needs no identifier resolution at all.
 */
export interface SortSpec {
  /** Zero-based index into `select`. */
  select: number;
  direction: SortDirection;
}

/**
 * A question, fully described.
 *
 * There is no `organizationId` here, and that omission is load-bearing: the
 * tenant predicate is an argument to the compiler, not a part of the
 * description, so no description — hostile, malformed, or replayed from another
 * tenant's saved report — can influence, weaken or omit it. See `compile.ts`.
 */
export interface QueryDescription {
  source: string;
  select: readonly Projection[];
  filter?: FilterNode;
  groupBy?: readonly string[];
  orderBy?: readonly SortSpec[];
  limit: number;
  offset?: number;
}

/**
 * Bounds. Every one of these is enforced by the compiler itself, not only by the
 * DTO, because the compiler is the thing that must be safe when called with an
 * object that never went through a DTO.
 */
export const QUERY_LIMITS = {
  /** Output columns. Past this a "report" is a table dump wearing a hat. */
  maxSelect: 40,
  /** Comparison and boolean nodes in the filter tree, counted together. */
  maxFilterNodes: 100,
  /** Nesting of and/or/not. Bounded so parsing cannot be driven to a stack overflow. */
  maxFilterDepth: 6,
  /** Values in one `in` list. */
  maxInValues: 200,
  /** Grouping keys. */
  maxGroupBy: 10,
  /** Sort keys. */
  maxOrderBy: 5,
  /** Rows one run may return. */
  maxLimit: 1000,
  /** How far a caller may page in. Deep offsets are a table scan with extra steps. */
  maxOffset: 100_000,
  /** Characters in a text value. */
  maxValueLength: 1000,
} as const;
