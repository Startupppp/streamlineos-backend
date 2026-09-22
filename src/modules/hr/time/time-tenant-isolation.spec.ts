import type { Db } from "../../../db/drizzle.module";
import { AttendanceService } from "./attendance.service";
import { AttendanceClockService } from "./attendance-clock.service";
import { AttendancePolicyService } from "./attendance-policy.service";
import { AttendanceReadService } from "./attendance-read.service";
import { AttendanceRegularizationService } from "./attendance-regularization.service";
import { BiometricService } from "./biometric.service";
import { CompOffGrantService } from "./comp-off-grant.service";
import { GeofencingService } from "./geofencing.service";
import { LeavePoliciesService } from "./leave-policies.service";
import { LeaveTypesService } from "./leave-types.service";
import { LeavesApprovalService } from "./leaves-approval.service";
import { LeavesPageService } from "./leaves-page.service";
import { OvertimeService } from "./overtime.service";
import { RostersService } from "./rosters.service";
import { ShiftsService } from "./shifts.service";
import { WorkLogsService } from "./work-logs.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
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

type ChainBuilder = {
  from: jest.Mock; leftJoin: jest.Mock; innerJoin: jest.Mock; where: jest.Mock;
  orderBy: jest.Mock; groupBy: jest.Mock; limit: jest.Mock; offset: jest.Mock;
  having: jest.Mock; as: jest.Mock; for: jest.Mock;
  then: <T>(resolve: (rows: unknown[]) => T) => Promise<T>;
};

function makeChainBuilder(rows: unknown[]): { builder: ChainBuilder; where: jest.Mock } {
  const where = jest.fn();
  const builder: ChainBuilder = {
    from: jest.fn(), leftJoin: jest.fn(), innerJoin: jest.fn(), where,
    orderBy: jest.fn(), groupBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
    having: jest.fn(), as: jest.fn().mockReturnValue({}), for: jest.fn(),
    then: <T>(resolve: (rows: unknown[]) => T) => Promise.resolve(rows).then(resolve),
  };
  builder.from.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.groupBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.offset.mockReturnValue(builder);
  builder.having.mockReturnValue(builder);
  builder.for.mockReturnValue(builder);
  return { builder, where };
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock } {
  const { builder, where } = makeChainBuilder(rows);
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  let db: Db;
  db = {
    select: jest.fn().mockReturnValue(builder),
    selectDistinctOn: jest.fn().mockReturnValue(builder),
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: Db) => Promise<unknown>) => fn(db)),
    query: {
      attendance: { findMany, findFirst },
      biometricDevices: { findMany, findFirst },
      biometricLogs: { findMany, findFirst },
      hrAttendanceRegularizations: { findMany, findFirst },
      leaveBalances: { findMany, findFirst },
      leaveRequests: { findMany, findFirst },
      leaveTypes: { findMany, findFirst },
      leavePolicies: { findMany, findFirst },
      leaveBalanceLedger: { findMany, findFirst },
      overtimeRequests: { findMany, findFirst },
      organizationMembers: { findMany, findFirst },
      orgHolidays: { findMany, findFirst },
      hrPolicies: { findMany, findFirst },
      rosters: { findMany, findFirst },
      rosterEntries: { findMany, findFirst },
      shiftTemplates: { findMany, findFirst },
      employeeShiftAssignments: { findMany, findFirst },
      shiftSwapRequests: { findMany, findFirst },
      workLogs: { findMany, findFirst },
      timesheets: { findMany, findFirst },
      leaveApprovers: { findMany, findFirst },
      users: { findMany, findFirst },
    },
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function makeAccessMock(scope = "all") {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([
      ["hr:leaves:approve", scope],
      ["hr:leaves:manage", scope],
      ["hr:attendance:manage", scope],
      ["hr:time:manage", scope],
      ["hr:worklogs:manage", scope],
    ])),
    membersWithPermission: jest.fn().mockResolvedValue([]),
  };
}

const OWNER = "org-owner";
const ATTACKER = "org-attacker";

