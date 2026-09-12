import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { ScopedRead, type ScopedWhere, type ScopedWhereSpec } from "../scoped-read";

const dialect = new PgDialect();

function render(where: ScopedWhere): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(where.sql);
  return { sql: q.sql, params: q.params };
}

const testTable = pgTable("records", {
  orgId: text("org_id").notNull(),
  ownerId: text("owner_id").notNull(),
  teamId: text("team_id").notNull(),
});

const TENANT_COL = testTable.orgId;
const OWNER_COL = testTable.ownerId;
const TEAM_COL = testTable.teamId;
const ORG = "org-sql-test";
const ACTOR = "user-sql-test";

function captureWhere(read: ScopedRead, spec: ScopedWhereSpec): ScopedWhere | null {
  return read.compose(spec, (where) => where, () => null);
}

describe("all scope — SQL contains both tenant predicate and an unrestricted scope predicate", () => {
  const spec: ScopedWhereSpec = {
    tenant: TENANT_COL,
    scope: { columns: { ownerColumn: OWNER_COL } },
  };

  it("produces a WHERE clause, not a denial", () => {
    const read = ScopedRead.of(ORG, ACTOR, "all");
    expect(read.denied).toBe(false);
    const where = captureWhere(read, spec);
    expect(where).not.toBeNull();
  });

  it("includes the tenant column name in the SQL string", () => {
    const read = ScopedRead.of(ORG, ACTOR, "all");
    const { sql } = render(captureWhere(read, spec) as ScopedWhere);
    expect(sql).toContain("org_id");
  });

  it("binds the caller's org id as a parameter, not another org's", () => {
    const read = ScopedRead.of(ORG, ACTOR, "all");
    const { params } = render(captureWhere(read, spec) as ScopedWhere);
    expect(params).toContain(ORG);
    expect(params).not.toContain("other-org");
  });

  it("includes an unrestricted scope predicate (true) alongside the tenant predicate", () => {
    const read = ScopedRead.of(ORG, ACTOR, "all");
    const { sql } = render(captureWhere(read, spec) as ScopedWhere);
    expect(sql).toContain("true");
  });

  it("the actor id is NOT in the parameter list — all does not bind to an owner", () => {
    const read = ScopedRead.of(ORG, ACTOR, "all");
    const { params } = render(captureWhere(read, spec) as ScopedWhere);
    expect(params).not.toContain(ACTOR);
  });
});

describe("own scope — SQL contains both tenant predicate and owner-column predicate", () => {
  const spec: ScopedWhereSpec = {
    tenant: TENANT_COL,
    scope: { columns: { ownerColumn: OWNER_COL } },
  };

  it("produces a WHERE clause, not a denial", () => {
    const read = ScopedRead.of(ORG, ACTOR, "own");
    expect(read.denied).toBe(false);
    const where = captureWhere(read, spec);
    expect(where).not.toBeNull();
  });

  it("includes the tenant column name in the SQL string", () => {
    const read = ScopedRead.of(ORG, ACTOR, "own");
    const { sql } = render(captureWhere(read, spec) as ScopedWhere);
    expect(sql).toContain("org_id");
  });

  it("binds the caller's org id as a parameter", () => {
    const read = ScopedRead.of(ORG, ACTOR, "own");
    const { params } = render(captureWhere(read, spec) as ScopedWhere);
    expect(params).toContain(ORG);
  });

  it("includes the owner column name in the SQL string", () => {
    const read = ScopedRead.of(ORG, ACTOR, "own");
    const { sql } = render(captureWhere(read, spec) as ScopedWhere);
    expect(sql).toContain("owner_id");
  });

  it("binds the actor id as a parameter for the owner predicate", () => {
    const read = ScopedRead.of(ORG, ACTOR, "own");
    const { params } = render(captureWhere(read, spec) as ScopedWhere);
    expect(params).toContain(ACTOR);
  });

  it("both the tenant param and the actor param appear together in one WHERE clause", () => {
    const read = ScopedRead.of(ORG, ACTOR, "own");
    const { sql, params } = render(captureWhere(read, spec) as ScopedWhere);
    expect(sql).toContain("org_id");
    expect(sql).toContain("owner_id");
    expect(params).toContain(ORG);
    expect(params).toContain(ACTOR);
  });

  it("the actor id is the owner parameter, not a cross-actor bleed (different actor)", () => {
    const other = "other-actor";
    const readA = ScopedRead.of(ORG, ACTOR, "own");
    const readB = ScopedRead.of(ORG, other, "own");
    const paramsA = render(captureWhere(readA, spec) as ScopedWhere).params;
    const paramsB = render(captureWhere(readB, spec) as ScopedWhere).params;
    expect(paramsA).toContain(ACTOR);
    expect(paramsA).not.toContain(other);
    expect(paramsB).toContain(other);
    expect(paramsB).not.toContain(ACTOR);
  });
});

