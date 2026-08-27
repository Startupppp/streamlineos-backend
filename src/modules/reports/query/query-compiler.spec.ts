import { compileQuery, QueryDescriptionError, type Requester } from "./query-compiler";
import type { QueryDescription } from "./query-description";

const ACME: Requester = { orgId: "org-acme", userId: "user-1", scope: "all" };
const OTHER: Requester = { orgId: "org-other", userId: "user-9", scope: "all" };

const compile = (d: QueryDescription, who: Requester = ACME) => compileQuery(d, who);

/*
  Ticket 10 asks that injection be "unrepresentable rather than escaped", so
  these assert the shape of what comes out, not that a sanitiser ran. In every
  case the hostile text ends up in `params` — where it is a value being searched
  for — and never in `text`.
*/
describe("hostile input is a value, never syntax", () => {
  it("puts a classic injection in the parameters and searches for it", () => {
    const hostile = "'; DROP TABLE deals; --";
    const q = compile({
      entity: "deals",
      filters: [{ field: "name", operator: "eq", value: hostile }],
    });

    expect(q.text).not.toContain("DROP");
    expect(q.text).not.toContain(hostile);
    expect(q.params).toContain(hostile);
  });

  it("cannot name a table that is not in the graph", () => {
    expect(() => compile({ entity: "users; DROP TABLE deals" })).toThrow(QueryDescriptionError);
    expect(() => compile({ entity: "pg_catalog.pg_shadow" })).toThrow(/not a reportable entity/);
  });

  it("cannot name a column that is not a declared field", () => {
    expect(() =>
      compile({ entity: "deals", select: ["password_hash"] }),
    ).toThrow(/not a reportable field/);
    expect(() =>
      compile({ entity: "deals", filters: [{ field: "id) OR 1=1 --", operator: "eq", value: 1 }] }),
    ).toThrow(QueryDescriptionError);
  });

  it("cannot express a join the graph does not declare", () => {
    expect(() => compile({ entity: "deals", joins: ["users ON 1=1"] })).toThrow(
      /no declared join/,
    );
    // `activities` is a real entity, but deals declares no join to it.
    expect(() => compile({ entity: "deals", joins: ["activities"] })).toThrow(/no declared join/);
  });

  it("refuses an operator outside the closed set", () => {
    expect(() =>
      compile({
        entity: "deals",
        filters: [{ field: "name", operator: "; DELETE FROM deals --" as never, value: "x" }],
      }),
    ).toThrow(/unknown filter operator/);
  });

  it("refuses an enum value the field cannot take", () => {
    expect(() =>
      compile({ entity: "deals", filters: [{ field: "stage", operator: "eq", value: "WON' OR '1'='1" }] }),
    ).toThrow(/is not one of the values/);
  });

  it("keeps ILIKE wildcards in the parameter, so a % widens only its own search", () => {
    const q = compile({
      entity: "deals",
      filters: [{ field: "name", operator: "contains", value: "%_%" }],
    });
    expect(q.params).toContain("%%_%%");
    expect(q.text).toContain("ILIKE $");
  });

  it("fails with a message about the description, never a database error", () => {
    try {
      compile({ entity: "deals", select: ["nope"] });
      throw new Error("should not compile");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryDescriptionError);
      expect((error as Error).message).toMatch(/not a reportable field of "deals"/);
    }
  });
});

/*
  Ticket 11. The organisation predicate is the compiler's, not the description's,
  and the point is that a description has nowhere to say otherwise.
*/
describe("tenancy is applied by the compiler and cannot be opted out of", () => {
  it("adds the organisation predicate to every query", () => {
    const q = compile({ entity: "deals" });
    expect(q.text).toContain('"t0"."org_id" = $1');
    expect(q.params[0]).toBe("org-acme");
  });

  it("uses each entity's own tenant column, not a shared assumption", () => {
    // `business_parties` scopes on organization_id, deals on org_id. A compiler
    // that assumed one would silently read across tenants on the other.
    expect(compile({ entity: "parties" }).text).toContain('"t0"."organization_id" = $1');
  });

  it("gives two tenants different parameters for the same description", () => {
    const description: QueryDescription = { entity: "deals", select: ["name"] };
    const acme = compile(description, ACME);
    const other = compile(description, OTHER);

    expect(acme.text).toBe(other.text);
    expect(acme.params[0]).toBe("org-acme");
    expect(other.params[0]).toBe("org-other");
  });

  it("has no field in which a description could state its own tenancy", () => {
    // The structural half of the criterion: not "is rejected", but "cannot be
    // written". A key not on QueryDescription is a type error at every call site
    // and is ignored at runtime rather than honoured.
    const smuggled = {
      entity: "deals",
      orgId: "org-other",
      organizationId: "org-other",
      scope: "all",
      where: "1=1",
    } as unknown as QueryDescription;

    const q = compile(smuggled, ACME);
    expect(q.params[0]).toBe("org-acme");
    expect(q.text).not.toContain("1=1");
    expect(q.params).not.toContain("org-other");
  });

  it("survives aggregation and grouping", () => {
    const q = compile({
      entity: "deals",
      groupBy: ["stage"],
      aggregations: [{ of: "sum", field: "value", as: "total" }, { of: "count", as: "deals" }],
    });

    expect(q.text).toContain('"t0"."org_id" = $1');
    // The predicate is in WHERE, so it filters rows BEFORE they are aggregated.
    expect(q.text.indexOf("WHERE")).toBeLessThan(q.text.indexOf("GROUP BY"));
  });

  it("constrains a joined entity through the root it was reached from", () => {
    const q = compile({ entity: "deals", joins: ["party"], select: ["name", "party.name"] });
    expect(q.text).toContain('"t0"."org_id" = $1');
    expect(q.text).toContain("LEFT JOIN");
  });
});

describe("the requester's scope is applied, not declared", () => {
  it("narrows to the requester's own rows at own scope", () => {
    const q = compile({ entity: "deals" }, { ...ACME, scope: "own" });
    expect(q.text).toContain('"t0"."assigned_to_id" = $2');
    expect(q.params[1]).toBe("user-1");
  });

  it("compiles a scope of none to a query that returns nothing", () => {
    const q = compile({ entity: "deals" }, { ...ACME, scope: "none" });
    // Not a thrown refusal: "may see nothing" is a legitimate answer, and the
    // honest compilation of it is an empty result the caller need not special-case.
    expect(q.text).toContain("false");
  });

  it("refuses own scope on an entity with no owner, rather than silently widening", () => {
    expect(() => compile({ entity: "parties" }, { ...ACME, scope: "own" })).toThrow(
      /has no owner/,
    );
  });
});

describe("limits", () => {
  it("bounds an unbounded description", () => {
    const q = compile({ entity: "deals" });
    expect(q.params[q.params.length - 1]).toBe(100);
  });

  it("refuses a limit outside what a report may ask for", () => {
    expect(() => compile({ entity: "deals", limit: 100_000 })).toThrow(/between 1 and 1000/);
    expect(() => compile({ entity: "deals", limit: 0 })).toThrow(/between 1 and 1000/);
  });
});