describe("HR Time services — cross-tenant isolation", () => {
  describe("AttendanceService", () => {
    it("scopes holiday list to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const mockReader = { status: jest.fn(), history: jest.fn(), logs: jest.fn(), monthly: jest.fn() };
      const svc = new AttendanceService(db, {} as never, {} as never, {} as never, mockReader as never, {} as never);
      const result = await svc.listHolidays(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns holidays for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER, name: "New Year", date: "2026-01-01" }]);
      const mockReader = { status: jest.fn(), history: jest.fn(), logs: jest.fn(), monthly: jest.fn() };
      const svc = new AttendanceService(db, {} as never, {} as never, {} as never, mockReader as never, {} as never);
      const result = await svc.listHolidays(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("AttendanceClockService", () => {
    it("scopes org lookup to the requesting org when clocking in (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new AttendanceClockService(db, {} as never, {} as never, {} as never);
      await svc.checkIn(ATTACKER, "user-1", {}, "idem-key-1").catch(() => {});
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("uses the owning org for org lookup during clock-in (CONTROL)", async () => {
      const { db, where } = makeDb([]);
      const svc = new AttendanceClockService(db, {} as never, {} as never, {} as never);
      await svc.checkIn(OWNER, "user-1", {}, "idem-key-2").catch(() => {});
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
    });
  });

  describe("AttendancePolicyService", () => {
    it("scopes policy evaluation to the requesting org (DENY — cross-tenant isolation)", async () => {
      const mockPolicyEval = { evaluatePolicy: jest.fn().mockResolvedValue(null) };
      const svc = new AttendancePolicyService(db as never, mockPolicyEval as never);
      await svc.getAttendanceRules(ATTACKER, "user-1", "2026-01-01");
      expect(mockPolicyEval.evaluatePolicy).toHaveBeenCalledWith(ATTACKER, "user-1", "attendance", "2026-01-01");
    });

    it("scopes policy evaluation to the owning org (CONTROL)", async () => {
      const mockPolicyEval = { evaluatePolicy: jest.fn().mockResolvedValue(null) };
      const svc = new AttendancePolicyService(db as never, mockPolicyEval as never);
      await svc.getAttendanceRules(OWNER, "user-1", "2026-01-01");
      expect(mockPolicyEval.evaluatePolicy).toHaveBeenCalledWith(OWNER, "user-1", "attendance", "2026-01-01");
    });
  });

  describe("AttendanceReadService", () => {
    it("scopes attendance status to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const svc = new AttendanceReadService(db, {} as never, {} as never);
      await expect(svc.status(ATTACKER, "user-1")).rejects.toMatchObject({ status: 404 });
      expect(findMany).not.toHaveBeenCalled();
    });

    it("returns attendance status for the owning org (CONTROL)", async () => {
      const { db, findMany } = makeDb([{ id: 1, orgId: OWNER, userId: "user-1", status: "ACTIVE" }]);
      const svc = new AttendanceReadService(db, {} as never, {} as never);
      await svc.status(OWNER, "user-1");
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(OWNER);
    });
  });

  describe("AttendanceRegularizationService", () => {
    it("scopes regularizations to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const mockAccess = makeAccessMock();
      const svc = new AttendanceRegularizationService(db, {} as never, mockAccess as never, {} as never, {} as never);
      const ctx = { orgId: ATTACKER, userId: "user-1", isOrgOwner: true } as never;
      const result = await svc.list(ctx, { limit: 10 });
      expect(result.data).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns regularizations for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const mockAccess = makeAccessMock();
      const svc = new AttendanceRegularizationService(db, {} as never, mockAccess as never, {} as never, {} as never);
      const ctx = { orgId: OWNER, userId: "user-1", isOrgOwner: true } as never;
      const result = await svc.list(ctx, { limit: 10 });
      expect(result.data).toHaveLength(1);
    });
  });

  describe("BiometricService", () => {
    it("scopes biometric devices to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new BiometricService(db);
      const result = await svc.listDevices(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns biometric devices for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new BiometricService(db);
      const result = await svc.listDevices(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("CompOffGrantService", () => {
    it("scopes member verification to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const mockAccess = makeAccessMock();
      const svc = new CompOffGrantService(db, mockAccess as never, {} as never, null as never, null as never);
      const ctx = { orgId: ATTACKER, userId: "user-1", isOrgOwner: false } as never;
      await svc.grant(ctx, { userId: "emp-1", days: 1, reason: "OT" }).catch(() => {});
      const allValues = where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg));
      expect(allValues).toContain(ATTACKER);
    });

    it("uses the owning org when verifying member during grant (CONTROL)", async () => {
      const { db, where } = makeDb([{ userId: "emp-1" }]);
      const mockAccess = makeAccessMock();
      const svc = new CompOffGrantService(db, mockAccess as never, {} as never, null as never, null as never);
      const ctx = { orgId: OWNER, userId: "user-1", isOrgOwner: false } as never;
      await svc.grant(ctx, { userId: "emp-1", days: 1, reason: "OT" }).catch(() => {});
      const allValues = where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg));
      expect(allValues).toContain(OWNER);
    });
  });

  describe("GeofencingService", () => {
    it("scopes geofences to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new GeofencingService(db);
      const result = await svc.list(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns geofences for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER, isActive: true }]);
      const svc = new GeofencingService(db);
      const result = await svc.list(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("LeavePoliciesService", () => {
    it("scopes leave policies to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new LeavePoliciesService(db);
      const result = await svc.list(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns leave policies for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new LeavePoliciesService(db);
      const result = await svc.list(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("LeaveTypesService", () => {
    it("scopes leave types to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const svc = new LeaveTypesService(db);
      const result = await svc.list(ATTACKER);
      expect(result).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns leave types for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new LeaveTypesService(db);
      const result = await svc.list(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("LeavesApprovalService", () => {
    it("scopes leave approval lookup to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const mockAccess = makeAccessMock("all");
      const svc = new LeavesApprovalService(db, {} as never, mockAccess as never, {} as never, {} as never);
      const ctx = { orgId: ATTACKER, userId: "user-1", isOrgOwner: false } as never;
      await svc.updateStatus(ctx, 1, { status: "PENDING" }).catch(() => {});
      const allValues = where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg));
      expect(allValues).toContain(ATTACKER);
    });

    it("uses owning org for leave approval lookup (CONTROL)", async () => {
      const { db, where } = makeDb([]);
      const mockAccess = makeAccessMock("all");
      const svc = new LeavesApprovalService(db, {} as never, mockAccess as never, {} as never, {} as never);
      const ctx = { orgId: OWNER, userId: "user-1", isOrgOwner: false } as never;
      await svc.updateStatus(ctx, 1, { status: "PENDING" }).catch(() => {});
      const allValues = where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg));
      expect(allValues).toContain(OWNER);
    });
  });

  describe("LeavesPageService", () => {
    it("scopes leave page data to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const mockApprovals = { resolve: jest.fn().mockResolvedValue({ approver: null, queue: null }) };
      const mockEmployment = { getFacts: jest.fn().mockResolvedValue({ managerId: null }) };
      const svc = new LeavesPageService(db, mockApprovals as never, mockEmployment as never);
      await expect(svc.pageData(ATTACKER, "user-1")).rejects.toMatchObject({ status: 404 });
      expect(where).toHaveBeenCalled();
      const allValues = where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg));
      expect(allValues).toContain(ATTACKER);
    });

    it("returns leave page data for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER, userId: "user-1", status: "ACTIVE" }]);
      const mockApprovals = { resolve: jest.fn().mockResolvedValue({ approver: null, queue: null }) };
      const mockEmployment = { getFacts: jest.fn().mockResolvedValue({ managerId: null }) };
      const svc = new LeavesPageService(db, mockApprovals as never, mockEmployment as never);
      const result = await svc.pageData(OWNER, "user-1");
      expect(result).toBeDefined();
    });
  });

  describe("OvertimeService", () => {
    it("scopes overtime requests to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new OvertimeService(db, null as never, null as never);
      const result = await svc.listRequests(ATTACKER, { pageSize: 10 });
      expect(result.items).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns overtime requests for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new OvertimeService(db, null as never, null as never);
      const result = await svc.listRequests(OWNER, { pageSize: 10 });
      expect(result.items).toHaveLength(1);
    });
  });

  describe("RostersService", () => {
    it("scopes rosters to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new RostersService(db);
      const result = await svc.listRosters(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns rosters for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RostersService(db);
      const result = await svc.listRosters(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("ShiftsService", () => {
    it("scopes shifts to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new ShiftsService(db);
      const result = await svc.listShifts(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns shifts for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new ShiftsService(db);
      const result = await svc.listShifts(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("WorkLogsService", () => {
    it("scopes work logs to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([{ id: 42 }]);
      const mockAccess = makeAccessMock("all");
      const svc = new WorkLogsService(db, {} as never, mockAccess as never, {} as never);
      const ctx = {
        orgId: ATTACKER,
        userId: "user-1",
        isOrgOwner: false,
        principal: { kind: "human-session" as const, membershipId: 42, isOrgOwner: false },
      } as never;
      await svc.list(ctx, { year: 2026, quarter: 1 });
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns work logs for the owning org (CONTROL)", async () => {
      const { db, findMany } = makeDb([{ id: 1, orgId: OWNER }]);
      const mockAccess = makeAccessMock("all");
      const svc = new WorkLogsService(db, {} as never, mockAccess as never, {} as never);
      const ctx = { orgId: OWNER, userId: "user-1", isOrgOwner: true } as never;
      await svc.list(ctx, { year: 2026, quarter: 1 });
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(OWNER);
    });
  });
});

const db = {} as unknown as Db;