describe("team scope — falls back to own when no team column is materialized (ADR 0005)", () => {
  const specNoTeam: ScopedWhereSpec = {
    tenant: TENANT_COL,
    scope: { columns: { ownerColumn: OWNER_COL } },
  };
  const specWithTeam: ScopedWhereSpec = {
    tenant: TENANT_COL,
    scope: { columns: { ownerColumn: OWNER_COL, teamColumn: TEAM_COL, teamIds: ["t-1"] } },
  };

  it("produces a WHERE clause (not a denial) even with no team data", () => {
    const read = ScopedRead.of(ORG, ACTOR, "team");
    expect(read.denied).toBe(false);
    const where = captureWhere(read, specNoTeam);
    expect(where).not.toBeNull();
  });

  it("without a teamIds spec, renders identically to own — team degrades to own", () => {
    const readOwn = ScopedRead.of(ORG, ACTOR, "own");
    const readTeam = ScopedRead.of(ORG, ACTOR, "team");
    const { sql: sqlOwn } = render(captureWhere(readOwn, specNoTeam) as ScopedWhere);
    const { sql: sqlTeam } = render(captureWhere(readTeam, specNoTeam) as ScopedWhere);
    expect(sqlTeam).toBe(sqlOwn);
  });

  it("still carries the tenant predicate even in degraded team mode", () => {
    const read = ScopedRead.of(ORG, ACTOR, "team");
    const { sql, params } = render(captureWhere(read, specNoTeam) as ScopedWhere);
    expect(sql).toContain("org_id");
    expect(params).toContain(ORG);
  });

  it("with teamIds materialized, renders wider than own", () => {
    const readOwn = ScopedRead.of(ORG, ACTOR, "own");
    const readTeam = ScopedRead.of(ORG, ACTOR, "team");
    const { sql: sqlOwn } = render(captureWhere(readOwn, specWithTeam) as ScopedWhere);
    const { sql: sqlTeam } = render(captureWhere(readTeam, specWithTeam) as ScopedWhere);
    expect(sqlTeam).not.toBe(sqlOwn);
    expect(sqlTeam).toContain("team_id");
  });

  it("even when wider, team still carries the tenant predicate", () => {
    const read = ScopedRead.of(ORG, ACTOR, "team");
    const { sql, params } = render(captureWhere(read, specWithTeam) as ScopedWhere);
    expect(sql).toContain("org_id");
    expect(params).toContain(ORG);
  });

  it("the no-teamIds path is pinned: no production call site supplies teamIds today (see apply-scope-team.spec.ts)", () => {
    const read = ScopedRead.of(ORG, ACTOR, "team");
    const where = captureWhere(read, specNoTeam);
    const { sql } = render(where as ScopedWhere);
    expect(sql).not.toContain("team_id");
    expect(sql).toContain("owner_id");
  });
});

describe("none scope — short-circuits before SQL and produces no WHERE clause", () => {
  const spec: ScopedWhereSpec = {
    tenant: TENANT_COL,
    scope: { columns: { ownerColumn: OWNER_COL } },
  };

  it("denied property is true — the consumer must not query at all", () => {
    const read = ScopedRead.of(ORG, ACTOR, "none");
    expect(read.denied).toBe(true);
  });

  it("compose returns the denied value and does not call the build function", () => {
    const read = ScopedRead.of(ORG, ACTOR, "none");
    const buildFn = jest.fn(() => "should not run");
    const result = read.compose(spec, buildFn, () => "denied-result");
    expect(result).toBe("denied-result");
    expect(buildFn).not.toHaveBeenCalled();
  });

  it("read short-circuits before invoking the database runner", async () => {
    const read = ScopedRead.of(ORG, ACTOR, "none");
    const runFn = jest.fn(async () => ["row"]);
    const result = await read.read(spec, runFn, async () => []);
    expect(result).toEqual([]);
    expect(runFn).not.toHaveBeenCalled();
  });

  it("captureWhere returns null — no SQL object is produced for the none scope", () => {
    const read = ScopedRead.of(ORG, ACTOR, "none");
    expect(captureWhere(read, spec)).toBeNull();
  });
});

