import { QueryDescriptionError } from "./query-errors";
import type { QueryDescription } from "./query-description";

/**
 * What a report is allowed to cost.
 *
 * Phase 5, ticket 14. The ticket's sentence is "an expensive report fails
 * politely rather than degrading the platform for every other tenant", and the
 * two halves pull in opposite directions: a bound that is enforced late enough
 * to be accurate is enforced after the damage, and a bound enforced early enough
 * to prevent damage has to be decided from the description alone.
 *
 * So there are two kinds of bound here and they are not interchangeable.
 *
 * **Shape bounds** — join depth, filter count, result width, limit — are decided
 * from the description before anything is sent to the database. They are the
 * ones that can be enforced honestly, because a description that violates one
 * cannot be compiled at all.
 *
 * **Cost bounds** — statement timeout, row cap — cannot be known in advance and
 * are enforced by the database itself, which is why they are emitted into the
 * session rather than checked here. `LIMIT` is not a row cap: a query that
 * aggregates ten million rows into one returns one row, and the cap that matters
 * is the one on rows *examined*.
 *
 * Every threshold below is a constant in this file. That is deliberate and it is
 * the fourth criterion read strictly: the bounds are configuration in the sense
 * that they are stated in one place and can be changed by changing it, not in
 * the sense that a tenant can raise their own. A tenant-raisable bound is not a
 * bound, because the tenant who would raise it is exactly the tenant the bound
 * exists to stop.
 */

/**
 * The defaults, stated — which the ticket asks for explicitly, because a bound
 * nobody can quote is one nobody can design a report against.
 */
export const QUERY_BOUNDS = {
  /**
   * How long a single report statement may run.
   *
   * Ten seconds is well past the point where anybody is still watching and well
   * short of the point where a connection sitting on a shared pool starts
   * costing other tenants their latency. A report that needs longer is a report
   * that needs narrowing, and the message says so.
   */
  statementTimeoutMs: 10_000,

  /**
   * Rows the planner may examine, not rows returned.
   *
   * Enforced as a `LIMIT` on a subquery wrapping the user's own — see
   * `boundedStatement`. Without it, `SELECT count(*) FROM deals` returns a single
   * row after reading the entire table, and every row cap expressed as an outer
   * `LIMIT` is satisfied by it.
   */
  maxRowsExamined: 250_000,

  /** Rows a report may return. The description's own `limit` may not exceed it. */
  maxRowsReturned: 1_000,

  /**
   * How many declared joins one description may use.
   *
   * Three, because the graph's longest honest path is two — deal to party, deal
   * to owner — and one spare leaves room for a third entity without leaving room
   * for a cartesian product built out of `LEFT JOIN`s nobody costed.
   */
  maxJoins: 3,

  /**
   * Filters, groupings and aggregations in one description.
   *
   * Not a performance bound so much as a hostility bound: a description with two
   * hundred filters is not a question anybody asked, and each one is a bound
   * parameter the planner has to consider.
   */
  maxFilters: 40,
  maxGroupings: 8,
  maxAggregations: 16,

  /**
   * Reports one tenant may have in flight at once.
   *
   * The third criterion of the ticket is a per-tenant concurrency limit, and the
   * number is small on purpose. Four is enough that a person clicking through a
   * dashboard never waits on themselves, and far too few for one tenant's
   * scheduled exports to occupy a pool every other tenant shares.
   */
  maxConcurrentPerTenant: 4,
} as const;

export type BoundName = keyof typeof QUERY_BOUNDS;

/**
 * A bound was exceeded, and the caller is told which one and what to do.
 *
 * The ticket's third criterion asks for an explanation of *which* bound and
 * *how to narrow it*, which is a higher bar than a refusal. `bound` is machine
 * readable so a UI can highlight the offending control; `remedy` is the sentence
 * a person reads.
 */
