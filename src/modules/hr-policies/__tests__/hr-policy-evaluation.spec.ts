import { Test, type TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { HrPolicyEvaluationService } from "../hr-policy-evaluation.service";

const mockDb = {
  query: {
    organizationMembers: { findFirst: jest.fn() },
    users: { findFirst: jest.fn() },
    hrPolicies: { findMany: jest.fn() },
  },
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
};

const SCOPE_SPEC = {
  employee: 100,
  team: 80,
  department: 70,
  role: 60,
  job_level: 50,
  location: 30,
  state: 20,
  country: 10,
  organization: 0,
};

function makePolicy(overrides: {
  id?: number;
  name?: string;
  policyType?: string;
  version?: number;
  priority?: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  scopes?: { scopeType: string; scopeValue: string }[];
  rules?: Record<string, unknown>;
  status?: string;
}) {
  return {
    id: overrides.id ?? 1,
    orgId: "org1",
    name: overrides.name ?? "Policy A",
    policyType: overrides.policyType ?? "attendance",
    version: overrides.version ?? 1,
    priority: overrides.priority ?? 10,
    status: overrides.status ?? "active",
    effectiveFrom: overrides.effectiveFrom ?? "2026-01-01",
    effectiveTo: overrides.effectiveTo ?? null,
    rules: overrides.rules ?? { graceMinutes: 15 },
    scopes: overrides.scopes ?? [{ scopeType: "organization", scopeValue: "org1" }],
    deletedAt: null,
  };
}

describe("HrPolicyEvaluationService", () => {
  let service: HrPolicyEvaluationService;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockDb.limit.mockResolvedValue([]);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ orgId: "org1", userId: "u1", role: "EMPLOYEE" });
    mockDb.query.users.findFirst.mockResolvedValue({ id: "u1", role: "EMPLOYEE", designation: null, branchId: null });
    mockDb.query.hrPolicies.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrPolicyEvaluationService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(HrPolicyEvaluationService);
  });

  describe("evaluatePolicy — no candidates", () => {
    it("returns null when there are no active policies", async () => {
      mockDb.select.mockReturnThis();
      mockDb.from.mockReturnThis();
      mockDb.innerJoin.mockReturnThis();
      mockDb.where.mockReturnThis();
      mockDb.limit.mockResolvedValue([]);

      mockDb.query.hrPolicies.findMany.mockResolvedValue([]);
      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result).toBeNull();
    });
  });

  describe("evaluatePolicy — scope specificity ordering", () => {
    it("prefers employee scope (100) over department scope (70)", async () => {
      mockDb.select.mockReturnThis();
      mockDb.from.mockReturnThis();
      mockDb.innerJoin.mockReturnThis();
      mockDb.where.mockReturnThis();
      mockDb.limit.mockResolvedValue([]);

      mockDb.query.users.findFirst.mockResolvedValue({ id: "u1", role: "EMPLOYEE", designation: null, branchId: null });
      mockDb.query.organizationMembers.findFirst.mockResolvedValue({ orgId: "org1", userId: "u1" });

      const deptPolicy = makePolicy({ id: 1, name: "Dept Policy", priority: 100, scopes: [{ scopeType: "department", scopeValue: "10" }], rules: { graceMinutes: 10 } });
      const empPolicy = makePolicy({ id: 2, name: "Employee Policy", priority: 1, scopes: [{ scopeType: "employee", scopeValue: "u1" }], rules: { graceMinutes: 30 } });

      mockDb.query.hrPolicies.findMany.mockResolvedValue([deptPolicy, empPolicy]);

      const _attrs = {
        userId: "u1",
        departmentId: 10,
        teamIds: [],
        role: "EMPLOYEE",
        designation: null,
        employmentType: null,
        locationId: null,
        countryCode: null,
        stateCode: null,
        jobLevel: null,
      };

      const mockFindFirst = jest.fn().mockResolvedValue({ orgId: "org1", userId: "u1" });
      const mockSelect = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ departmentId: 10 }]),
          }),
        }),
      });

      (service as unknown as { db: typeof mockDb }).db.select = mockSelect;
      (service as unknown as { db: typeof mockDb }).db.query.organizationMembers.findFirst = mockFindFirst;
      (service as unknown as { db: typeof mockDb }).db.query.users.findFirst = jest.fn().mockResolvedValue({ id: "u1", role: "EMPLOYEE", designation: null, branchId: null });
      (service as unknown as { db: typeof mockDb }).db.query.hrPolicies.findMany = jest.fn().mockResolvedValue([deptPolicy, empPolicy]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");

      expect(result?.policy.name).toBe("Employee Policy");
      expect(result?.trace.maxSpecificity).toBe(SCOPE_SPEC.employee);
    });

    it("prefers department scope (70) over role scope (60)", async () => {
      const mockFindFirst = jest.fn().mockResolvedValue({ orgId: "org1", userId: "u1" });
      const mockSelect = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ departmentId: 5 }]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ departmentId: 5 }]),
          }),
        }),
      });

      (service as unknown as { db: typeof mockDb }).db.select = mockSelect;
      (service as unknown as { db: typeof mockDb }).db.query.organizationMembers.findFirst = mockFindFirst;
      (service as unknown as { db: typeof mockDb }).db.query.users.findFirst = jest.fn().mockResolvedValue({ id: "u1", role: "MANAGER", designation: null, branchId: null });

      const rolePolicy = makePolicy({ id: 1, name: "Role Policy", priority: 100, scopes: [{ scopeType: "role", scopeValue: "MANAGER" }], rules: { graceMinutes: 5 } });
      const deptPolicy = makePolicy({ id: 2, name: "Dept Policy", priority: 1, scopes: [{ scopeType: "department", scopeValue: "5" }], rules: { graceMinutes: 20 } });

      (service as unknown as { db: typeof mockDb }).db.query.hrPolicies.findMany = jest.fn().mockResolvedValue([rolePolicy, deptPolicy]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("Dept Policy");
      expect(result?.trace.maxSpecificity).toBe(SCOPE_SPEC.department);
    });

    it("prefers role scope (60) over organization scope (0) when employee has matching role", async () => {
      const mockFindFirst = jest.fn().mockResolvedValue({ orgId: "org1", userId: "u1" });
      const mockSelect = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      (service as unknown as { db: typeof mockDb }).db.select = mockSelect;
      (service as unknown as { db: typeof mockDb }).db.query.organizationMembers.findFirst = mockFindFirst;
      (service as unknown as { db: typeof mockDb }).db.query.users.findFirst = jest.fn().mockResolvedValue({ id: "u1", role: "HR", designation: null, branchId: null });

      const orgPolicy = makePolicy({ id: 1, name: "Org Policy", priority: 100, scopes: [{ scopeType: "organization", scopeValue: "org1" }], rules: { graceMinutes: 5 } });
      const rolePolicy = makePolicy({ id: 2, name: "HR Policy", priority: 1, scopes: [{ scopeType: "role", scopeValue: "HR" }], rules: { graceMinutes: 25 } });

      (service as unknown as { db: typeof mockDb }).db.query.hrPolicies.findMany = jest.fn().mockResolvedValue([orgPolicy, rolePolicy]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("HR Policy");
      expect(result?.trace.maxSpecificity).toBe(SCOPE_SPEC.role);
    });

    it("falls back to organization scope (0) when no specific scope matches", async () => {
      const mockFindFirst = jest.fn().mockResolvedValue({ orgId: "org1", userId: "u1" });
      const mockSelect = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      (service as unknown as { db: typeof mockDb }).db.select = mockSelect;
      (service as unknown as { db: typeof mockDb }).db.query.organizationMembers.findFirst = mockFindFirst;
      (service as unknown as { db: typeof mockDb }).db.query.users.findFirst = jest.fn().mockResolvedValue({ id: "u1", role: "EMPLOYEE", designation: null, branchId: null });

      const orgPolicy = makePolicy({ id: 1, name: "Org Policy", priority: 5, scopes: [{ scopeType: "organization", scopeValue: "org1" }], rules: { graceMinutes: 15 } });

      (service as unknown as { db: typeof mockDb }).db.query.hrPolicies.findMany = jest.fn().mockResolvedValue([orgPolicy]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("Org Policy");
      expect(result?.trace.maxSpecificity).toBe(SCOPE_SPEC.organization);
    });
  });

  describe("evaluatePolicy — tie-breaking", () => {
    it("breaks ties on same specificity by priority (higher wins)", async () => {
      const mockFindFirst = jest.fn().mockResolvedValue({ orgId: "org1", userId: "u1" });
      const mockSelect = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      (service as unknown as { db: typeof mockDb }).db.select = mockSelect;
      (service as unknown as { db: typeof mockDb }).db.query.organizationMembers.findFirst = mockFindFirst;
      (service as unknown as { db: typeof mockDb }).db.query.users.findFirst = jest.fn().mockResolvedValue({ id: "u1", role: "EMPLOYEE", designation: null, branchId: null });

      const lowPriority = makePolicy({ id: 1, name: "Low Priority", priority: 1, scopes: [{ scopeType: "organization", scopeValue: "org1" }], rules: { graceMinutes: 5 } });
      const highPriority = makePolicy({ id: 2, name: "High Priority", priority: 99, scopes: [{ scopeType: "organization", scopeValue: "org1" }], rules: { graceMinutes: 30 } });

      (service as unknown as { db: typeof mockDb }).db.query.hrPolicies.findMany = jest.fn().mockResolvedValue([lowPriority, highPriority]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("High Priority");
    });

    it("breaks ties on same specificity and same priority by version (higher wins)", async () => {
      const mockFindFirst = jest.fn().mockResolvedValue({ orgId: "org1", userId: "u1" });
      const mockSelect = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      (service as unknown as { db: typeof mockDb }).db.select = mockSelect;
      (service as unknown as { db: typeof mockDb }).db.query.organizationMembers.findFirst = mockFindFirst;
      (service as unknown as { db: typeof mockDb }).db.query.users.findFirst = jest.fn().mockResolvedValue({ id: "u1", role: "EMPLOYEE", designation: null, branchId: null });

      const v1 = makePolicy({ id: 1, name: "Version 1", version: 1, priority: 10, scopes: [{ scopeType: "organization", scopeValue: "org1" }] });
      const v3 = makePolicy({ id: 2, name: "Version 3", version: 3, priority: 10, scopes: [{ scopeType: "organization", scopeValue: "org1" }] });

      (service as unknown as { db: typeof mockDb }).db.query.hrPolicies.findMany = jest.fn().mockResolvedValue([v1, v3]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("Version 3");
    });
  });

  describe("evaluatePolicy — employee not found", () => {
    it("throws NotFoundException when employee is not in the org", async () => {
      (service as unknown as { db: typeof mockDb }).db.query.organizationMembers.findFirst = jest.fn().mockResolvedValue(undefined);
      await expect(service.evaluatePolicy("org1", "ghost", "attendance", "2026-07-11")).rejects.toThrow(NotFoundException);
    });
  });
});
