import type { INestApplication } from "@nestjs/common";
import { ConflictException, NotFoundException } from "@nestjs/common";
import request from "supertest";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { createE2eApp } from "test/helpers/e2e-app";
import { AccessService } from "../../access/access.service";
import { EntitlementsService } from "../../access/entitlements.service";
import { PayrollTemplatesService, seedPayrollTemplates } from "./templates.service";
import { PolicyQueryService } from "./policy-query.service";
import { PolicyMutationService } from "./policy-mutation.service";
import { PayrollComponentsService } from "./components.service";
import { withAccessResolution } from "../../../../test/helpers/access-stub";

const ALL_PAYROLL_SETUP_PERMS = new Map([
  ["payroll:templates:view", "all"],
  ["payroll:templates:manage", "all"],
  ["payroll:policies:view", "all"],
  ["payroll:policies:manage", "all"],
  ["payroll:components:view", "all"],
  ["payroll:components:manage", "all"],
]);

const permittedAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(ALL_PAYROLL_SETUP_PERMS),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const forbiddenAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const mockTemplate = {
  id: 1,
  orgId: null,
  key: "INDIAN_STANDARD",
  name: "Indian Standard",
  description: "Standard Indian payroll template",
  bestFor: "Small businesses",
  complexity: "SIMPLE",
  badge: null,
  category: "INDIAN_STANDARD" as const,
  defaultToggles: {},
  defaultComponents: [],
  isSystem: true,
  isRecommended: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const mockPolicy = {
  id: 1,
  orgId: "org_1",
  status: "DRAFT" as const,
  country: "IN",
  state: null,
  legalEntityName: null,
  currency: "INR",
  payFrequency: "MONTHLY" as const,
  payDay: 1,
  employeeCount: null,
  startMonth: "2026-01",
  activeVersionId: null,
  createdBy: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const mockComponent = {
  id: 1,
  orgId: "org_1",
  code: "BASIC",
  name: "Basic",
  type: "EARNING" as const,
  calcMethod: "FIXED" as const,
  amount: "0.00",
  percent: null,
  formula: null,
  taxable: true,
  showOnPayslip: true,
  includeInCtc: true,
  isStatutory: false,
  statutoryKey: null,
  sortOrder: 1,
  isActive: true,
  effectiveFrom: null,
  effectiveTo: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const mockToggles = {
  pf: false,
  esi: false,
  professionalTax: false,
  tds: false,
  gratuity: false,
  lwf: false,
  lopFromAttendance: false,
  overtime: false,
  timesheets: false,
  leaveSync: false,
  expenseSync: false,
  salesIncentives: false,
  manualAdjustments: false,
  reimbursements: false,
  bonuses: false,
  incentives: false,
  loans: false,
  contractorPayments: false,
  multiCurrency: false,
  employeeDeclarations: false,
  payrollVarianceWarnings: false,
  requireLockedPayrollInputs: false,
  countryComplianceChecklist: false,
  globalPaymentReport: false,
  bankPayoutFile: false,
  payslipPublishing: false,
  emailPayslips: false,
  approvalWorkflow: false,
  managerApproval: false,
  financeApproval: false,
  lockAfterApproval: false,
  essShowSalaryStructure: false,
  essAllowBankUpdate: false,
  essAllowLoanRequests: false,
  essAllowTaxDeclarations: false,
  essAllowReimbursements: false,
};
const mockTemplatePreview = {
  template: { id: 1, key: "INDIAN_STANDARD", name: "Indian Standard" },
  effectiveToggles: mockToggles,
  annualCtc: 1200000,
  monthlyCtc: 100000,
  components: [],
  totals: {
    grossEarnings: "100000.00",
    totalDeductions: "0.00",
    employerContributions: "0.00",
    netTakeHome: "100000.00",
  },
};
const mockPolicyPreview = {
  toggles: mockToggles,
  components: [],
  approvalChain: [],
  calendarPlan: [],
  essOptions: {
    showSalaryStructure: false,
    allowBankUpdate: false,
    allowLoanRequests: false,
    allowTaxDeclarations: false,
    allowReimbursements: false,
  },
  statutoryPack: {
    country: "IN",
    countryName: "India",
    currency: "INR",
    taxRegimeApplicable: true,
    items: [],
    complianceChecklist: [],
  },
};

const mockTemplatesService = {
  list: jest.fn().mockResolvedValue({ items: [mockTemplate], pagination: { limit: 25, hasMore: false, nextCursor: null } }),
  getById: jest.fn().mockResolvedValue(mockTemplate),
  preview: jest.fn().mockResolvedValue(mockTemplatePreview),
  duplicate: jest.fn().mockResolvedValue({ ...mockTemplate, id: 2, name: "Copy" }),
  deleteCustomTemplate: jest.fn().mockResolvedValue({ success: true }),
};

const mockPolicyQueryService = {
  getCurrent: jest.fn().mockResolvedValue({ policy: mockPolicy }),
  toggleImpact: jest.fn().mockResolvedValue({ toggle: "pf", affectedEmployeeCount: 0, affectedStatutoryCodes: [] }),
  preview: jest.fn().mockResolvedValue(mockPolicyPreview),
  listVersions: jest.fn().mockResolvedValue([]),
};

const mockPolicyMutationService = {
  create: jest.fn().mockResolvedValue(mockPolicy),
  update: jest.fn().mockResolvedValue(mockPolicy),
  activate: jest.fn().mockResolvedValue({ componentCount: 0, checklist: [] }),
  createVersion: jest.fn().mockResolvedValue({ versionId: 2 }),
};

const mockComponentsService = {
  list: jest.fn().mockResolvedValue({ items: [mockComponent], pagination: { limit: 25, hasMore: false, nextCursor: null } }),
  create: jest.fn().mockResolvedValue(mockComponent),
  update: jest.fn().mockResolvedValue(mockComponent),
  remove: jest.fn().mockResolvedValue({ ok: true }),
};

const alwaysOnEntitlements = {
  isModuleEnabled: async (): Promise<boolean> => true,
  getModuleMap: async (): Promise<Record<string, boolean>> => ({}),
  getEffectiveModuleMap: async (): Promise<Record<string, boolean>> => ({}),
};

type Method = "get" | "post" | "patch" | "delete";
const protectedRoutes: ReadonlyArray<[Method, string]> = [
  ["get", "/payroll/templates"],
  ["get", "/payroll/templates/1"],
  ["post", "/payroll/templates/1/duplicate"],
  ["post", "/payroll/templates/1/preview"],
  ["delete", "/payroll/templates/1"],
  ["get", "/payroll/policies/current"],
  ["get", "/payroll/policies/toggle-impact"],
  ["post", "/payroll/policies"],
  ["post", "/payroll/policies/preview"],
  ["patch", "/payroll/policies/1"],
  ["post", "/payroll/policies/1/activate"],
  ["get", "/payroll/policies/1/versions"],
  ["post", "/payroll/policies/1/versions"],
  ["get", "/payroll/components"],
  ["post", "/payroll/components"],
  ["patch", "/payroll/components/1"],
  ["delete", "/payroll/components/1"],
];

async function buildApp(accessMock: typeof permittedAccess): Promise<INestApplication> {
  return createE2eApp({
    overrides: [
      { provide: AccessService, useValue: accessMock },
      { provide: EntitlementsService, useValue: alwaysOnEntitlements },
      { provide: PayrollTemplatesService, useValue: mockTemplatesService },
      { provide: PolicyQueryService, useValue: mockPolicyQueryService },
      { provide: PolicyMutationService, useValue: mockPolicyMutationService },
      { provide: PayrollComponentsService, useValue: mockComponentsService },
    ],
  });
}

describe("payroll-setup auth/RBAC — 401 (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it.each(protectedRoutes)("401 on %s %s without token", async (method, path) => {
    const res = await request(app.getHttpServer())[method](path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});

describe("payroll-setup RBAC — 403 when no permissions (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(forbiddenAccess); });
  afterAll(async () => app.close());

  const rbacRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/payroll/templates"],
    ["get", "/payroll/templates/1"],
    ["post", "/payroll/templates/1/duplicate"],
    ["post", "/payroll/templates/1/preview"],
    ["delete", "/payroll/templates/1"],
    ["get", "/payroll/policies/current"],
    ["post", "/payroll/policies"],
    ["post", "/payroll/policies/preview"],
    ["patch", "/payroll/policies/1"],
    ["post", "/payroll/policies/1/activate"],
    ["get", "/payroll/policies/1/versions"],
    ["post", "/payroll/policies/1/versions"],
    ["get", "/payroll/components"],
    ["post", "/payroll/components"],
    ["patch", "/payroll/components/1"],
    ["delete", "/payroll/components/1"],
  ];

  it.each(rbacRoutes)("403 on %s %s with empty permission map", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())[method](path)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});

describe("payroll-setup RBAC — 200 view routes with view permission (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/templates → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/templates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/templates/1 → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/templates/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("POST /payroll/templates/1/preview → 201 with valid body", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/templates/1/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({ annualCtc: 1200000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ components: expect.any(Array), totals: expect.any(Object) });
  });

  it("GET /payroll/policies/current → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/policies/current")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/policies/toggle-impact → 200 with valid toggle param", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/policies/toggle-impact?toggle=pf")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/components → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/components")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("POST /payroll/templates/1/duplicate → 200 with valid body", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/templates/1/duplicate")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "My Template Copy" });
    expect(res.status).toBe(201);
  });

  it("POST /payroll/policies → 200 with valid body", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/policies")
      .set("Authorization", `Bearer ${token}`)
      .send({ startMonth: "2026-01" });
    expect(res.status).toBe(201);
  });
});

