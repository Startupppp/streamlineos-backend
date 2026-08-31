import type { Db } from "../../../db/drizzle.module";
import { PeriodsReadService } from "./periods-read.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

describe("PeriodsReadService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeSelectChain(rows: unknown[]) {
    let capturedWhere: unknown;
    const limit = jest.fn().mockResolvedValue(rows);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const whereResult = Object.assign(Promise.resolve(rows), { orderBy });
    const chain: { leftJoin: jest.Mock; where: jest.Mock } = {
      leftJoin: jest.fn(),
      where: jest.fn().mockImplementation((pred: unknown) => {
        capturedWhere = pred;
        return whereResult;
      }),
    };
    chain.leftJoin.mockReturnValue(chain);
    const from = jest.fn().mockReturnValue(chain);
    const db = {
      select: jest.fn().mockReturnValue({ from }),
      query: {
        timesheets: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    return { db, getWhere: () => capturedWhere };
  }

  function makeSvc(db: Db) {
    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue({ permissions: new Set(["timesheets:entries:manage"]) }),
      scopeFor: jest.fn().mockResolvedValue("all"),
    };
    return new PeriodsReadService(db, access as never);
  }

  it("DENY: getPeriodWithUser returns null for a period belonging to a different org (cross-tenant isolation)", async () => {
    const { db, getWhere } = makeSelectChain([]);
    const svc = makeSvc(db);

    const result = await svc.getPeriodWithUser(ATTACKER_ORG, 999);

    expect(result).toBeNull();
    const vals = sqlValues(getWhere());
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
  });

  it("CONTROL: getPeriodWithUser scopes the query to the owner org", async () => {
    const fakeRow = {
      id: 1, orgId: OWNER_ORG, userMembershipId: 10,
      periodStart: "2026-01-01", periodEnd: "2026-01-07",
      status: "OPEN", totalHours: "0", billableHours: "0", nonBillableHours: "0",
      submittedAt: null, approvedAt: null, rejectedAt: null, lockedAt: null,
      currentApproverMembershipId: null, rejectionReason: null,
      createdAt: new Date(), updatedAt: new Date(),
      userEmail: null, userName: null,
    };
    const { db, getWhere } = makeSelectChain([fakeRow]);
    const svc = makeSvc(db);

    const result = await svc.getPeriodWithUser(OWNER_ORG, 1);

    expect(result).not.toBeNull();
    expect(sqlValues(getWhere())).toContain(OWNER_ORG);
  });

  it("DENY: listPeriods scopes periods query to the requesting org (cross-tenant isolation)", async () => {
    const { db, getWhere } = makeSelectChain([]);
    const svc = makeSvc(db);
    const u = {
      orgId: ATTACKER_ORG,
      userId: "user-1",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: 99, isOrgOwner: false },
    };

    const result = await svc.listPeriods(u as never, { limit: 20 });

    expect(result).toHaveLength(0);
    const vals = sqlValues(getWhere());
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
  });
});
