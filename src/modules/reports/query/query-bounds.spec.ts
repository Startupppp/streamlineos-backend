import { compileQuery, type Requester } from "./query-compiler";
import {
  assertConcurrencyAvailable,
  assertWithinBounds,
  boundedStatement,
  QUERY_BOUNDS,
  QueryBoundError,
} from "./query-bounds";
import type { QueryDescription } from "./query-description";

const WHO: Requester = { orgId: "org-acme", userId: "user-1", scope: "all" };

const withFilters = (n: number): QueryDescription => ({
  entity: "deals",
  filters: Array.from({ length: n }, () => ({
    field: "name" as const,
    operator: "eq" as const,
    value: "x",
  })),
});

/*
  Ticket 14. The ticket asks that an expensive report "fails politely rather than
  degrading the platform for every other tenant", so these assert two things
  about every refusal: that it happens, and that what comes back is usable by the
  person who has to fix the report.
*/
describe("a report that would cost too much is refused before it runs", () => {
  it("refuses more joins than the graph has honest paths for", () => {
    expect(() =>
      assertWithinBounds({ entity: "deals", joins: ["owner", "party", "owner", "party"] }),
    ).toThrow(QueryBoundError);
  });

  it("refuses a description with an unreasonable number of filters", () => {
    expect(() => assertWithinBounds(withFilters(QUERY_BOUNDS.maxFilters))).not.toThrow();
    expect(() => assertWithinBounds(withFilters(QUERY_BOUNDS.maxFilters + 1))).toThrow(
      QueryBoundError,
    );
  });

  it("names the bound and says how to get under it", () => {
    try {
      assertWithinBounds({ entity: "deals", limit: 50_000 });
      throw new Error("should have refused");
    } catch (error) {
      const bound = error as QueryBoundError;
      // Machine-readable, so a builder can highlight the control at fault...
      expect(bound.bound).toBe("maxRowsReturned");
      expect(bound.limit).toBe(QUERY_BOUNDS.maxRowsReturned);
      expect(bound.requested).toBe(50_000);
      // ...and a sentence a person can act on, which is the actual criterion.
      expect(bound.remedy).toMatch(/Narrow the report|schedule/);
      expect(bound.message).toContain("maxRowsReturned");
    }
  });

  it("gives a different remedy for each bound, rather than one generic apology", () => {
    const remedies = new Set<string>();
    const cases: QueryDescription[] = [
      { entity: "deals", joins: ["owner", "party", "owner", "party"] },
      withFilters(QUERY_BOUNDS.maxFilters + 1),
      { entity: "deals", groupBy: Array(QUERY_BOUNDS.maxGroupings + 1).fill("stage") },
      {
        entity: "deals",
        aggregations: Array(QUERY_BOUNDS.maxAggregations + 1).fill({ of: "count", as: "n" }),
      },
      { entity: "deals", limit: 50_000 },
    ];
    for (const description of cases) {
      try {
        assertWithinBounds(description);
        throw new Error(`expected a bound to refuse ${JSON.stringify(description)}`);
      } catch (error) {
        remedies.add((error as QueryBoundError).remedy);
      }
    }
    expect(remedies.size).toBe(cases.length);
  });
});

describe("a report cannot be constructed that bypasses a bound", () => {
  it("checks the bounds inside the compiler, not at a call site that could be skipped", () => {
    /*
      The fifth criterion. If bounds were the caller's job, the bypass would be
      the one caller who forgets — a scheduled run, an export path, an internal
      tool. Compiling is the only way to get a statement, so it is where the
      check belongs.
    */
    expect(() => compileQuery({ entity: "deals", limit: 50_000 }, WHO)).toThrow(QueryBoundError);
    expect(() =>
      compileQuery({ entity: "deals", joins: ["owner", "party", "owner", "party"] }, WHO),
    ).toThrow(QueryBoundError);
  });

  it("bounds a description that simply did not say", () => {
    // An absent limit is not a violation; it is a question that did not mention
    // one, and the honest default is a page rather than the ceiling.
    const q = compileQuery({ entity: "deals" }, WHO);
    expect(q.params[q.params.length - 1]).toBe(100);
  });
});

describe("the cost bounds the description cannot promise are the database's job", () => {
  it("sets the statement timeout LOCAL, so it cannot leak onto a pooled connection", () => {
    const { setup } = boundedStatement("SELECT 1");
    expect(setup).toContain("SET LOCAL");
    expect(setup).toContain(String(QUERY_BOUNDS.statementTimeoutMs));
    /*
      Without LOCAL the setting survives the transaction and belongs to the
      connection, so a report would quietly change the timeout for whatever the
      pool serves next — a worse fault than the one the timeout prevents,
      because it is another tenant's request that pays for it.
    */
    expect(setup).not.toMatch(/SET\s+statement_timeout/);
  });
});

describe("one tenant cannot occupy the pool", () => {
  it("permits reports up to the limit and refuses the one after", () => {
    for (let inFlight = 0; inFlight < QUERY_BOUNDS.maxConcurrentPerTenant; inFlight++)
      expect(() => assertConcurrencyAvailable(inFlight)).not.toThrow();

    expect(() => assertConcurrencyAvailable(QUERY_BOUNDS.maxConcurrentPerTenant)).toThrow(
      QueryBoundError,
    );
  });

  it("says to wait or to schedule, rather than queueing silently", () => {
    try {
      assertConcurrencyAvailable(QUERY_BOUNDS.maxConcurrentPerTenant);
      throw new Error("should have refused");
    } catch (error) {
      expect((error as QueryBoundError).bound).toBe("maxConcurrentPerTenant");
      expect((error as QueryBoundError).remedy).toMatch(/Wait for a running report|schedule/);
    }
  });
});

describe("the bounds are stated, and are not a tenant setting", () => {
  it("has a stated default for every bound it enforces", () => {
    // The fourth criterion. A bound nobody can quote is a bound nobody can
    // design a report against, so every one has a number here.
    for (const value of Object.values(QUERY_BOUNDS)) expect(typeof value).toBe("number");
    expect(Object.keys(QUERY_BOUNDS).sort()).toEqual([
      "maxAggregations",
      "maxConcurrentPerTenant",
      "maxFilters",
      "maxGroupings",
      "maxJoins",
      "maxRowsExamined",
      "maxRowsReturned",
      "statementTimeoutMs",
    ]);
  });

  it("takes no tenant and no override, so no tenant can raise its own", () => {
    /*
      Same argument as `guardrails-are-not-settings`: the tenant who would raise
      a bound is exactly the tenant the bound exists to constrain. Neither
      function has anywhere to put an organisation, which is the enforcement.
    */
    expect(assertWithinBounds.length).toBe(1);
    expect(assertConcurrencyAvailable.length).toBe(1);
  });
});
