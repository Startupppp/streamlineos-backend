import { listGrantsQuerySchema } from "./dto/portal-access.schemas";
import { listGrants } from "./lib/project-client-grants";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";

describe("listGrantsQuerySchema — new filter fields", () => {
  it("rejects an unknown key because the schema is strict", () => {
    const result = listGrantsQuerySchema.safeParse({ limit: 20, bogus: "x" });
    expect(result.success).toBe(false);
  });

  it("accepts q as an optional string search term", () => {
    const result = listGrantsQuerySchema.safeParse({ limit: 20, q: "alice" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.q).toBe("alice");
  });

  it("rejects q longer than 200 characters", () => {
    const result = listGrantsQuerySchema.safeParse({
      limit: 20,
      q: "x".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("accepts permission as a comma-separated list of known capability keys", () => {
    const result = listGrantsQuerySchema.safeParse({
      limit: 20,
      permission: "canViewMilestones,canSubmitChangeRequests",
    });
    expect(result.success).toBe(true);
  });

  it("rejects permission when it contains an unknown capability key", () => {
    const result = listGrantsQuerySchema.safeParse({
      limit: 20,
      permission: "canViewMilestones,bogusKey",
    });
    expect(result.success).toBe(false);
  });

  it("accepts state as one of the four valid lifecycle values", () => {
    for (const state of [
      "active",
      "expired",
      "suspended",
      "revoked",
    ] as const) {
      const result = listGrantsQuerySchema.safeParse({ limit: 20, state });
      expect(result.success).toBe(true);
    }
  });

  it("rejects state=EXPIRED because the enum value is never written and filtering on it would match zero rows", () => {
    const result = listGrantsQuerySchema.safeParse({
      limit: 20,
      state: "EXPIRED",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown state value", () => {
    const result = listGrantsQuerySchema.safeParse({
      limit: 20,
      state: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("accepts grantId as a direct lookup filter, which strict mode rejected before it was declared", () => {
    const result = listGrantsQuerySchema.safeParse({ limit: 20, grantId: "pcg-1" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.grantId).toBe("pcg-1");
  });

  it("rejects an empty grantId so a blank URL param is not a filter that matches nothing", () => {
    expect(listGrantsQuerySchema.safeParse({ limit: 20, grantId: "" }).success).toBe(false);
  });

  it("coerces from and to into Date, following inboxQuerySchema rather than the bare-string updates schema", () => {
    const result = listGrantsQuerySchema.safeParse({
      limit: 20,
      from: "2026-01-01",
      to: "2026-12-31T23:59:59.999Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBeInstanceOf(Date);
      expect(result.data.to).toBeInstanceOf(Date);
      expect(result.data.from?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("rejects an unparseable from so the service never builds a predicate around an Invalid Date", () => {
    expect(listGrantsQuerySchema.safeParse({ limit: 20, from: "not-a-date" }).success).toBe(false);
    expect(listGrantsQuerySchema.safeParse({ limit: 20, to: "not-a-date" }).success).toBe(false);
  });
});

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

function sqlColumnNames(value: unknown, seen = new Set<object>(), found: string[] = []): string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) sqlColumnNames(item, seen, found);
    return found;
  }
  const record = value as { name?: unknown; table?: unknown; queryChunks?: unknown[] };
  if (typeof record.name === "string" && record.table !== undefined) {
    found.push(record.name);
    return found;
  }
  if (record.queryChunks) sqlColumnNames(record.queryChunks, seen, found);
  return found;
}

function makeListGrantsDb(): { db: Db; capturedWhere: jest.Mock } {
  const capturedWhere = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    }),
  });
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({
          where: capturedWhere,
        }),
      }),
    }),
  } as unknown as Db;
  return { db, capturedWhere };
}

const audit = { log: jest.fn() } as unknown as AuditService;
const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

describe("listGrants — q filter", () => {
  it("passes the search term as a predicate leaf value when q is supplied", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, q: "alice" },
    );
    const values = sqlValues(capturedWhere.mock.calls[0]?.[0]);
    expect(values.some((v) => typeof v === "string" && v.includes("alice"))).toBe(true);
  });

  it("always includes the requesting org as a predicate value so q cannot widen the tenant scope", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      ATTACKER_ORG,
      { limit: 20, q: "alice" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("does not include a percent-wildcard when q is absent so the base query is unchanged", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20 },
    );
    const values = sqlValues(capturedWhere.mock.calls[0]?.[0]);
    expect(values.some((v) => typeof v === "string" && v.includes("%"))).toBe(false);
  });

  it("cross-org control — org-owner query also contains org-owner in the where predicate confirming the org predicate is present not just vacuously absent for attacker", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, q: "alice" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain(OWNER_ORG);
  });
});

describe("listGrants — permission filter", () => {
  it("includes a true equality for each capability key in the CSV so AND semantics are applied", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, permission: "canViewMilestones,canSubmitChangeRequests" },
    );
    const values = sqlValues(capturedWhere.mock.calls[0]?.[0]);
    expect(values.filter((v) => v === true).length).toBeGreaterThanOrEqual(2);
  });

  it("always includes the org predicate even when permission filter is applied so it cannot reach another tenant", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      ATTACKER_ORG,
      { limit: 20, permission: "canViewMilestones" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("cross-org control — org-owner query with permission also contains org-owner confirming the predicate is active", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, permission: "canViewMilestones" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain(OWNER_ORG);
  });
});

