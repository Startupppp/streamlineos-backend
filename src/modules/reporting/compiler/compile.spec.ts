import { compileQuery } from "./compile";
import { QueryCompilationError } from "./errors";
import { QUERY_LIMITS, type QueryDescription } from "./query-description";

/**
 * What the compiler builds, and what it refuses to build.
 *
 * This file is about *correctness* — that a description means what it says, and
 * that a description Postgres would reject is refused before it gets there.
 * `injection.spec.ts` is about safety. Splitting them keeps the safety file from
 * being diluted into a general test suite, because that file is the one somebody
 * should be able to read end to end before trusting this module.
 *
 * Every test here names a failure it prevents rather than a behaviour it
 * observes; a test called "compiles a group by" would still pass if the group by
 * were emitted against the wrong table.
 */

const ORG = "org_11111111";
/**
 * `all`, stated rather than omitted.
 *
 * Ticket 11 made `requester` required precisely so a call site cannot leave the
 * scope to a default. These tests are about compilation, not narrowing, so they
 * say `all` out loud — and `scope.spec.ts` is where the narrowing is proved.
 */
const ctx = { organizationId: ORG, requester: { userId: "user_1", scope: "all" as const } };

const compile = (description: QueryDescription) => compileQuery(description, ctx);

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof QueryCompilationError) return error.code;
    throw error;
  }
  throw new Error("expected the compiler to refuse, but it compiled");
};