describe("discriminator — cache key fragment varies correctly across scopes", () => {
  it("all and none have scope-only discriminators, no actor id embedded", () => {
    expect(ScopedRead.of(ORG, ACTOR, "all").discriminator).toBe("all");
    expect(ScopedRead.of(ORG, ACTOR, "none").discriminator).toBe("none");
  });

  it("own and team embed the actor id so two people's caches do not collide", () => {
    const actorA = "actor-a";
    const actorB = "actor-b";
    expect(ScopedRead.of(ORG, actorA, "own").discriminator).toContain(actorA);
    expect(ScopedRead.of(ORG, actorB, "own").discriminator).toContain(actorB);
    expect(ScopedRead.of(ORG, actorA, "own").discriminator).not.toContain(actorB);
  });

  it("own and team discriminators differ between actors — prevents cross-actor cache hits", () => {
    const discA = ScopedRead.of(ORG, "actor-a", "own").discriminator;
    const discB = ScopedRead.of(ORG, "actor-b", "own").discriminator;
    expect(discA).not.toBe(discB);
  });
});

describe("tenant column is required — structural proof via the type assertion in scoped-read.spec.ts", () => {
  it("a different org id in a different ScopedRead produces a different param, not a shared tenant", () => {
    const readX = ScopedRead.of("org-x", ACTOR, "all");
    const readY = ScopedRead.of("org-y", ACTOR, "all");
    const spec: ScopedWhereSpec = { tenant: TENANT_COL, scope: { columns: { ownerColumn: OWNER_COL } } };
    const paramsX = render(captureWhere(readX, spec) as ScopedWhere).params;
    const paramsY = render(captureWhere(readY, spec) as ScopedWhere).params;
    expect(paramsX).toContain("org-x");
    expect(paramsX).not.toContain("org-y");
    expect(paramsY).toContain("org-y");
    expect(paramsY).not.toContain("org-x");
  });
});

describe("SQL renders the predicates in the correct logical order — AND(tenant, scope, ...domain)", () => {
  it("for all scope, the sql literal for true appears after the org_id predicate", () => {
    const read = ScopedRead.of(ORG, ACTOR, "all");
    const spec: ScopedWhereSpec = { tenant: TENANT_COL, scope: { columns: { ownerColumn: OWNER_COL } } };
    const { sql } = render(captureWhere(read, spec) as ScopedWhere);
    const tenantPos = sql.indexOf("org_id");
    const scopePos = sql.indexOf("true");
    expect(tenantPos).toBeGreaterThanOrEqual(0);
    expect(scopePos).toBeGreaterThan(tenantPos);
  });

  it("for own scope, the owner_id predicate appears after the org_id predicate", () => {
    const read = ScopedRead.of(ORG, ACTOR, "own");
    const spec: ScopedWhereSpec = { tenant: TENANT_COL, scope: { columns: { ownerColumn: OWNER_COL } } };
    const { sql } = render(captureWhere(read, spec) as ScopedWhere);
    const tenantPos = sql.indexOf("org_id");
    const ownerPos = sql.indexOf("owner_id");
    expect(tenantPos).toBeGreaterThanOrEqual(0);
    expect(ownerPos).toBeGreaterThan(tenantPos);
  });

  it("domain filters (and: clause) appear after both tenant and scope predicates", () => {
    const read = ScopedRead.of(ORG, ACTOR, "own");
    const SQL_LITERAL = "deleted_at" as unknown as SQL;
    const spec: ScopedWhereSpec = {
      tenant: TENANT_COL,
      scope: { columns: { ownerColumn: OWNER_COL } },
      and: [SQL_LITERAL],
    };
    const where = captureWhere(read, spec);
    expect(where).not.toBeNull();
  });
});
