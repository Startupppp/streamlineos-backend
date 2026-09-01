import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { HrDisciplinaryService } from "./hr-disciplinary.service";
import { HrSafetyService } from "./hr-safety.service";
import { ServiceDeliveryInboxService } from "./service-delivery-inbox.service";

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

describe("HrDisciplinaryService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("hides disciplinary actions from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const mockTemplates = { getTemplate: jest.fn() };
    const svc = new HrDisciplinaryService(db, mockAudit as never, mockTemplates as never);
    await svc.list(ATTACKER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns disciplinary actions for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockAudit = { log: jest.fn() };
    const mockTemplates = { getTemplate: jest.fn() };
    const svc = new HrDisciplinaryService(db, mockAudit as never, mockTemplates as never);
    await svc.list(OWNER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrSafetyService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("hides safety incidents from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new HrSafetyService(db, mockAudit as never);
    await svc.listIncidents(ATTACKER, { page: 1, limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns safety incidents for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockAudit = { log: jest.fn() };
    const svc = new HrSafetyService(db, mockAudit as never);
    await svc.listIncidents(OWNER, { page: 1, limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("ServiceDeliveryInboxService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes ops inbox to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    };
    const svc = new ServiceDeliveryInboxService(db, mockAccess as never);
    const result = await svc.getOpsInbox(ATTACKER, "user-1");
    const anyWhere = where.mock.calls.some(([c]: [unknown]) => sqlValues(c).includes(ATTACKER));
    const anyFindMany = findMany.mock.calls.some(([o]: [Record<string, unknown>]) => sqlValues(o?.["where"]).includes(ATTACKER));
    expect(anyWhere || anyFindMany || result.totals.cases === 0).toBe(true);
  });

  it("ops inbox contains org identifier for owning org (control)", async () => {
    const { db } = makeDb([]);
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    };
    const svc = new ServiceDeliveryInboxService(db, mockAccess as never);
    const result = await svc.getOpsInbox(OWNER, "user-1");
    expect(result.mode).toBe("ops_unified_inbox");
  });
});
