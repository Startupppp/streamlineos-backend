import type { Db } from "../../../db/drizzle.module";
import { MembershipResolvingDispatchDouble } from "../../notifications/notification-recipient-membership.spec-fixtures";
import { OnboardingAdminService } from "./core/onboarding-admin.service";
import { OnboardingTemplateService } from "./core/onboarding-template.service";
import { OnboardingAnalyticsService } from "./flow/onboarding-analytics.service";
import { GuidedTourService } from "./flow/guided-tour.service";

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
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn({ select: jest.fn().mockReturnValue(builder), query: queryProxy, insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) } as unknown as Db)),
  } as unknown as Db;
  return { db, where, findMany };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("OnboardingAdminService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes onboarding progress query to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockEmail = { send: jest.fn() };
    const dispatch = new MembershipResolvingDispatchDouble([]);
    const svc = new OnboardingAdminService(db, mockEmail as never, dispatch as never);
    await svc.getProgressSummary(ATTACKER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns onboarding progress for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([{ userId: "u1", progress: 50 }]);
    const mockEmail = { send: jest.fn() };
    const dispatch = new MembershipResolvingDispatchDouble([]);
    const svc = new OnboardingAdminService(db, mockEmail as never, dispatch as never);
    await svc.getProgressSummary(OWNER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });

  it("getProgressSummary reaches no dispatcher, so the argument this spec used to omit was never being swallowed", async () => {
    const { db } = makeDb([]);
    const mockEmail = { send: jest.fn() };
    const dispatch = new MembershipResolvingDispatchDouble([]);
    const svc = new OnboardingAdminService(db, mockEmail as never, dispatch as never);
    await svc.getProgressSummary(ATTACKER);
    expect(dispatch.inputs).toEqual([]);
  });
});

describe("OnboardingTemplateService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("scopes template departments to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new OnboardingTemplateService(db);
    await svc.listTemplateDepartments(ATTACKER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns template departments for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new OnboardingTemplateService(db);
    await svc.listTemplateDepartments(OWNER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("OnboardingAnalyticsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, eventType: "STARTED" };

  it("scopes analytics events to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new OnboardingAnalyticsService(db);
    await svc.recentEvents(ATTACKER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns analytics events for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new OnboardingAnalyticsService(db);
    await svc.recentEvents(OWNER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("GuidedTourService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, tourKey: "hr_setup" };

  it("scopes guided tours to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAnalytics = { track: jest.fn() };
    const svc = new GuidedTourService(db, mockAnalytics as never);
    await svc.listToursForUser(ATTACKER, "user-1");
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns guided tours for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockAnalytics = { track: jest.fn() };
    const svc = new GuidedTourService(db, mockAnalytics as never);
    await svc.listToursForUser(OWNER, "user-2");
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});
