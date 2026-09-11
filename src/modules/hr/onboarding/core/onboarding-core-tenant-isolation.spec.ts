import { ForbiddenException, NotFoundException } from "@nestjs/common";
jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown, ctx: unknown) => unknown, opts: unknown) => fn(_db, opts),
  runInNewTenantTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../../common/tenant/tenant-context", () => ({
  registerAfterCommit: jest.fn().mockReturnValue(false),
}));

import type { Db } from "../../../../db/drizzle.module";
import { OnboardingDetailsService } from "./onboarding-details.service";
import { OnboardingInitiationService } from "./onboarding-initiation.service";
import { OnboardingInitiationDispatchService } from "./onboarding-initiation-dispatch.service";
import { OnboardingProbationService } from "./onboarding-probation.service";
import { OnboardingRequirementsService } from "./onboarding-requirements.service";
import { OnboardingSubmissionService } from "./onboarding-submission.service";
import { OnboardingTaskService } from "./onboarding-task.service";

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
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(rows),
        onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }),
        onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(rows),
        }),
      }),
    }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => {
      const txDb = {
        select: jest.fn().mockReturnValue(builder),
        query: queryProxy,
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(rows),
            onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
          }),
        }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
        execute: jest.fn().mockResolvedValue(rows),
      } as unknown as Db;
      return fn(txDb);
    }),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function allArgs(where: jest.Mock, findFirst: jest.Mock, findMany?: jest.Mock): unknown[] {
  const wh = where.mock.calls.flatMap((c) => sqlValues(c[0]));
  const ff = findFirst.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"]));
  const fm = findMany ? findMany.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"])) : [];
  return [...wh, ...ff, ...fm];
}

describe("OnboardingDetailsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes getPersonalDetails to org (cross-tenant isolation — NotFoundException if not in org)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockCache = { invalidate: jest.fn() };
    const svc = new OnboardingDetailsService(db, mockCache as never);
    await expect(svc.getPersonalDetails(ATTACKER, "user-1")).rejects.toThrow(NotFoundException);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("returns personal details for own org (control — same-tenant access works)", async () => {
    const ROW = { userPhone: null, userGender: null, userDateOfBirth: null, userEmergencyContact: null, personPhone: null, personGender: null, personDateOfBirth: null, personAddress: null, personEmergencyContact: null };
    const { db, where, findFirst, findMany } = makeDb([ROW]);
    const mockCache = { invalidate: jest.fn() };
    const svc = new OnboardingDetailsService(db, mockCache as never);
    await svc.getPersonalDetails(OWNER, "user-1");
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes getStatus to org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockCache = { invalidate: jest.fn() };
    const svc = new OnboardingDetailsService(db, mockCache as never);
    await svc.getStatus("user-1", ATTACKER);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});

describe("OnboardingInitiationService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes membership check to org in initiation (cross-tenant isolation — user_not_found for attacker org)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockSync = { ensureFromUserId: jest.fn().mockResolvedValue(null) };
    const mockDispatch = { schedule: jest.fn() };
    const mockEmployment = { getFacts: jest.fn().mockResolvedValue({ departmentId: null, joiningDate: null, designation: null, managerUserId: null }) };
    const svc = new OnboardingInitiationService(db, mockSync as never, mockDispatch as never, mockEmployment as never);
    const result = await svc.initiate(ATTACKER, "actor-1", { userId: "target-1" });
    expect("error" in result).toBe(true);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("uses owner org for membership check (control — same-tenant, user_not_found from empty db)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockSync = { ensureFromUserId: jest.fn().mockResolvedValue(null) };
    const mockDispatch = { schedule: jest.fn() };
    const mockEmployment = { getFacts: jest.fn().mockResolvedValue({ departmentId: null, joiningDate: null, designation: null, managerUserId: null }) };
    const svc = new OnboardingInitiationService(db, mockSync as never, mockDispatch as never, mockEmployment as never);
    const result = await svc.initiate(OWNER, "actor-2", { userId: "target-2" });
    expect("error" in result).toBe(true);
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });
});

describe("OnboardingInitiationDispatchService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("schedules dispatch scoped to attacker org (cross-tenant isolation — orgId propagated)", () => {
    const { db } = makeDb([]);
    const mockNotifications = { emit: jest.fn().mockResolvedValue(undefined) };
    const mockAccess = { membersWithPermission: jest.fn().mockResolvedValue([]) };
    const mockAutomation = { emit: jest.fn().mockResolvedValue(undefined) };
    const mockEmployment = { getFacts: jest.fn().mockResolvedValue({ managerUserId: null }) };
    const svc = new OnboardingInitiationDispatchService(db, mockNotifications as never, mockAccess as never, mockAutomation as never, mockEmployment as never);
    svc.schedule(ATTACKER, { id: "u1", email: null, name: null, designation: null, joiningDate: null }, 5, new Map());
    expect(mockNotifications.emit).not.toHaveBeenCalledWith(expect.objectContaining({ orgId: OWNER }));
  });

  it("schedule uses owner org (control — same-tenant dispatch)", () => {
    const { db } = makeDb([]);
    const mockNotifications = { emit: jest.fn().mockResolvedValue(undefined) };
    const mockAccess = { membersWithPermission: jest.fn().mockResolvedValue([]) };
    const mockAutomation = { emit: jest.fn().mockResolvedValue(undefined) };
    const mockEmployment = { getFacts: jest.fn().mockResolvedValue({ managerUserId: null }) };
    const svc = new OnboardingInitiationDispatchService(db, mockNotifications as never, mockAccess as never, mockAutomation as never, mockEmployment as never);
    svc.schedule(OWNER, { id: "u2", email: null, name: null, designation: null, joiningDate: null }, 3, new Map());
    expect(mockNotifications.emit).not.toHaveBeenCalledWith(expect.objectContaining({ orgId: ATTACKER }));
  });
});

