import { Test, type TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { HrPolicyEvaluationService } from "../hr-policy-evaluation.service";
import { EmploymentFactsService } from "../../../directory/employment-facts.service";
import { emptyEmploymentFacts } from "../../../directory/employment-facts.types";

const employmentFacts = {
  getFacts: jest.fn(),
  getFactsBatch: jest.fn(),
};

type Rows = Record<string, unknown>[];

/** `resolveEmployeeAttributes` fires three selects in order: departments, teams, role slugs. */
function makeSelectMock(sequence: Rows[]) {
  let call = 0;
  return jest.fn().mockImplementation(() => {
    const rows = sequence[call] ?? [];
    call += 1;
    const chain: Record<string, unknown> = {};
    const link = () => chain;
    chain.from = jest.fn(link);
    chain.innerJoin = jest.fn(link);
    chain.leftJoin = jest.fn(link);
    chain.where = jest.fn(link);
    chain.limit = jest.fn().mockResolvedValue(rows);
    chain.then = (resolve: (value: Rows) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  });
}

const mockDb = {
  query: {
    organizationMembers: { findFirst: jest.fn() },
    users: { findFirst: jest.fn() },
    hrPolicies: { findMany: jest.fn() },
  },
  select: makeSelectMock([]),
};

function setAttributes(options: { departments?: Rows; teams?: Rows; roles?: Rows }) {
  mockDb.select = makeSelectMock([
    options.departments ?? [],
    options.teams ?? [],
    options.roles ?? [],
  ]);
}

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

    setAttributes({});
    employmentFacts.getFacts.mockImplementation((_orgId: string, userId: string) =>
      Promise.resolve(emptyEmploymentFacts(userId)),
    );
    employmentFacts.getFactsBatch.mockResolvedValue(new Map());
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ orgId: "org1", userId: "u1" });
    mockDb.query.hrPolicies.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrPolicyEvaluationService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: EmploymentFactsService, useValue: employmentFacts },
      ],
    }).compile();

    service = module.get(HrPolicyEvaluationService);
  });

  describe("evaluatePolicy — no candidates", () => {
    it("returns null when there are no active policies", async () => {
      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result).toBeNull();
    });
  });

  describe("evaluatePolicy — scope specificity ordering", () => {
    it("prefers employee scope (100) over department scope (70)", async () => {
      setAttributes({ departments: [{ orgUnitId: "dept-10" }] });

      const deptPolicy = makePolicy({
        id: 1,
        name: "Dept Policy",
        priority: 100,
        scopes: [{ scopeType: "department", scopeValue: "dept-10" }],
        rules: { graceMinutes: 10 },
      });
      const empPolicy = makePolicy({
        id: 2,
        name: "Employee Policy",
        priority: 1,
        scopes: [{ scopeType: "employee", scopeValue: "u1" }],
        rules: { graceMinutes: 30 },
      });
      mockDb.query.hrPolicies.findMany.mockResolvedValue([deptPolicy, empPolicy]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");

      expect(result?.policy.name).toBe("Employee Policy");
      expect(result?.trace.maxSpecificity).toBe(SCOPE_SPEC.employee);
    });

    it("prefers department scope (70) over role scope (60)", async () => {
      setAttributes({ departments: [{ orgUnitId: "dept-5" }], roles: [{ slug: "MANAGER" }] });

      const rolePolicy = makePolicy({
        id: 1,
        name: "Role Policy",
        priority: 100,
        scopes: [{ scopeType: "role", scopeValue: "MANAGER" }],
        rules: { graceMinutes: 5 },
      });
      const deptPolicy = makePolicy({
        id: 2,
        name: "Dept Policy",
        priority: 1,
        scopes: [{ scopeType: "department", scopeValue: "dept-5" }],
        rules: { graceMinutes: 20 },
      });
      mockDb.query.hrPolicies.findMany.mockResolvedValue([rolePolicy, deptPolicy]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("Dept Policy");
      expect(result?.trace.maxSpecificity).toBe(SCOPE_SPEC.department);
    });

    it("prefers team scope (80) over department scope (70)", async () => {
      setAttributes({ departments: [{ orgUnitId: "dept-5" }], teams: [{ orgUnitId: "team-9" }] });

      const deptPolicy = makePolicy({
        id: 1,
        name: "Dept Policy",
        priority: 100,
        scopes: [{ scopeType: "department", scopeValue: "dept-5" }],
        rules: { graceMinutes: 20 },
      });
      const teamPolicy = makePolicy({
        id: 2,
        name: "Team Policy",
        priority: 1,
        scopes: [{ scopeType: "team", scopeValue: "team-9" }],
        rules: { graceMinutes: 45 },
      });
      mockDb.query.hrPolicies.findMany.mockResolvedValue([deptPolicy, teamPolicy]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("Team Policy");
      expect(result?.trace.maxSpecificity).toBe(SCOPE_SPEC.team);
    });

    it("prefers role scope (60) over organization scope (0) when employee has matching role", async () => {
      setAttributes({ roles: [{ slug: "HR_ADMIN" }] });

      const orgPolicy = makePolicy({
        id: 1,
        name: "Org Policy",
        priority: 100,
        scopes: [{ scopeType: "organization", scopeValue: "org1" }],
        rules: { graceMinutes: 5 },
      });
      const rolePolicy = makePolicy({
        id: 2,
        name: "HR Policy",
        priority: 1,
        scopes: [{ scopeType: "role", scopeValue: "HR_ADMIN" }],
        rules: { graceMinutes: 25 },
      });
      mockDb.query.hrPolicies.findMany.mockResolvedValue([orgPolicy, rolePolicy]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("HR Policy");
      expect(result?.trace.maxSpecificity).toBe(SCOPE_SPEC.role);
    });

    it("falls back to organization scope (0) when no specific scope matches", async () => {
      const orgPolicy = makePolicy({
        id: 1,
        name: "Org Policy",
        priority: 5,
        scopes: [{ scopeType: "organization", scopeValue: "org1" }],
        rules: { graceMinutes: 15 },
      });
      mockDb.query.hrPolicies.findMany.mockResolvedValue([orgPolicy]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("Org Policy");
      expect(result?.trace.maxSpecificity).toBe(SCOPE_SPEC.organization);
    });

    it("ignores a role-scoped policy when the employee holds no such role", async () => {
      const rolePolicy = makePolicy({
        id: 1,
        name: "Role Policy",
        priority: 100,
        scopes: [{ scopeType: "role", scopeValue: "MANAGER" }],
      });
      mockDb.query.hrPolicies.findMany.mockResolvedValue([rolePolicy]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result).toBeNull();
    });
  });

  describe("evaluatePolicy — tie-breaking", () => {
    it("breaks ties on same specificity by priority (higher wins)", async () => {
      const lowPriority = makePolicy({
        id: 1,
        name: "Low Priority",
        priority: 1,
        scopes: [{ scopeType: "organization", scopeValue: "org1" }],
        rules: { graceMinutes: 5 },
      });
      const highPriority = makePolicy({
        id: 2,
        name: "High Priority",
        priority: 99,
        scopes: [{ scopeType: "organization", scopeValue: "org1" }],
        rules: { graceMinutes: 30 },
      });
      mockDb.query.hrPolicies.findMany.mockResolvedValue([lowPriority, highPriority]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("High Priority");
    });

    it("breaks ties on same specificity and same priority by version (higher wins)", async () => {
      const v1 = makePolicy({
        id: 1,
        name: "Version 1",
        version: 1,
        priority: 10,
        scopes: [{ scopeType: "organization", scopeValue: "org1" }],
      });
      const v3 = makePolicy({
        id: 2,
        name: "Version 3",
        version: 3,
        priority: 10,
        scopes: [{ scopeType: "organization", scopeValue: "org1" }],
      });
      mockDb.query.hrPolicies.findMany.mockResolvedValue([v1, v3]);

      const result = await service.evaluatePolicy("org1", "u1", "attendance", "2026-07-11");
      expect(result?.policy.name).toBe("Version 3");
    });
  });

  describe("evaluatePolicy — employee not found", () => {
    it("throws NotFoundException when employee is not in the org", async () => {
      mockDb.query.organizationMembers.findFirst.mockResolvedValue(undefined);
      await expect(
        service.evaluatePolicy("org1", "ghost", "attendance", "2026-07-11"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("evaluatePolicies", () => {
    it("loads all employee attributes in three bounded queries", async () => {
      mockDb.select = makeSelectMock([
        [
          { userId: "u1", designation: "Engineer", locationId: null },
          { userId: "u2", designation: "Manager", locationId: null },
        ],
        [
          { userId: "u1", orgUnitId: "dept-1", kind: "DEPARTMENT" },
          { userId: "u2", orgUnitId: "team-1", kind: "TEAM" },
        ],
        [{ userId: "u2", slug: "MANAGER" }],
      ]);
      mockDb.query.hrPolicies.findMany.mockResolvedValue([
        makePolicy({
          name: "Organization attendance",
          scopes: [{ scopeType: "organization", scopeValue: "org1" }],
        }),
      ]);

      const result = await service.evaluatePolicies(
        "org1",
        ["u1", "u2"],
        "attendance",
        "2026-07-11",
      );

      expect(mockDb.select).toHaveBeenCalledTimes(3);
      expect(mockDb.query.hrPolicies.findMany).toHaveBeenCalledTimes(1);
      expect(result.get("u1")?.policy.name).toBe("Organization attendance");
      expect(result.get("u2")?.policy.name).toBe("Organization attendance");
    });
  });
});
