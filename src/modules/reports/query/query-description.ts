/**
 * What a tenant may ask for.
 *
 * Phase 5, ticket 10. Every field here is a KEY into `QUERY_GRAPH` or a value to
 * be bound as a parameter. Nothing in this type is SQL, and nothing in it can
 * become SQL: the compiler reads identifiers out of the graph and binds
 * everything else, so a description carrying `"; DROP TABLE deals; --"` produces
 * a query that searches for a deal named that.
 *
 * Note what is ABSENT, because ticket 11 turns on it: there is no organisation,
 * no user, no scope and no raw predicate. A report cannot opt out of tenancy
 * because there is nowhere in this type to say so — the compiler supplies it, and
 * `query-compiler.spec.ts` asserts the shape stays that way.
 */
export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "in",
  "isNull",
  "isNotNull",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const AGGREGATIONS = ["count", "sum", "avg", "min", "max"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export type FilterValue = string | number | boolean | null | readonly (string | number)[];

export interface QueryFilter {
  /** `field` on the root entity, or `join.field` through a declared join. */
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value?: FilterValue;
}

export interface QueryAggregation {
  readonly of: Aggregation;
  /** Omitted for `count`, which counts rows. */
  readonly field?: string;
  readonly as: string;
}

export interface QueryOrdering {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export interface QueryDescription {
  readonly entity: string;
  /** Declared join keys, never join clauses. */
  readonly joins?: readonly string[];
  readonly select?: readonly string[];
  readonly filters?: readonly QueryFilter[];
  readonly groupBy?: readonly string[];
  readonly aggregations?: readonly QueryAggregation[];
  readonly orderBy?: readonly QueryOrdering[];
  readonly limit?: number;
}