describe("payroll-setup RBAC — view-only caller blocked from manage routes (e2e)", () => {
  let app: INestApplication;

  const viewOnlyAccess = withAccessResolution({
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([
      ["payroll:templates:view", "all"],
      ["payroll:policies:view", "all"],
      ["payroll:components:view", "all"],
    ])),
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
  });

  beforeAll(async () => { app = await buildApp(viewOnlyAccess); });
  afterAll(async () => app.close());

  it("POST /payroll/templates/1/duplicate → 403 for view-only caller", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/templates/1/duplicate")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Copy" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("POST /payroll/policies/1/activate → 403 for view-only caller", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/policies/1/activate")
      .set("Authorization", `Bearer ${token}`)
      .send({ templateKey: "INDIAN_STANDARD" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("POST /payroll/components → 403 for view-only caller", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/components")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "BONUS", name: "Bonus", type: "EARNING", calcMethod: "FIXED" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("DELETE /payroll/components/1 → 403 for view-only caller", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .delete("/payroll/components/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("DELETE /payroll/templates/1 → 403 for view-only caller", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .delete("/payroll/templates/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});

describe("payroll-setup — template delete (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("DELETE /payroll/templates/1 → 204 success for custom template", async () => {
    mockTemplatesService.deleteCustomTemplate.mockResolvedValueOnce({ success: true });
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/payroll/templates/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
  });

  it("DELETE /payroll/templates/1 → 409 when service rejects system template", async () => {
    mockTemplatesService.deleteCustomTemplate.mockRejectedValueOnce(new ConflictException("Cannot delete system templates"));
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/payroll/templates/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  it("DELETE /payroll/templates/99 → 404 when template not found", async () => {
    mockTemplatesService.deleteCustomTemplate.mockRejectedValueOnce(new NotFoundException("Custom template not found"));
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/payroll/templates/99")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("payroll-setup — complexity filter (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/templates?complexity=SIMPLE → 200 passes complexity to service", async () => {
    mockTemplatesService.list.mockResolvedValueOnce({ items: [], pagination: { limit: 25, hasMore: false, nextCursor: null } });
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/templates?complexity=SIMPLE")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(mockTemplatesService.list).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ complexity: "SIMPLE" }),
    );
  });

  it("GET /payroll/templates?complexity=INVALID → 400 for invalid complexity", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/templates?complexity=INVALID")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("payroll-setup — seedPayrollTemplates idempotency (unit)", () => {
  /**
   * `seedPayrollTemplates` reads the already-seeded keys in ONE org-scoped
   * query and writes the missing ones in ONE bulk insert. The store below is
   * stateful on purpose: the second call reads back exactly what the first one
   * wrote, so idempotency has to come from the seeder. Hand-feeding
   * "row exists" on the second call would assert the mock instead.
   */
  function seedStore() {
    const seededKeys = new Set<string>();
    const insertedBatchSizes: number[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([...seededKeys].map((key) => ({ key }))),
        }),
      }),
      insert: () => ({
        values: (rows: Array<{ key: string }>) => {
          insertedBatchSizes.push(rows.length);
          for (const row of rows) seededKeys.add(row.key);
          return Promise.resolve();
        },
      }),
    };
    return {
      seededKeys,
      insertedBatchSizes,
      db: db as unknown as Parameters<typeof seedPayrollTemplates>[0],
    };
  }

  it("calling seedPayrollTemplates twice returns seeded=0 the second time", async () => {
    const store = seedStore();

    const first = await seedPayrollTemplates(store.db);
    expect(first.seeded).toBeGreaterThan(0);
    expect(first.skipped).toBe(0);
    expect(store.seededKeys.size).toBe(first.seeded);

    const second = await seedPayrollTemplates(store.db);
    expect(second.seeded).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(store.seededKeys.size).toBe(first.seeded);
  });

  it("writes every missing seed in a single insert, not one per seed", async () => {
    const store = seedStore();

    const first = await seedPayrollTemplates(store.db);

    // One bulk insert. A per-seed loop here is the N+1 that 0edfcf713 removed.
    expect(store.insertedBatchSizes).toEqual([first.seeded]);

    const second = await seedPayrollTemplates(store.db);
    expect(second.seeded).toBe(0);
    expect(store.insertedBatchSizes).toEqual([first.seeded]);
  });
});
