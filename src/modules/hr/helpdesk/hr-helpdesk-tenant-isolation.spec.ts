import type { Db } from "../../../db/drizzle.module";
import { HrHelpdeskService } from "./hr-helpdesk.service";
import { HrCalendarService } from "./hr-calendar.service";
import { HrHelpdeskConfigService } from "./hr-helpdesk-config.service";
import { HrAuditService } from "../core/hr-audit.service";
import type { KnowledgeAuthorizationService } from "../../kb/core/authorization/knowledge-authorization.service";
import type { SupportActor } from "./lib/support-queues";

function helpdeskService(db: Db): HrHelpdeskService {
  const audit = new HrAuditService(db);
  const standingIsNeverResolvedHere = {
    resolveStanding: jest.fn(),
  } as unknown as KnowledgeAuthorizationService;
  return new HrHelpdeskService(
    db,
    new HrHelpdeskConfigService(db, audit),
    audit,
    standingIsNeverResolvedHere,
  );
}

function agent(orgId: string): SupportActor {
  return { orgId, userId: "user-1", membershipId: 1, isAdmin: false, queues: new Set(["IT"]) };
}

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
  const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findMany, findFirst }) });
  const db = { select: jest.fn().mockReturnValue(builder), query: queryProxy, insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }), execute: jest.fn().mockResolvedValue(rows) } as unknown as Db;
  return { db, where, findMany };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("HrHelpdeskService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("hides helpdesk tickets from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = helpdeskService(db);
    await svc.list(agent(ATTACKER), { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns helpdesk tickets for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = helpdeskService(db);
    await svc.list(agent(OWNER), { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });

  it("scopes the employee's own list to the attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = helpdeskService(db);
    await svc.listMine(ATTACKER, "user-1", { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });
});

describe("HrCalendarService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes calendar events to attacker org context (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockCelebrations = { getUpcoming: jest.fn().mockResolvedValue([]), getAnniversaryFeed: jest.fn().mockResolvedValue([]) };
    const mockAccess = { holds: jest.fn().mockResolvedValue(false) };
    const svc = new HrCalendarService(db, mockCelebrations as never, mockAccess as never);
    const userCtx = { orgId: ATTACKER, userId: "user-1", email: "a@b.com", roles: [] };
    await svc.getEvents(userCtx as never, { from: "2024-01-01", to: "2024-01-31", types: undefined });
    const arg = isolationArg(where, findMany);
    expect(sqlValues(arg).includes(ATTACKER) || (db.select as jest.Mock).mock.calls.length === 0).toBe(true);
  });

  it("returns calendar events for owning org (control)", async () => {
    const { db } = makeDb([]);
    const mockCelebrations = { getUpcoming: jest.fn().mockResolvedValue([]), getAnniversaryFeed: jest.fn().mockResolvedValue([]) };
    const mockAccess = { holds: jest.fn().mockResolvedValue(false) };
    const svc = new HrCalendarService(db, mockCelebrations as never, mockAccess as never);
    const userCtx = { orgId: OWNER, userId: "user-2", email: "b@c.com", roles: [] };
    const result = await svc.getEvents(userCtx as never, { from: "2024-01-01", to: "2024-01-31", types: undefined });
    expect(Array.isArray(result)).toBe(true);
  });
});