describe("compiling a query description", () => {
  it("reads the source's own tenant column, not a column name it assumed", () => {
    /**
     * `deals.org_id` and `activities.organization_id` are genuinely different
     * names in this schema. A compiler that hardcoded either would emit a
     * statement filtered on a column that does not exist on the other table —
     * and the danger is not the error, it is the version of this code that
     * "fixes" the error with a fallback and ends up filtering on nothing.
     */
    const deals = compile({ source: "deals", select: [{ kind: "field", field: "stage" }], limit: 10 });
    const activities = compile({
      source: "activities",
      select: [{ kind: "field", field: "kind" }],
      limit: 10,
    });

    expect(deals.text).toContain(`"s"."org_id" = $1`);
    expect(activities.text).toContain(`"s"."organization_id" = $1`);
    expect(deals.params[0]).toBe(ORG);
    expect(activities.params[0]).toBe(ORG);
  });

  it("excludes soft-deleted rows, so a report never counts deleted customers", () => {
    const compiled = compile({
      source: "parties",
      select: [{ kind: "aggregate", aggregate: "count" }],
      limit: 10,
    });
    expect(compiled.text).toContain(`"s"."deleted_at" IS NULL`);
  });

  it("emits a join only when a field behind it is actually named", () => {
    /**
     * A join emitted unconditionally is a join the planner pays for on every
     * report, including the ones that never look at the party.
     */
    const withoutJoin = compile({
      source: "deals",
      select: [{ kind: "field", field: "stage" }],
      limit: 10,
    });
    const withJoin = compile({
      source: "deals",
      select: [{ kind: "field", field: "party.industry" }],
      limit: 10,
    });

    expect(withoutJoin.text).not.toContain("LEFT JOIN");
    expect(withJoin.text).toContain(`LEFT JOIN "business_parties" AS "j0"`);
  });

  it("puts the joined table's tenant predicate in ON, not WHERE", () => {
    /**
     * The failure this prevents is silent and arithmetical. In `WHERE`, the
     * organisation predicate on a left-joined table discards every row where the
     * join matched nothing — so every deal with no party vanishes from the
     * totals, and the report is confidently wrong rather than visibly broken.
     */
    const compiled = compile({
      source: "deals",
      select: [{ kind: "field", field: "party.industry" }],
      limit: 10,
    });

    const on = compiled.text.slice(
      compiled.text.indexOf("LEFT JOIN"),
      compiled.text.indexOf("WHERE"),
    );
    expect(on).toContain(`"j0"."organization_id" = $1`);

    const where = compiled.text.slice(compiled.text.indexOf("WHERE"));
    expect(where).not.toContain(`"j0"."organization_id"`);
  });

  it("names output columns positionally, so a caller's label is never an identifier", () => {
    const compiled = compile({
      source: "deals",
      select: [
        { kind: "field", field: "stage" },
        { kind: "aggregate", aggregate: "sum", field: "value_minor" },
      ],
      groupBy: ["stage"],
      limit: 10,
    });

    expect(compiled.text).toContain(`"s"."stage" AS "c0"`);
    expect(compiled.text).toContain(`SUM("s"."value_minor") AS "c1"`);
    expect(compiled.columns.map((c) => c.alias)).toEqual(["c0", "c1"]);
    /** The caller's own vocabulary comes back beside the alias, not inside the SQL. */
    expect(compiled.columns[1]!.projection).toEqual({
      kind: "aggregate",
      aggregate: "sum",
      field: "value_minor",
    });
  });

  it("sums money as an exact integer column and never offers the derived decimal", () => {
    /**
     * `deals.value` is a GENERATED decimal kept for legacy readers. Summing it
     * across a large pipeline is where half-cent drift comes from, so it is not
     * in the registry at all — the exact minor-unit column is the only way to
     * total money here.
     */
    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [{ kind: "aggregate", aggregate: "sum", field: "value" }],
        limit: 10,
      }),
    )).toBe("unknown_field");

    const compiled = compile({
      source: "deals",
      select: [{ kind: "aggregate", aggregate: "sum", field: "value_minor" }],
      limit: 10,
    });
    expect(compiled.text).toContain(`SUM("s"."value_minor")`);
  });

  it("refuses a grouped projection Postgres would reject at run time", () => {
    /**
     * Without this the description saves cleanly, and fails the first time
     * somebody runs it — which may be on a schedule, at night, to an audience.
     */
    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [
          { kind: "field", field: "stage" },
          { kind: "aggregate", aggregate: "count" },
        ],
        limit: 10,
      }),
    )).toBe("invalid_grouping");
  });

  it("sorts only by columns it is already returning", () => {
    /**
     * Ordering by a column the caller cannot see is an oracle: repeat the report
     * with different filters and the ordering reconstructs the hidden column.
     * Indexing `orderBy` into `select` closes the channel by construction, so
     * this asserts the shape of the refusal rather than the absence of a leak.
     */
    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [{ kind: "field", field: "stage" }],
        orderBy: [{ select: 1, direction: "asc" }],
        limit: 10,
      }),
    )).toBe("invalid_order_target");

    const compiled = compile({
      source: "deals",
      select: [{ kind: "field", field: "stage" }],
      orderBy: [{ select: 0, direction: "desc" }],
      limit: 10,
    });
    expect(compiled.text).toContain(`ORDER BY "c0" DESC NULLS LAST`);
  });

  it("puts nulls last in both directions, so a 'biggest first' report does not open on blanks", () => {
    const ascending = compile({
      source: "deals",
      select: [{ kind: "field", field: "health_score" }],
      orderBy: [{ select: 0, direction: "asc" }],
      limit: 10,
    });
    expect(ascending.text).toContain("ASC NULLS LAST");
  });

  it("refuses an over-large limit instead of clamping it", () => {
    /**
     * A clamped limit hands back a truncated answer that looks complete. The
     * caller has no way to tell 1000 rows from "the first 1000 of 40,000".
     */
    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [{ kind: "field", field: "stage" }],
        limit: QUERY_LIMITS.maxLimit + 1,
      }),
    )).toBe("limit_exceeded");
  });

  it("binds the row window rather than inlining integers it just proved safe", () => {
    /**
     * The integers are safe; inlining them is still refused. A statement with
     * one concatenation in it is a statement where the next person adds a second
     * without re-deriving why the first was allowed.
     */
    const compiled = compile({
      source: "deals",
      select: [{ kind: "field", field: "stage" }],
      limit: 25,
      offset: 50,
    });
    expect(compiled.text).toMatch(/LIMIT \$\d+ OFFSET \$\d+$/);
    expect(compiled.params).toContain(25);
    expect(compiled.params).toContain(50);
  });

  it("refuses an empty IN list rather than inventing a meaning for it", () => {
    /**
     * `IN ()` is a syntax error and both plausible repairs are wrong: `IN
     * (NULL)` also makes `NOT IN` match nothing, and folding to `false` makes an
     * empty selection silently mean "no rows" when the caller meant "no filter".
     */
    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [{ kind: "field", field: "stage" }],
        filter: { kind: "compare", field: "stage", operator: "in", values: [] },
        limit: 10,
      }),
    )).toBe("malformed_description");
  });

  it("makes `= NULL` unrepresentable rather than correcting it", () => {
    /**
     * `stage = NULL` is the classic silently-empty filter. There is no way to
     * write it here: a unary operator carries no value slot, and `null` is not
     * a `ScalarValue`, so the shape does not exist.
     */
    const compiled = compile({
      source: "deals",
      select: [{ kind: "field", field: "stage" }],
      filter: { kind: "compare", field: "lost_reason", operator: "is_null" },
      limit: 10,
    });
    expect(compiled.text).toContain(`"s"."lost_reason" IS NULL`);

    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [{ kind: "field", field: "stage" }],
        filter: {
          kind: "compare",
          field: "stage",
          operator: "eq",
          value: null as unknown as string,
        },
        limit: 10,
      }),
    )).toBe("value_type_mismatch");
  });

  it("refuses NaN on a numeric filter, which numeric would accept as larger than everything", () => {
    /**
     * `numeric` has a `NaN` and it sorts above every finite value, so
     * `value_minor < NaN` returns the entire table — a filter that reads as
     * restrictive and is the opposite.
     */
    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [{ kind: "field", field: "stage" }],
        filter: { kind: "compare", field: "value_minor", operator: "lt", value: Number.NaN },
        limit: 10,
      }),
    )).toBe("value_type_mismatch");
  });

  it("refuses substring matching on a number, which would discard the index", () => {
    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [{ kind: "field", field: "stage" }],
        filter: { kind: "compare", field: "value_minor", operator: "contains", value: "99" },
        limit: 10,
      }),
    )).toBe("operator_type_mismatch");
  });

  it("refuses substring matching on an enum column, which Postgres has no operator for", () => {
    /**
     * `business_parties.party_type` is a real Postgres enum. `party_type ILIKE
     * $1` is not slow, it is an error — there is no `~~*` between an enum and
     * text — so without a distinct `enum` field type this would be a 500 raised
     * from inside the tenant's transaction on an otherwise reasonable filter.
     */
    expect(codeOf(() =>
      compile({
        source: "parties",
        select: [{ kind: "field", field: "name" }],
        filter: { kind: "compare", field: "party_type", operator: "contains", value: "CUST" },
        limit: 10,
      }),
    )).toBe("operator_type_mismatch");
  });

  it("still allows the comparisons an enum does support", () => {
    /**
     * The narrowing must not go so far that the column becomes unfilterable —
     * "customers only" is the question this field exists to answer.
     */
    const compiled = compile({
      source: "parties",
      select: [{ kind: "aggregate", aggregate: "count" }],
      filter: {
        kind: "compare",
        field: "party_type",
        operator: "in",
        values: ["CUSTOMER", "SUPPLIER"],
      },
      limit: 10,
    });
    expect(compiled.text).toContain(`"s"."party_type" IN ($2, $3)`);
    /** No cast: Postgres infers the enum from the column it is compared against. */
    expect(compiled.text).not.toContain("$2::");
  });

  it("refuses to sum a text column instead of letting Postgres raise it", () => {
    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [{ kind: "aggregate", aggregate: "sum", field: "stage" }],
        limit: 10,
      }),
    )).toBe("operator_type_mismatch");
  });

  it("bounds filter depth iteratively, so the check survives the input it rejects", () => {
    /**
     * A recursive depth check overflows the stack on exactly the payload it
     * exists to refuse, turning a validation into a crash. Ten thousand levels
     * is far past anything a person builds and well past a recursive walk.
     */
    let node: unknown = { kind: "compare", field: "stage", operator: "is_null" };
    for (let i = 0; i < 10_000; i += 1) node = { kind: "not", node };

    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [{ kind: "field", field: "stage" }],
        filter: node as never,
        limit: 10,
      }),
    )).toBe("limit_exceeded");
  });

  it("bounds filter width as well as depth", () => {
    /**
     * A shallow tree with thousands of siblings passes any depth check and hands
     * Postgres a predicate with thousands of terms to plan.
     */
    const nodes = Array.from({ length: QUERY_LIMITS.maxFilterNodes + 5 }, () => ({
      kind: "compare" as const,
      field: "stage",
      operator: "is_null" as const,
    }));

    expect(codeOf(() =>
      compile({
        source: "deals",
        select: [{ kind: "field", field: "stage" }],
        filter: { kind: "or", nodes },
        limit: 10,
      }),
    )).toBe("limit_exceeded");
  });

  it("refuses to compile without an organisation, so there is no unscoped path", () => {
    expect(
      codeOf(() =>
        compileQuery(
          { source: "deals", select: [{ kind: "field", field: "stage" }], limit: 10 },
          { organizationId: "", requester: { userId: "user_1", scope: "all" as const } },
        ),
      ),
    ).toBe("malformed_description");
  });

  it("is pure: the same description compiles to the same statement every time", () => {
    /**
     * Not a style preference. The audit row stores the compiled statement, and a
     * compiler whose output varied — by iteration order, by a cached map, by a
     * clock — would make two audit rows for the same report incomparable.
     */
    const description: QueryDescription = {
      source: "deals",
      select: [
        { kind: "field", field: "party.industry" },
        { kind: "aggregate", aggregate: "sum", field: "value_minor" },
      ],
      groupBy: ["party.industry"],
      filter: {
        kind: "and",
        nodes: [
          { kind: "compare", field: "stage", operator: "in", values: ["WON", "LOST"] },
          { kind: "compare", field: "created_at", operator: "gte", value: "2026-01-01" },
        ],
      },
      orderBy: [{ select: 1, direction: "desc" }],
      limit: 50,
    };

    const first = compile(description);
    const second = compile(description);
    expect(second.text).toBe(first.text);
    expect(second.params).toEqual(first.params);
  });
});
