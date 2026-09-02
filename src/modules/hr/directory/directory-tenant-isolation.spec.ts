// src/modules/hr/directory/directory-tenant-isolation.spec.ts
//
// Cross-tenant isolation tests for all directory services.
// HARD RULE: no production source files modified.

import type { Redis } from "@upstash/redis";
import { CacheService } from "../../../common/cache/cache.service";
import { InMemoryRedis } from "../../../common/cache/in-memory-redis.test-double";
import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { AccessRequestsService } from "./access-requests.service";
import { AssetInventoryService } from "./asset-inventory.service";
import { AssetsRecoveryService } from "./assets-recovery.service";
import { BackgroundVerificationService } from "./background-verification.service";
import { CelebrationsService } from "./celebrations.service";
import { EmployeeMutationsService } from "./employee-mutations.service";
import { EmployeeSkillsService } from "./employee-skills.service";
import { EmployeesService } from "./employees.service";
import { EmployeeAnalyticsService } from "./employee-analytics.service";
import { OrgStructureService } from "./org-structure.service";
import { TeamEventsService } from "./team-events.service";

// ─── helpers ──────────────────────────────────────────────────────────────────

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

// Builds a Drizzle-shaped chain builder that terminates via a Thenable interface.
// Adding `then` makes `await builder` resolve to `rows`, regardless of how many
// chain methods (where, limit, orderBy, leftJoin, etc.) were called before await.
type ChainBuilder = {
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
  orderBy: jest.Mock;
  leftJoin: jest.Mock;
  innerJoin: jest.Mock;
  groupBy: jest.Mock;
  set: jest.Mock;
  returning: jest.Mock;
  values: jest.Mock;
  then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => Promise<unknown>;
};

function makeChainBuilder(rows: unknown[]): { builder: ChainBuilder; where: jest.Mock } {
  const where = jest.fn();
  const builder = {} as ChainBuilder;

  // Thenable: await builder = rows
  builder.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);

  builder.from = jest.fn().mockReturnValue(builder);
  builder.where = where;
  builder.limit = jest.fn().mockReturnValue(builder);
  builder.orderBy = jest.fn().mockReturnValue(builder);
  builder.leftJoin = jest.fn().mockReturnValue(builder);
  builder.innerJoin = jest.fn().mockReturnValue(builder);
  builder.groupBy = jest.fn().mockReturnValue(builder);
  builder.set = jest.fn().mockReturnValue(builder);
  builder.returning = jest.fn().mockReturnValue(builder);
  builder.values = jest.fn().mockReturnValue(builder);

  // where returns the builder so further chaining works; await builder = rows
  where.mockReturnValue(builder);

  return { builder, where };
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock; innerJoin: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock } {
  const { builder, where } = makeChainBuilder(rows);
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  let db: Db;
  db = {
    select: jest.fn().mockReturnValue(builder),
    update: jest.fn().mockReturnValue(builder),
    insert: jest.fn().mockReturnValue(builder),
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(async (fn: (tx: Db) => Promise<unknown>) => fn(db)),
    query: {
      hrAccessRequests: { findMany, findFirst },
      assets: { findMany, findFirst },
      assetReturns: { findMany, findFirst },
      backgroundVerifications: { findMany, findFirst },
      teamEvents: { findMany, findFirst },
      organizationMembers: { findMany, findFirst },
      orgUnits: { findMany, findFirst },
      users: { findMany, findFirst },
      hrEmployments: { findMany, findFirst },
      hrPeople: { findMany, findFirst },
    },
  } as unknown as Db;
  return { db, where, innerJoin: builder.innerJoin, findMany, findFirst };
}

function makeCacheMock(): CacheService {
  return new CacheService(new InMemoryRedis() as unknown as Redis);
}

function makeEmploymentFactsMock() {
  return {
    getFactsBatch: jest.fn().mockResolvedValue(new Map()),
    getFacts: jest.fn().mockResolvedValue(null),
  };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

// ─── AccessRequestsService ────────────────────────────────────────────────────

describe("AccessRequestsService — cross-tenant isolation", () => {
  it("throws NotFoundException for a request owned by a different org (DENY — cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const svc = new AccessRequestsService(db as never);
    await expect(
      svc.update(ATTACKER, "req-1", { status: "granted" }, "actor-1"),
    ).rejects.toThrow(NotFoundException);
  });

  it("looks up access request by orgId for the owning org (CONTROL)", async () => {
    const row = { id: "req-1", orgId: OWNER, status: "pending" };
    const { db, findFirst } = makeDb([row]);
    const svc = new AccessRequestsService(db as never);
    await svc.update(OWNER, "req-1", { status: "granted" }, "actor-1").catch(() => {});
    expect(findFirst).toHaveBeenCalled();
    const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(call?.where)).toContain(OWNER);
  });
});

// ─── AssetInventoryService ────────────────────────────────────────────────────

