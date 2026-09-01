import { BadRequestException } from "@nestjs/common";
import { decodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";
import { CompPlanningService } from "./comp-planning.service";
import { DevicesService } from "./devices.service";
import { EquityService } from "./equity.service";
import { PayrollComplianceService } from "./payroll-compliance.service";
import { WorkforceCostingService } from "./workforce-costing.service";

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
    from: jest.fn(),
    where,
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    groupBy: jest.fn(),
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
  const queryProxy = new Proxy({} as Record<string, unknown>, {
    get: () => ({ findMany, findFirst }),
  });
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    execute: jest.fn().mockResolvedValue(rows),
  } as unknown as Db;
  return { db, where, findMany };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("DevicesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, createdAt: new Date("2026-08-20T09:00:00.000Z") };

  it("hides time devices from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new DevicesService(db, mockAudit as never);
    await svc.listDevices(ATTACKER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns time devices for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockAudit = { log: jest.fn() };
    const svc = new DevicesService(db, mockAudit as never);
    await svc.listDevices(OWNER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });

  it("uses the kept row for the next cursor and rejects malformed cursors", async () => {
    const next = { id: 2, orgId: OWNER, createdAt: new Date("2026-08-20T08:00:00.000Z") };
    const { db } = makeDb([ROW, next]);
    const svc = new DevicesService(db, { log: jest.fn() } as never);

    const page = await svc.listDevices(OWNER, { limit: 1, status: "active" });
    expect(page.data).toEqual([ROW]);
    expect(page.pagination).toMatchObject({ limit: 1, hasMore: true });
    expect(decodeCursor(page.pagination.nextCursor)).toEqual({
      sortValue: ROW.createdAt.toISOString(),
      id: String(ROW.id),
    });
    await expect(
      svc.listDevices(OWNER, { limit: 10, cursor: "malformed" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("CompPlanningService cursor validation", () => {
  it("rejects malformed cursors with a semantic 400", async () => {
    const { db } = makeDb([]);
    const svc = new CompPlanningService(
      db,
      { log: jest.fn() } as never,
      {} as never,
    );

    await expect(
      svc.listCycles("org-owner", { limit: 10, cursor: "malformed" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("EquityService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, units: 100 };

  it("hides equity grants from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new EquityService(db, mockAudit as never);
    await svc.listGrants(ATTACKER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns equity grants for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockAudit = { log: jest.fn() };
    const svc = new EquityService(db, mockAudit as never);
    await svc.listGrants(OWNER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });

  it("rejects malformed cursors with a semantic 400", async () => {
    const { db } = makeDb([]);
    const svc = new EquityService(db, { log: jest.fn() } as never);
    await expect(
      svc.listGrants(OWNER, { limit: 10, cursor: "malformed" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("PayrollComplianceService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("hides compliance records from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new PayrollComplianceService(db, mockAudit as never);
    await svc.listVarianceApprovals(ATTACKER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns compliance records for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockAudit = { log: jest.fn() };
    const svc = new PayrollComplianceService(db, mockAudit as never);
    await svc.listVarianceApprovals(OWNER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });

  it("rejects malformed cursors with a semantic 400", async () => {
    const { db } = makeDb([]);
    const svc = new PayrollComplianceService(db, { log: jest.fn() } as never);
    await expect(
      svc.listComplianceTasks(OWNER, { limit: 10, cursor: "malformed" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("WorkforceCostingService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes cost SQL query to attacker org (cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const svc = new WorkforceCostingService(db);
    await svc.costByDepartment(ATTACKER, "2024-01");
    const execMock = (db.execute as jest.Mock);
    expect(execMock).toHaveBeenCalled();
    expect(sqlValues(execMock.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("scopes cost SQL query to owner org (control)", async () => {
    const { db } = makeDb([]);
    const svc = new WorkforceCostingService(db);
    await svc.costByDepartment(OWNER, "2024-01");
    const execMock = (db.execute as jest.Mock);
    expect(execMock).toHaveBeenCalled();
    expect(sqlValues(execMock.mock.calls[0]?.[0])).toContain(OWNER);
  });
});
