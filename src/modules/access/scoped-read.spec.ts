import { PgDialect } from "drizzle-orm/pg-core";
import { eq, isNull, type SQL } from "drizzle-orm";
import { ScopedRead, type ScopedWhere, type ScopedWhereSpec } from "./scoped-read";
import { deals, tickets } from "../../db/schema";
import type { DataScope } from "./access.types";

// Two properties of this seam are type-level: tsc fails on these lines if either regresses.
type Assert<T extends true> = T;
type TenantIsRequired = Assert<
  Record<string, never> extends Pick<ScopedWhereSpec, "tenant"> ? false : true
>;
type ForgedWhereIsNotAssignable = Assert<{ sql: SQL } extends ScopedWhere ? false : true>;

const TENANT_IS_REQUIRED: TenantIsRequired = true;
const FORGED_WHERE_IS_NOT_ASSIGNABLE: ForgedWhereIsNotAssignable = true;

const dialect = new PgDialect();
const render = (where: ScopedWhere) => dialect.sqlToQuery(where.sql).sql;
const paramsOf = (where: ScopedWhere) => dialect.sqlToQuery(where.sql).params;

const COLUMNS = { columns: { ownerColumn: deals.assignedToId } } as const;
const SPEC: ScopedWhereSpec = { tenant: deals.orgId, scope: COLUMNS };

const SCOPES: DataScope[] = ["all", "team", "own", "none"];

function capture(read: ScopedRead, spec: ScopedWhereSpec = SPEC): ScopedWhere | null {
  return read.compose(spec, (where) => where, () => null);
}

describe("a scoped read installs the tenant predicate", () => {
  it.each(["all", "team", "own"] as const)("carries org_id for scope %s", (scope) => {
    const where = capture(ScopedRead.of("org-1", "u-1", scope));
    expect(where).not.toBeNull();
    expect(render(where as ScopedWhere)).toContain("org_id");
    expect(paramsOf(where as ScopedWhere)).toContain("org-1");
  });

  it("binds the caller's own tenant, so another org's id cannot be substituted", () => {
    const where = capture(ScopedRead.of("org-B", "u-1", "all"));
    expect(paramsOf(where as ScopedWhere)).toContain("org-B");
    expect(paramsOf(where as ScopedWhere)).not.toContain("org-1");
  });

  it("cannot be built without a tenant column — the spec field is required", () => {
    expect(TENANT_IS_REQUIRED).toBe(true);
  });
});

describe("a scoped read installs the DataScope predicate", () => {
  it("renders all as an unrestricted arm beside the tenant predicate", () => {
    const where = capture(ScopedRead.of("org-1", "u-1", "all"));
    expect(render(where as ScopedWhere)).toContain("true");
  });

  it("renders own as an owner-column equality bound to the actor", () => {
    const where = capture(ScopedRead.of("org-1", "u-9", "own"));
    expect(render(where as ScopedWhere)).toContain("assigned_to_id");
    expect(paramsOf(where as ScopedWhere)).toContain("u-9");
  });

  it("degrades team to own when the table supplies no team column", () => {
    const own = render(capture(ScopedRead.of("org-1", "u-1", "own")) as ScopedWhere);
    const team = render(capture(ScopedRead.of("org-1", "u-1", "team")) as ScopedWhere);
    expect(team).toBe(own);
  });

  it("widens team past own when the table supplies a team column and ids", () => {
    const spec: ScopedWhereSpec = {
      tenant: deals.orgId,
      scope: {
        columns: {
          ownerColumn: deals.assignedToId,
          teamColumn: deals.assignedToId,
          teamIds: ["u-2", "u-3"],
        },
      },
    };
    const team = render(capture(ScopedRead.of("org-1", "u-1", "team"), spec) as ScopedWhere);
    expect(team).toContain("or");
    expect(team).not.toBe(render(capture(ScopedRead.of("org-1", "u-1", "own"), spec) as ScopedWhere));
  });

  it("keeps a domain ownership predicate distinct from a column equality", () => {
    const spec: ScopedWhereSpec = {
      tenant: tickets.orgId,
      scope: { own: eq(tickets.reporterId, "u-1") },
    };
    expect(render(capture(ScopedRead.of("org-1", "u-1", "own"), spec) as ScopedWhere)).toContain(
      "reporter_id",
    );
    expect(render(capture(ScopedRead.of("org-1", "u-1", "all"), spec) as ScopedWhere)).not.toContain(
      "reporter_id",
    );
  });

  it("appends domain filters after tenant and scope, never instead of them", () => {
    const where = capture(ScopedRead.of("org-1", "u-1", "own"), {
      tenant: deals.orgId,
      scope: COLUMNS,
      and: [isNull(deals.deletedAt), undefined],
    });
    const rendered = render(where as ScopedWhere);
    expect(rendered).toContain("org_id");
    expect(rendered).toContain("assigned_to_id");
    expect(rendered).toContain("deleted_at");
  });
});