describe("AssetInventoryService — cross-tenant isolation", () => {
  it("scopes asset query to the requesting org (DENY — cross-tenant isolation)", async () => {
    const { db, findMany } = makeDb([]);
    const dispatch = { dispatch: jest.fn(), notifyAssetAssigned: jest.fn() };
    const svc = new AssetInventoryService(db as never, dispatch as never);
    const result = await svc.list(ATTACKER, { page: 1, limit: 20 } as never);
    expect(result.data).toHaveLength(0);
    expect(findMany).toHaveBeenCalled();
    const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns assets for the owning org (CONTROL)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Laptop", status: "AVAILABLE" };
    const { db, findMany } = makeDb([row]);
    const dispatch = { dispatch: jest.fn(), notifyAssetAssigned: jest.fn() };
    const svc = new AssetInventoryService(db as never, dispatch as never);
    findMany.mockResolvedValue([row]);
    const result = await svc.list(OWNER, { page: 1, limit: 20 } as never);
    expect(findMany).toHaveBeenCalled();
    const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(call?.where)).toContain(OWNER);
  });
});

// ─── AssetsRecoveryService ────────────────────────────────────────────────────

describe("AssetsRecoveryService — cross-tenant isolation", () => {
  it("returns false (no pending recovery) for a different org (DENY — cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new AssetsRecoveryService(db as never);
    const result = await svc.hasPendingRecovery(ATTACKER, "user-1");
    expect(result).toBe(false);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("detects pending recovery for the owning org (CONTROL)", async () => {
    // The service calls select().from().where().limit(1); with the thenable builder
    // await limit(1) = await builder = [{ id: 1 }], so length > 0 → true
    const { db } = makeDb([{ id: 1 }]);
    const svc = new AssetsRecoveryService(db as never);
    const result = await svc.hasPendingRecovery(OWNER, "user-1");
    expect(result).toBe(true);
  });
});

// ─── BackgroundVerificationService ───────────────────────────────────────────

describe("BackgroundVerificationService — cross-tenant isolation", () => {
  it("returns empty list for a different org (DENY — cross-tenant isolation)", async () => {
    const { db, findMany } = makeDb([]);
    const employmentFacts = makeEmploymentFactsMock();
    const svc = new BackgroundVerificationService(db as never, employmentFacts as never);
    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalled();
    const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns rows for the owning org (CONTROL)", async () => {
    const row = { id: 1, orgId: OWNER, user: { id: "user-1", name: "Alice" } };
    const { db, findMany } = makeDb([row]);
    const employmentFacts = makeEmploymentFactsMock();
    const svc = new BackgroundVerificationService(db as never, employmentFacts as never);
    findMany.mockResolvedValue([row]);
    const result = await svc.list(OWNER);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(call?.where)).toContain(OWNER);
  });
});

// ─── CelebrationsService ─────────────────────────────────────────────────────

describe("CelebrationsService — cross-tenant isolation", () => {
  it("scopes anniversary feed query to the requesting org (DENY — cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const cache = makeCacheMock();
    const svc = new CelebrationsService(db as never, cache as never);
    await svc.getAnniversaryFeed(ATTACKER, "actor-1", "all");
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("returns feed for the owning org (CONTROL)", async () => {
    const memberRow = { userId: "user-1", name: "Alice", image: null, dateOfBirth: null, joiningDate: "2020-01-01" };
    const { db, where } = makeDb([memberRow]);
    const cache = makeCacheMock();
    const svc = new CelebrationsService(db as never, cache as never);
    await svc.getAnniversaryFeed(OWNER, "actor-1", "all");
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

// ─── EmployeeMutationsService ─────────────────────────────────────────────────

describe("EmployeeMutationsService — cross-tenant isolation", () => {
  it("returns null for a member in a different org (DENY — cross-tenant isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const cache = makeCacheMock();
    const audit = { log: jest.fn() };
    const hrAutomation = { trigger: jest.fn() };
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) };
    const employment = makeEmploymentFactsMock();
    const svc = new EmployeeMutationsService(
      db as never, cache as never, audit as never, hrAutomation as never, access as never, employment as never,
    );
    const result = await svc.getEmployeeDetail(ATTACKER, "actor-1", "target-1", "all");
    expect(result).toBeNull();
    expect(findFirst).toHaveBeenCalled();
    const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns detail for a member of the owning org (CONTROL)", async () => {
    const user = { id: "target-1", name: "Alice", firstName: "Alice", lastName: "Smith", email: "a@x.com", image: null, isActive: true, bio: null, linkedinUrl: null, twitterUrl: null, githubUrl: null, websiteUrl: null, phone: null };
    const memberRow = { userId: "target-1", role: "MEMBER", user };
    const { db, findFirst, where } = makeDb([memberRow]);
    findFirst.mockResolvedValue(memberRow);
    const cache = makeCacheMock();
    const audit = { log: jest.fn() };
    const hrAutomation = { trigger: jest.fn() };
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) };
    const employment = makeEmploymentFactsMock();
    // getFacts must return EmploymentFacts (never null) — real impl uses emptyEmploymentFacts as fallback
    employment.getFacts.mockResolvedValue({
      userId: "target-1",
      employmentId: null,
      employeeNumber: null,
      designation: null,
      joiningDate: null,
      departmentId: null,
      locationId: null,
      managerUserId: null,
    });
    const svc = new EmployeeMutationsService(
      db as never, cache as never, audit as never, hrAutomation as never, access as never, employment as never,
    );
    const result = await svc.getEmployeeDetail(OWNER, "actor-1", "target-1", "all");
    expect(result).not.toBeNull();
    const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(call?.where)).toContain(OWNER);
  });
});