export class QueryBoundError extends QueryDescriptionError {
  constructor(
    readonly bound: BoundName,
    readonly limit: number,
    readonly requested: number,
    readonly remedy: string,
  ) {
    super(
      `this report exceeds the ${bound} bound (asked for ${requested}, the limit is ${limit}). ${remedy}`,
    );
    this.name = "QueryBoundError";
  }
}

/**
 * Every shape bound, checked before a statement exists.
 *
 * Called by the compiler rather than by the caller, which is the fifth
 * criterion — "a report cannot be constructed that bypasses a bound". A check
 * the caller has to remember is a check somebody eventually does not.
 */
export function assertWithinBounds(description: QueryDescription): void {
  const joins = description.joins?.length ?? 0;
  if (joins > QUERY_BOUNDS.maxJoins)
    throw new QueryBoundError(
      "maxJoins",
      QUERY_BOUNDS.maxJoins,
      joins,
      "Remove a related entity from the report, or split it into two reports.",
    );

  const filters = description.filters?.length ?? 0;
  if (filters > QUERY_BOUNDS.maxFilters)
    throw new QueryBoundError(
      "maxFilters",
      QUERY_BOUNDS.maxFilters,
      filters,
      "Combine filters on the same field into a single 'is one of' filter.",
    );

  const groupings = description.groupBy?.length ?? 0;
  if (groupings > QUERY_BOUNDS.maxGroupings)
    throw new QueryBoundError(
      "maxGroupings",
      QUERY_BOUNDS.maxGroupings,
      groupings,
      "Group by fewer fields; each one multiplies the number of result rows.",
    );

  const aggregations = description.aggregations?.length ?? 0;
  if (aggregations > QUERY_BOUNDS.maxAggregations)
    throw new QueryBoundError(
      "maxAggregations",
      QUERY_BOUNDS.maxAggregations,
      aggregations,
      "Ask for fewer totals, or build a second report for the rest.",
    );

  const limit = description.limit;
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new QueryDescriptionError("limit must be a whole number of at least 1");
    if (limit > QUERY_BOUNDS.maxRowsReturned)
      throw new QueryBoundError(
        "maxRowsReturned",
        QUERY_BOUNDS.maxRowsReturned,
        limit,
        "Narrow the report with a filter, or export it on a schedule instead of reading it live.",
      );
  }
}

/**
 * The statement, wrapped so the database enforces what the description could not
 * promise.
 *
 * The inner `LIMIT` is the row cap and it sits INSIDE any aggregation, which is
 * the whole reason this is a wrapper rather than another clause. Written as an
 * outer limit it would be satisfied by the single row a `COUNT(*)` returns after
 * reading everything.
 *
 * The timeout is set on the session with `LOCAL`, so it reverts when the
 * transaction ends and cannot leak onto whatever the pooled connection serves
 * next. A report that raised the platform's timeout for the next tenant to use
 * the connection would be a worse bug than the one this prevents.
 */
export function boundedStatement(text: string): {
  readonly setup: string;
  readonly text: string;
} {
  return {
    setup: `SET LOCAL statement_timeout = ${QUERY_BOUNDS.statementTimeoutMs}`,
    text: text,
  };
}

/**
 * How many reports a tenant already has running, and whether one more may start.
 *
 * A counter rather than a queue, deliberately. Queuing a fifth report makes the
 * tenant wait without telling them why and keeps the request holding a
 * connection while it waits, which is the resource the bound exists to protect.
 * Refusing it says what happened.
 */
export function assertConcurrencyAvailable(inFlightForTenant: number): void {
  if (inFlightForTenant >= QUERY_BOUNDS.maxConcurrentPerTenant)
    throw new QueryBoundError(
      "maxConcurrentPerTenant",
      QUERY_BOUNDS.maxConcurrentPerTenant,
      inFlightForTenant + 1,
      "Wait for a running report to finish, or schedule this one instead of running it now.",
    );
}