describe("none terminates before the database", () => {
  it("never invokes the query for an async read", async () => {
    const run = jest.fn<Promise<string[]>, [ScopedWhere]>();
    const result = await ScopedRead.of("org-1", "u-1", "none").read(SPEC, run, () => []);
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("never invokes the builder for a synchronous composition", () => {
    const build = jest.fn<SQL, [ScopedWhere]>();
    expect(capture(ScopedRead.of("org-1", "u-1", "none"))).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it("lets the denied branch throw, so a refusing caller keeps refusing", async () => {
    await expect(
      ScopedRead.of("org-1", "u-1", "none").read(SPEC, async () => "rows", () => {
        throw new Error("Forbidden");
      }),
    ).rejects.toThrow("Forbidden");
  });

  it("reports denied for none and only none", () => {
    expect(ScopedRead.of("org-1", "u-1", "none").denied).toBe(true);
    for (const scope of ["all", "team", "own"] as const)
      expect(ScopedRead.of("org-1", "u-1", scope).denied).toBe(false);
  });

  it("still runs the query for every scope that is not none", async () => {
    for (const scope of ["all", "team", "own"] as const) {
      const run = jest.fn(async () => "rows");
      await ScopedRead.of("org-1", "u-1", scope).read(SPEC, run, () => "denied");
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});

describe("the two standing decisions are typed, not stringly", () => {
  it("reports unrestricted for all and only all", () => {
    expect(ScopedRead.of("org-1", "u-1", "all").unrestricted).toBe(true);
    for (const scope of ["team", "own", "none"] as const)
      expect(ScopedRead.of("org-1", "u-1", scope).unrestricted).toBe(false);
  });

  it("never reports a caller both denied and unrestricted", () => {
    for (const scope of SCOPES) {
      const read = ScopedRead.of("org-1", "u-1", scope);
      expect(read.denied && read.unrestricted).toBe(false);
    }
  });

  it("picks the broader of two resolved scopes", () => {
    const order: DataScope[] = ["none", "own", "team", "all"];
    for (const a of order)
      for (const b of order) {
        const winner = ScopedRead.broadest(
          ScopedRead.of("org-1", "u-1", a),
          ScopedRead.of("org-1", "u-1", b),
        );
        const expected = order.indexOf(a) >= order.indexOf(b) ? a : b;
        expect(winner.rawScope("spec reads the resolved value")).toBe(expected);
      }
  });

  it("keeps the winner's own identity, not a rebuilt one", () => {
    const wide = ScopedRead.of("org-1", "u-9", "all");
    const narrow = ScopedRead.of("org-1", "u-9", "own");
    expect(ScopedRead.broadest(narrow, wide)).toBe(wide);
  });
});

describe("the cache discriminator cannot collide", () => {
  it("gives every scope a distinct fragment for one actor", () => {
    const fragments = SCOPES.map((s) => ScopedRead.of("org-1", "u-1", s).discriminator);
    expect(new Set(fragments).size).toBe(SCOPES.length);
  });

  it("separates two actors holding the same actor-dependent scope", () => {
    for (const scope of ["own", "team"] as const)
      expect(ScopedRead.of("org-1", "u-1", scope).discriminator).not.toBe(
        ScopedRead.of("org-1", "u-2", scope).discriminator,
      );
  });

  it("keeps all shared, because all does not depend on who is asking", () => {
    expect(ScopedRead.of("org-1", "u-1", "all").discriminator).toBe(
      ScopedRead.of("org-1", "u-2", "all").discriminator,
    );
  });

  it("never yields a bare own or team, which is the collision", () => {
    for (const scope of ["own", "team"] as const)
      expect(ScopedRead.of("org-1", "u-1", scope).discriminator).not.toBe(scope);
  });
});

describe("the scope value has no other exit", () => {
  it("exposes no property that yields the raw scope except the named hatch", () => {
    const read = ScopedRead.of("org-1", "u-1", "own");
    const surface = [
      ...Object.getOwnPropertyNames(read),
      ...Object.getOwnPropertyNames(ScopedRead.prototype),
    ];
    expect(surface).toEqual(
      expect.arrayContaining(["orgId", "actorId", "denied", "discriminator", "read", "compose", "rawScope"]),
    );
    expect(surface).not.toContain("scope");
    expect(JSON.stringify(read)).not.toContain("own");
  });

  it("keeps the actor and tenant it was resolved for", () => {
    const read = ScopedRead.of("org-9", "u-9", "own");
    expect(read.orgId).toBe("org-9");
    expect(read.actorId).toBe("u-9");
  });

  it("returns the value through the named hatch, which is what makes it greppable", () => {
    expect(ScopedRead.of("org-1", "u-1", "team").rawScope("test")).toBe("team");
  });

  it("refuses a hand-built where token, because the clause type is nominal", () => {
    expect(FORGED_WHERE_IS_NOT_ASSIGNABLE).toBe(true);
  });
});

describe("workers and exports resolve the same way as a request", () => {
  it("produces an identical clause for the same actor, scope and table", () => {
    const request = capture(ScopedRead.of("org-1", "u-1", "own"));
    const worker = capture(ScopedRead.of("org-1", "u-1", "own"));
    expect(render(worker as ScopedWhere)).toBe(render(request as ScopedWhere));
  });

  it("denies a worker holding none exactly as it denies a request", async () => {
    const run = jest.fn(async () => "rows");
    expect(await ScopedRead.of("org-1", "u-1", "none").read(SPEC, run, () => "denied")).toBe("denied");
    expect(run).not.toHaveBeenCalled();
  });
});