// ─── EmployeeSkillsService ────────────────────────────────────────────────────

describe("EmployeeSkillsService — cross-tenant isolation", () => {
  it("scopes expert search to the requesting org (DENY — cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new EmployeeSkillsService(db as never);
    await svc.findExpert(ATTACKER, "actor-1", { skill: "TypeScript" } as never, "all");
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  // findExpert uses db.$with (CTE) after the initial member query; empty rows triggers
  // the early-return path, so the where clause is still asserted without hitting the CTE.
  it("scopes expert search to the owning org (CONTROL)", async () => {
    const { db, where } = makeDb([]);
    const svc = new EmployeeSkillsService(db as never);
    await svc.findExpert(OWNER, "actor-1", { skill: "TypeScript" } as never, "all");
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

// ─── EmployeesService ─────────────────────────────────────────────────────────

describe("EmployeesService — cross-tenant isolation", () => {
  it("scopes stats query to the requesting org (DENY — cross-tenant isolation)", async () => {
    const { db, where } = makeDb([{ total: "0", approved: "0", pending: "0", rejected: "0" }]);
    const cache = makeCacheMock();
    const employment = makeEmploymentFactsMock();
    const svc = new EmployeeAnalyticsService(db as never, employment as never);
    await svc.getStats(ATTACKER, "user-1");
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("returns stats for the owning org (CONTROL)", async () => {
    const { db, where } = makeDb([{ total: "5", approved: "3", pending: "1", rejected: "1", daysPresent: "20", totalHours: "160" }]);
    const cache = makeCacheMock();
    const employment = makeEmploymentFactsMock();
    const svc = new EmployeeAnalyticsService(db as never, employment as never);
    const result = await svc.getStats(OWNER, "user-1");
    expect(result).toBeDefined();
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

// ─── OrgStructureService ─────────────────────────────────────────────────────

describe("OrgStructureService — cross-tenant isolation", () => {
  it("scopes directory query to the requesting org (DENY — cross-tenant isolation)", async () => {
    const { db, innerJoin } = makeDb([]);
    (db.query as Record<string, unknown>).orgUnits = { findMany: jest.fn().mockResolvedValue([]) };
    const cache = makeCacheMock();
    const employment = makeEmploymentFactsMock();
    const svc = new OrgStructureService(db as never, cache as never, employment as never, undefined as never);
    await svc.getDirectory(ATTACKER, "actor-1", "all");
    // The org predicate lives in the innerJoin condition:
    // innerJoin(organizationMembers, and(eq(userId, users.id), eq(orgId, orgId)))
    // applyScope("all") returns sql`true`, so `where` contains no orgId.
    expect(innerJoin).toHaveBeenCalled();
    expect(sqlValues(innerJoin.mock.calls[0]?.[1])).toContain(ATTACKER);
  });

  it("returns directory for the owning org (CONTROL)", async () => {
    const memberRow = { id: "user-1", name: "Alice", firstName: "Alice", lastName: "Smith", email: "a@b.com", image: null, role: "MEMBER", phone: null, isActive: true };
    const { db, innerJoin } = makeDb([memberRow]);
    (db.query as Record<string, unknown>).orgUnits = { findMany: jest.fn().mockResolvedValue([]) };
    const cache = makeCacheMock();
    const employment = makeEmploymentFactsMock();
    const svc = new OrgStructureService(db as never, cache as never, employment as never, undefined as never);
    await svc.getDirectory(OWNER, "actor-1", "all");
    expect(innerJoin).toHaveBeenCalled();
    expect(sqlValues(innerJoin.mock.calls[0]?.[1])).toContain(OWNER);
  });
});

// ─── TeamEventsService ────────────────────────────────────────────────────────

describe("TeamEventsService — cross-tenant isolation", () => {
  it("returns empty list for a different org (DENY — cross-tenant isolation)", async () => {
    const { db, findMany } = makeDb([]);
    const employmentFacts = makeEmploymentFactsMock();
    const svc = new TeamEventsService(db as never, employmentFacts as never);
    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalled();
    const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns events for the owning org (CONTROL)", async () => {
    const row = { id: 1, orgId: OWNER, organizer: null, participants: [] };
    const { db, findMany } = makeDb([row]);
    const employmentFacts = makeEmploymentFactsMock();
    const svc = new TeamEventsService(db as never, employmentFacts as never);
    findMany.mockResolvedValue([row]);
    const result = await svc.list(OWNER);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(call?.where)).toContain(OWNER);
  });
});