describe("listGrants — state filter", () => {
  it("state=active includes ACTIVE so the predicate mirrors the read path that uses status=ACTIVE", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, state: "active" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain("ACTIVE");
  });

  it("state=expired includes ACTIVE and a Date boundary so expired-but-ACTIVE rows are captured rather than filtering on the never-written EXPIRED status value", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, state: "expired" },
    );
    const values = sqlValues(capturedWhere.mock.calls[0]?.[0]);
    expect(values).toContain("ACTIVE");
    expect(values.some((v) => v instanceof Date)).toBe(true);
  });

  it("state=expired does not include the literal EXPIRED string because nothing ever writes that status value", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, state: "expired" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).not.toContain("EXPIRED");
  });

  it("state=suspended includes the string SUSPENDED", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, state: "suspended" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain("SUSPENDED");
  });

  it("state=revoked includes the string REVOKED", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, state: "revoked" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain("REVOKED");
  });

  it("state=active does not include the literal EXPIRED string confirming it does not use the never-written enum value", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, state: "active" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).not.toContain("EXPIRED");
  });

  it("state filter always includes the requesting org so it cannot expand the visible tenant", async () => {
    for (const state of ["active", "expired", "suspended", "revoked"] as const) {
      const { db, capturedWhere } = makeListGrantsDb();
      await listGrants(
        { db, audit, loadMembership: jest.fn() },
        ATTACKER_ORG,
        { limit: 20, state },
      );
      expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
    }
  });

  it("cross-org control — state=active with org-owner also contains org-owner confirming the org predicate is active not vacuously absent", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, state: "active" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain(OWNER_ORG);
  });
});

describe("listGrants — grantId filter reaches the query, not just the schema", () => {
  it("adds the grant id as a predicate value so an accepted grantId is not a silently dropped filter", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, grantId: "pcg-target" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain("pcg-target");
  });

  it("binds grantId to project_client_grant_id and not to any other column", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, grantId: "pcg-target" },
    );
    expect(sqlColumnNames(capturedWhere.mock.calls[0]?.[0])).toContain("project_client_grant_id");
  });

  it("omits the grant id when grantId is absent, so the unfiltered list is unchanged", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants({ db, audit, loadMembership: jest.fn() }, OWNER_ORG, { limit: 20 });
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).not.toContain("pcg-target");
  });

  it("keeps the org predicate so grantId cannot fetch another tenant's grant by id", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      ATTACKER_ORG,
      { limit: 20, grantId: "pcg-target" },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });
});

describe("listGrants — from/to range reaches the query, not just the schema", () => {
  const FROM = new Date("2026-01-01T00:00:00.000Z");
  const TO = new Date("2026-06-30T23:59:59.000Z");

  it("adds both range boundaries as predicate values so an accepted range is not a silently dropped filter", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, from: FROM, to: TO },
    );
    const dates = sqlValues(capturedWhere.mock.calls[0]?.[0]).filter(
      (v): v is Date => v instanceof Date,
    );
    expect(dates.map((d) => d.toISOString())).toContain(FROM.toISOString());
    expect(dates.map((d) => d.toISOString())).toContain(TO.toISOString());
  });

  it("binds the range to created_at, the same column the keyset cursor orders by", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, from: FROM },
    );
    expect(sqlColumnNames(capturedWhere.mock.calls[0]?.[0])).toContain("created_at");
  });

  it("applies from on its own without requiring to", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      { limit: 20, from: FROM },
    );
    const dates = sqlValues(capturedWhere.mock.calls[0]?.[0]).filter(
      (v): v is Date => v instanceof Date,
    );
    expect(dates.map((d) => d.toISOString())).toContain(FROM.toISOString());
    expect(dates.map((d) => d.toISOString())).not.toContain(TO.toISOString());
  });

  it("applies to on its own without requiring from", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants({ db, audit, loadMembership: jest.fn() }, OWNER_ORG, { limit: 20, to: TO });
    const dates = sqlValues(capturedWhere.mock.calls[0]?.[0]).filter(
      (v): v is Date => v instanceof Date,
    );
    expect(dates.map((d) => d.toISOString())).toContain(TO.toISOString());
    expect(dates.map((d) => d.toISOString())).not.toContain(FROM.toISOString());
  });

  it("adds no Date boundary when neither from nor to is supplied, so the base query is unchanged", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants({ db, audit, loadMembership: jest.fn() }, OWNER_ORG, { limit: 20 });
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0]).some((v) => v instanceof Date)).toBe(false);
  });

  it("keeps the org predicate so a date range cannot widen the visible tenant", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      ATTACKER_ORG,
      { limit: 20, from: FROM, to: TO },
    );
    expect(sqlValues(capturedWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("composes the range with state, permission and q rather than replacing them", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants(
      { db, audit, loadMembership: jest.fn() },
      OWNER_ORG,
      {
        limit: 20,
        from: FROM,
        to: TO,
        grantId: "pcg-target",
        state: "active",
        permission: "canViewMilestones",
        q: "alice",
      },
    );
    const values = sqlValues(capturedWhere.mock.calls[0]?.[0]);
    expect(values).toContain(OWNER_ORG);
    expect(values).toContain("pcg-target");
    expect(values).toContain("ACTIVE");
    expect(values).toContain(true);
    expect(values.some((v) => typeof v === "string" && v.includes("alice"))).toBe(true);
    expect(values.filter((v): v is Date => v instanceof Date).length).toBeGreaterThanOrEqual(2);
  });
});

describe("listGrants — the column assertions above are not vacuous", () => {
  it("names neither created_at nor project_client_grant_id in the where predicate when no range and no grantId are supplied", async () => {
    const { db, capturedWhere } = makeListGrantsDb();
    await listGrants({ db, audit, loadMembership: jest.fn() }, OWNER_ORG, { limit: 20 });
    const columns = sqlColumnNames(capturedWhere.mock.calls[0]?.[0]);
    expect(columns).toContain("organization_id");
    expect(columns).not.toContain("created_at");
    expect(columns).not.toContain("project_client_grant_id");
  });
});
