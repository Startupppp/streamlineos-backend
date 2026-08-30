import type { Db } from "../../../db/drizzle.module";
import { EmployeeBulkOnboardingService } from "./employee-bulk-onboarding.service";
import { EmployeeOnboardingService } from "./employee-onboarding.service";

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
    leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(), for: jest.fn(),
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
  const txDb = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows), onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }), onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows), returning: jest.fn().mockResolvedValue(rows) }) }),
    execute: jest.fn().mockResolvedValue(rows),
  } as unknown as Db;
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows), onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }), onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows) }) }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn(txDb)),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock, findFirst?: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  if (findFirst && findFirst.mock.calls.length > 0) return (findFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("EmployeeBulkOnboardingService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes department query to actor org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { logCritical: jest.fn() };
    const mockOnboarding = { onboardEmployee: jest.fn().mockResolvedValue({ userId: "u1" }) };
    const mockHierarchyCache = { invalidateAfterMutation: jest.fn() };
    const svc = new EmployeeBulkOnboardingService(db, mockAudit as never, mockOnboarding as never, mockHierarchyCache as never);
    const actor = { orgId: ATTACKER, userId: "u-attacker", isOrgOwner: false };
    await svc.onboardEmployeesBulk(actor as never, []);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("scopes department query to owner org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { logCritical: jest.fn() };
    const mockOnboarding = { onboardEmployee: jest.fn().mockResolvedValue({ userId: "u1" }) };
    const mockHierarchyCache = { invalidateAfterMutation: jest.fn() };
    const svc = new EmployeeBulkOnboardingService(db, mockAudit as never, mockOnboarding as never, mockHierarchyCache as never);
    const actor = { orgId: OWNER, userId: "u-owner", isOrgOwner: false };
    await svc.onboardEmployeesBulk(actor as never, []);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("EmployeeOnboardingService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes membership check to actor org when onboarding existing user (cross-tenant isolation)", async () => {
    const existingUser = { id: "user-exist-1", email: "user@test.com" };
    let callCount = 0;
    const where = jest.fn();
    const findFirst = jest.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(existingUser);
      return Promise.resolve(null);
    });
    const findMany = jest.fn().mockResolvedValue([]);
    const builder = {
      from: jest.fn(), where, orderBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
      leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(), for: jest.fn(),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
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
    const db = {
      select: jest.fn().mockReturnValue(builder),
      query: queryProxy,
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation((fn: (tx: typeof db) => Promise<unknown>) => fn(db)),
    } as unknown as Db;

    const mockCache = { invalidate: jest.fn() };
    const mockAudit = { logCritical: jest.fn() };
    const mockEmail = { sendWelcomeEmail: jest.fn() };
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const mockWebhooks = { dispatch: jest.fn() };
    const mockSync = { ensureFromUser: jest.fn().mockResolvedValue({ employmentId: 1 }) };
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()), membersWithPermission: jest.fn().mockResolvedValue([]) };
    const mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const mockSeatLedger = { recordSeatEvent: jest.fn().mockResolvedValue(undefined) };

    const svc = new EmployeeOnboardingService(
      db, mockCache as never, mockAudit as never, mockEmail as never,
      mockAutomation as never, mockWebhooks as never, mockSync as never,
      mockAccess as never, mockPlanLimits as never, mockSeatLedger as never,
    );

    const actor = { orgId: ATTACKER, userId: "actor-1", isOrgOwner: true };
    const body = { firstName: "Jane", lastName: "Doe", email: "user@test.com", designation: "Eng", whatsappSameAsPhone: true };
    await expect(svc.onboardEmployee(actor as never, body as never)).rejects.toThrow();

    const allWhereArgs = where.mock.calls.flatMap((call) => sqlValues(call[0]));
    const allFindFirstArgs = findFirst.mock.calls.flatMap((call) =>
      sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
    );
    expect([...allWhereArgs, ...allFindFirstArgs]).toContain(ATTACKER);
  });

  it("uses owner org for membership scoping (control — same-tenant access works)", async () => {
    const existingUser = { id: "user-exist-2", email: "owner@test.com" };
    let callCount = 0;
    const where = jest.fn();
    const findFirst = jest.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(existingUser);
      return Promise.resolve(null);
    });
    const findMany = jest.fn().mockResolvedValue([]);
    const builder = {
      from: jest.fn(), where, orderBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
      leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(), for: jest.fn(),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
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
    const db = {
      select: jest.fn().mockReturnValue(builder),
      query: queryProxy,
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation((fn: (tx: typeof db) => Promise<unknown>) => fn(db)),
    } as unknown as Db;

    const mockCache = { invalidate: jest.fn() };
    const mockAudit = { logCritical: jest.fn() };
    const mockEmail = { sendWelcomeEmail: jest.fn() };
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const mockWebhooks = { dispatch: jest.fn() };
    const mockSync = { ensureFromUser: jest.fn().mockResolvedValue({ employmentId: 1 }) };
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()), membersWithPermission: jest.fn().mockResolvedValue([]) };
    const mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const mockSeatLedger = { recordSeatEvent: jest.fn().mockResolvedValue(undefined) };

    const svc = new EmployeeOnboardingService(
      db, mockCache as never, mockAudit as never, mockEmail as never,
      mockAutomation as never, mockWebhooks as never, mockSync as never,
      mockAccess as never, mockPlanLimits as never, mockSeatLedger as never,
    );

    const actor = { orgId: OWNER, userId: "actor-2", isOrgOwner: true };
    const body = { firstName: "John", lastName: "Smith", email: "owner@test.com", designation: "PM", whatsappSameAsPhone: true };
    await expect(svc.onboardEmployee(actor as never, body as never)).rejects.toThrow();

    const allWhereArgs = where.mock.calls.flatMap((call) => sqlValues(call[0]));
    const allFindFirstArgs = findFirst.mock.calls.flatMap((call) =>
      sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
    );
    expect([...allWhereArgs, ...allFindFirstArgs]).toContain(OWNER);
  });
});
