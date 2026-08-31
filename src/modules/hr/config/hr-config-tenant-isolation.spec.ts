import type { Db } from "../../../db/drizzle.module";
import { HrEmailTemplatesService } from "./hr-email-templates.service";
import { HrHandbookService } from "./hr-handbook.service";
import { HrInterviewQuestionsService } from "./hr-interview-questions.service";
import { HrNotificationPreferencesService } from "./hr-notification-preferences.service";
import { HrSalaryStructuresService } from "./hr-salary-structures.service";

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

describe("HrEmailTemplatesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, name: "template" };

  it("hides email templates from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockGateway = { generate: jest.fn(), generateWithUsage: jest.fn() };
    const svc = new HrEmailTemplatesService(db, mockGateway as never);
    await svc.list(ATTACKER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns email templates for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockGateway = { generate: jest.fn(), generateWithUsage: jest.fn() };
    const svc = new HrEmailTemplatesService(db, mockGateway as never);
    await svc.list(OWNER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrHandbookService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, title: "policy" };

  it("hides handbook entries from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrHandbookService(db);
    await svc.list(ATTACKER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns handbook entries for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new HrHandbookService(db);
    await svc.list(OWNER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrInterviewQuestionsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, question: "Tell me about yourself" };

  it("hides interview questions from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrInterviewQuestionsService(db);
    await svc.list(ATTACKER, {});
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns interview questions for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new HrInterviewQuestionsService(db);
    await svc.list(OWNER, {});
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrNotificationPreferencesService — cross-tenant isolation", () => {
  const USER_A = "user-attacker";
  const USER_B = "user-owner";

  function makePrefsDb(row: unknown) {
    const findFirst = jest.fn().mockResolvedValue(row);
    const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findFirst, findMany: jest.fn().mockResolvedValue(row ? [row] : []) }) });
    const db = { query: queryProxy, insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }), update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }) } as unknown as Db;
    return { db, findFirst };
  }

  it("get preferences scopes findFirst to requesting user (cross-tenant isolation — user-scoped data)", async () => {
    const { db, findFirst } = makePrefsDb(null);
    const svc = new HrNotificationPreferencesService(db);
    const result = await svc.get(USER_A);
    const arg = (findFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
    expect(sqlValues(arg)).toContain(USER_A);
    expect(result.emailEnabled).toBe(true);
  });

  it("returns stored prefs for correct user (control — same-user access works)", async () => {
    const row = { userId: USER_B, emailEnabled: false, pushEnabled: true, smsEnabled: false, inAppEnabled: true, quietHoursStart: null, quietHoursEnd: null, categories: {} };
    const { db, findFirst } = makePrefsDb(row);
    const svc = new HrNotificationPreferencesService(db);
    const result = await svc.get(USER_B);
    const arg = (findFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
    expect(sqlValues(arg)).toContain(USER_B);
    expect(result.emailEnabled).toBe(false);
  });
});

describe("HrSalaryStructuresService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("hides salary structures from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const mockCache = { cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()) };
    const svc = new HrSalaryStructuresService(db, mockAudit as never, mockCache as never);
    await svc.list(ATTACKER, undefined, "actor-1", false);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns salary structures for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockAudit = { log: jest.fn() };
    const mockCache = { cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()) };
    const svc = new HrSalaryStructuresService(db, mockAudit as never, mockCache as never);
    await svc.list(OWNER, undefined, "actor-1", false);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});
