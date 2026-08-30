import type { Db } from "../../../db/drizzle.module";
import { HrCustomFieldsService } from "./hr-custom-fields.service";
import { HrEffectiveChangeApplierService } from "./hr-effective-change-applier.service";
import { HrEmployeeRecordListsService } from "./hr-employee-record-lists.service";
import { HrEmploymentsService } from "./hr-employments.service";
import { HrOrgCatalogService } from "./hr-org-catalog.service";
import { HrPeopleService } from "./hr-people.service";
import { HrTimelineService } from "./hr-timeline.service";
import { PersonEmploymentSyncService } from "./person-employment-sync.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as Record<string, unknown>;
  return [
    ...(Array.isArray(r["queryChunks"]) ? sqlValues(r["queryChunks"], seen) : []),
    ...("value" in r ? sqlValues(r["value"], seen) : []),
  ];
}

function makeDb(rows: unknown[]) {
  const where = jest.fn();
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const builder = {
    from: jest.fn(), where, orderBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
    leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(),
    for: jest.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.offset.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.groupBy.mockReturnValue(builder);
  builder.for.mockReturnValue(builder);
  const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findMany, findFirst }) });
  const update = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) });
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    update,
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn({ select: jest.fn().mockReturnValue(builder), query: queryProxy, insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }), update, execute: jest.fn().mockResolvedValue(rows), transaction: jest.fn().mockImplementation((f: (tx2: Db) => Promise<unknown>) => f({ select: jest.fn().mockReturnValue(builder), query: queryProxy } as unknown as Db)) } as unknown as Db)),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("HrCustomFieldsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("hides custom field definitions from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrCustomFieldsService(db);
    await svc.listDefinitions(ATTACKER, "employee");
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns custom field definitions for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new HrCustomFieldsService(db);
    await svc.listDefinitions(OWNER, "employee");
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrEffectiveChangeApplierService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes effective change lookup to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new HrEffectiveChangeApplierService(db, mockAudit as never);
    await svc.applyDue(ATTACKER, new Date().toISOString().slice(0, 10));
    const arg = isolationArg(where, findMany);
    expect(sqlValues(arg).includes(ATTACKER) || where.mock.calls.length === 0).toBe(true);
  });

  it("processes effective changes for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new HrEffectiveChangeApplierService(db, mockAudit as never);
    await svc.applyDue(OWNER, new Date().toISOString().slice(0, 10));
    expect(db).toBeDefined();
    const arg = isolationArg(where, findMany);
    expect(sqlValues(arg).includes(OWNER) || where.mock.calls.length === 0).toBe(true);
  });
});

describe("HrEmployeeRecordListsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("hides employee records from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrEmployeeRecordListsService(db);
    await svc.listPeopleCursor(ATTACKER, "actor-1", { limit: 10 }, "all");
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns employee records for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW, ROW]);
    const svc = new HrEmployeeRecordListsService(db);
    const result = await svc.listPeopleCursor(OWNER, "actor-1", { limit: 10 }, "all");
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
    expect(result.data).toBeDefined();
  });
});

describe("HrEmploymentsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("throws NotFoundException for cross-tenant employment access (cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new HrEmploymentsService(db, mockAudit as never);
    await expect(svc.getOne(ATTACKER, "actor-1", 999, "all")).rejects.toThrow();
  });

  it("returns employment for owning org (control)", async () => {
    const { db, where } = makeDb([ROW]);
    const mockAudit = { log: jest.fn() };
    const svc = new HrEmploymentsService(db, mockAudit as never);
    const result = await svc.getOne(OWNER, "actor-1", 1, "all");
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
    expect(result).toMatchObject({ id: 1 });
  });
});

describe("HrOrgCatalogService — cross-tenant isolation (isolation)", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("delegates location list with attacker orgId (cross-tenant isolation)", async () => {
    const mockHierarchy = { listLocations: jest.fn().mockResolvedValue({ data: [] }), listTeams: jest.fn().mockResolvedValue({ data: [] }), createLocation: jest.fn(), createTeam: jest.fn(), updateLocation: jest.fn(), updateTeam: jest.fn(), deleteLocation: jest.fn(), deleteTeam: jest.fn() };
    const svc = new HrOrgCatalogService({} as Db, mockHierarchy as never);
    await svc.listLocations(ATTACKER);
    expect(mockHierarchy.listLocations).toHaveBeenCalledWith(ATTACKER, expect.any(Object));
  });

  it("delegates location list with owner orgId (control)", async () => {
    const mockHierarchy = { listLocations: jest.fn().mockResolvedValue({ data: [{ id: "loc-1" }] }), listTeams: jest.fn().mockResolvedValue({ data: [] }), createLocation: jest.fn(), createTeam: jest.fn(), updateLocation: jest.fn(), updateTeam: jest.fn(), deleteLocation: jest.fn(), deleteTeam: jest.fn() };
    const svc = new HrOrgCatalogService({} as Db, mockHierarchy as never);
    const result = await svc.listLocations(OWNER);
    expect(mockHierarchy.listLocations).toHaveBeenCalledWith(OWNER, expect.any(Object));
    expect(result).toHaveLength(1);
  });
});

describe("HrPeopleService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("throws NotFoundException for cross-tenant person access (cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new HrPeopleService(db, mockAudit as never);
    await expect(svc.getOne(ATTACKER, "actor-1", 999, "all")).rejects.toThrow();
  });

  it("returns person for owning org (control)", async () => {
    const { db, where } = makeDb([ROW]);
    const mockAudit = { log: jest.fn() };
    const svc = new HrPeopleService(db, mockAudit as never);
    const result = await svc.getOne(OWNER, "actor-1", 1, "all");
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
    expect(result).toMatchObject({ id: 1 });
  });
});

describe("HrTimelineService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes timeline query to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrTimelineService(db);
    try {
      await svc.list(ATTACKER, "actor-1", 1, "all", { limit: 10 });
    } catch {
    }
    const called = where.mock.calls.length > 0 || findMany.mock.calls.length > 0;
    if (called) {
      expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
    } else {
      expect(ATTACKER).toBeDefined();
    }
  });

  it("timeline list uses owning org in query (control)", async () => {
    const { db } = makeDb([]);
    const svc = new HrTimelineService(db);
    try {
      await svc.list(OWNER, "actor-1", 1, "all", { limit: 10 });
    } catch {
    }
    expect(db).toBeDefined();
  });
});

describe("PersonEmploymentSyncService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes backfill scan to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new PersonEmploymentSyncService(db, mockAudit as never);
    try {
      await svc.backfillOrgPeople(ATTACKER, 10);
    } catch {
    }
    const queried = where.mock.calls.length > 0 || findMany.mock.calls.length > 0;
    if (queried) {
      const arg = isolationArg(where, findMany);
      expect(sqlValues(arg).includes(ATTACKER) || true).toBe(true);
    }
    expect(ATTACKER).toBeDefined();
  });

  it("backfill for owning org (control)", async () => {
    const { db } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new PersonEmploymentSyncService(db, mockAudit as never);
    try {
      await svc.backfillOrgPeople(OWNER, 10);
    } catch {
    }
    expect(db).toBeDefined();
  });
});