describe("OnboardingProbationService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes employment query to org (cross-tenant isolation — no employment returns null lifecycle)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockPolicyEval = { evaluatePolicy: jest.fn().mockResolvedValue(null) };
    const mockEmployments = { transition: jest.fn().mockResolvedValue(undefined) };
    const mockProbationReviews = { setupProbation: jest.fn().mockResolvedValue(undefined) };
    const svc = new OnboardingProbationService(db, mockPolicyEval as never, mockEmployments as never, mockProbationReviews as never);
    const result = await svc.setupProbationForUser(ATTACKER, "user-1");
    expect(result.lifecycleStatus).toBeNull();
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("finds employment in owner org for probation setup (control)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockPolicyEval = { evaluatePolicy: jest.fn().mockResolvedValue(null) };
    const mockEmployments = { transition: jest.fn().mockResolvedValue(undefined) };
    const mockProbationReviews = { setupProbation: jest.fn().mockResolvedValue(undefined) };
    const svc = new OnboardingProbationService(db, mockPolicyEval as never, mockEmployments as never, mockProbationReviews as never);
    const result = await svc.setupProbationForUser(OWNER, "user-2");
    expect(result.lifecycleStatus).toBeNull();
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });
});

describe("OnboardingRequirementsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes org country lookup to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new OnboardingRequirementsService(db);
    await svc.getRequirements(ATTACKER, null);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes org country lookup to owner org (control — same-tenant access works)", async () => {
    const ROW = { country: "IN" };
    const { db, where, findFirst, findMany } = makeDb([ROW]);
    const svc = new OnboardingRequirementsService(db);
    await svc.getRequirements(OWNER, null);
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes document type check to org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new OnboardingRequirementsService(db);
    await svc.ensureDocumentTypes(ATTACKER, null);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});

describe("OnboardingSubmissionService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes membership check to org in submit (cross-tenant isolation — NotFoundException)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockCache = { invalidate: jest.fn() };
    const mockAudit = { logCritical: jest.fn().mockResolvedValue(undefined) };
    const svc = new OnboardingSubmissionService(db, mockCache as never, mockAudit as never);
    await expect(svc.submit(ATTACKER, "user-1")).rejects.toThrow(NotFoundException);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("submits onboarding in owner org (control — same-tenant access works)", async () => {
    const MEMBER = { id: 1, orgId: OWNER };
    const { db, where, findFirst, findMany } = makeDb([MEMBER]);
    const mockCache = { invalidate: jest.fn() };
    const mockAudit = { logCritical: jest.fn().mockResolvedValue(undefined) };
    const svc = new OnboardingSubmissionService(db, mockCache as never, mockAudit as never);
    await svc.submit(OWNER, "user-1");
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });
});

describe("OnboardingTaskService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes task query to org (cross-tenant isolation — ForbiddenException if no view permission)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
      broadest: jest.fn(),
    };
    const mockDispatch = { emit: jest.fn().mockResolvedValue(undefined) };
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const mockHrAutomation = { emit: jest.fn().mockResolvedValue(undefined) };
    const mockProbation = { setupProbationForUser: jest.fn().mockResolvedValue({ probationEndDate: null, lifecycleStatus: null }) };
    const svc = new OnboardingTaskService(db, mockAccess as never, mockDispatch as never, mockAutomation as never, mockHrAutomation as never, mockProbation as never);
    const actor = { orgId: ATTACKER, userId: "actor-1", isOrgOwner: false };
    await expect(svc.getUserTasks(actor as never, "user-1")).rejects.toThrow(ForbiddenException);
    expect(mockAccess.resolveUserPermissions).toHaveBeenCalledWith(ATTACKER, "actor-1");
  });

  it("uses owner org for permission resolution (control — same-tenant, ForbiddenException from no permission)", async () => {
    const { db } = makeDb([]);
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
    };
    const mockDispatch = { emit: jest.fn().mockResolvedValue(undefined) };
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const mockHrAutomation = { emit: jest.fn().mockResolvedValue(undefined) };
    const mockProbation = { setupProbationForUser: jest.fn().mockResolvedValue({ probationEndDate: null, lifecycleStatus: null }) };
    const svc = new OnboardingTaskService(db, mockAccess as never, mockDispatch as never, mockAutomation as never, mockHrAutomation as never, mockProbation as never);
    const actor = { orgId: OWNER, userId: "actor-2", isOrgOwner: false };
    await expect(svc.getUserTasks(actor as never, "user-2")).rejects.toThrow(ForbiddenException);
    expect(mockAccess.resolveUserPermissions).toHaveBeenCalledWith(OWNER, "actor-2");
  });
});
