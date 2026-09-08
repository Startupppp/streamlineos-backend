import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { createE2eApp } from "test/helpers/e2e-app";
import { AccessService } from "../../access/access.service";
import { EntitlementsService } from "../../access/entitlements.service";
import { RunsService } from "./runs.service";
import { GenerateService } from "./generate.service";
import { ExceptionsService } from "./exceptions.service";
import { InputsService } from "./inputs.service";
import { CommandCenterService } from "./command-center.service";
import { LoanAdjustmentsService } from "./loan-adjustments.service";
import { ProfilesService } from "./profiles.service";
import { GeneratePipelineService } from "./generate-pipeline.service";
import { PayrollCommandReceiptsService } from "../command-receipts.service";
import { withAccessResolution } from "../../../../test/helpers/access-stub";

const mockCommandReceiptsService = {
  begin: jest.fn().mockResolvedValue({ kind: "fresh" as const, receiptId: 1, correlationId: "corr_1" }),
  succeed: jest.fn().mockResolvedValue(undefined),
  fail: jest.fn().mockResolvedValue(undefined),
  hashRequest: jest.fn().mockReturnValue("hash"),
};

const ALL_RUNS_PERMS = new Map([
  ["payroll:runs:view", "all"],
  ["payroll:runs:create", "all"],
  ["payroll:runs:update", "all"],
  ["payroll:runs:manage", "all"],
  ["payroll:salaries:view", "all"],
  ["payroll:salaries:update", "all"],
]);

const permittedAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(ALL_RUNS_PERMS),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const forbiddenAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const viewOnlyAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map([
    ["payroll:runs:view", "all"],
    ["payroll:salaries:view", "all"],
  ])),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const mockRunListItem = {
  id: 1,
  month: "2026-07",
  status: "DRAFT",
  runType: "REGULAR",
  entityId: null,
  statutoryRuleVersion: null,
  grossTotal: "0.00",
  netTotal: "0.00",
  employeeCount: 0,
  exceptionCount: 0,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
};

const mockRunDetail = {
  id: 1,
  orgId: "org_1",
  policyVersionId: null,
  month: "2026-07",
  runType: "REGULAR",
  sourcePeriodKey: null,
  sourceRunId: null,
  entityId: null,
  periodId: null,
  calculationVersion: null,
  statutoryRuleVersion: null,
  inputSnapshotHash: null,
  status: "DRAFT" as const,
  payDate: null,
  grossTotal: "0.00",
  deductionTotal: "0.00",
  employerCostTotal: "0.00",
  netTotal: "0.00",
  employeeCount: 0,
  exceptionCount: 0,
  lockedAt: null,
  lockedBy: null,
  lockedByMembershipId: null,
  approvedAt: null,
  approvedByMembershipId: null,
  paidAt: null,
  paidBy: null,
  paidByMembershipId: null,
  publishedAt: null,
  publishedBy: null,
  publishedByMembershipId: null,
  closedAt: null,
  closedBy: null,
  closedByMembershipId: null,
  reopenedAt: null,
  reopenedBy: null,
  reopenedByMembershipId: null,
  reopenReason: null,
  postingState: "pending" as const,
  generationLockToken: null,
  generationLockedAt: null,
  createdBy: null,
  createdByMembershipId: null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
};

const mockRunEmployee = {
  id: 1,
  userId: "u1",
  workerType: "EMPLOYEE",
  currency: "INR",
  gross: "0.00",
  totalDeductions: "0.00",
  net: "0.00",
  status: "PENDING",
  holdReason: null,
  userName: "Test User",
  userEmail: "test@example.com",
};

const mockRunsService = {
  createRun: jest.fn().mockResolvedValue({ ok: true, runId: 1 }),
  listRuns: jest.fn().mockResolvedValue({
    data: [mockRunListItem],
    pagination: { limit: 20, hasMore: false, nextCursor: null },
  }),
  getRunById: jest.fn().mockResolvedValue({
    run: mockRunDetail,
    checklist: [],
    varianceSummary: null,
    payoutHealth: null,
  }),
  listRunEmployees: jest.fn().mockResolvedValue({
    data: [mockRunEmployee],
    pagination: { limit: 20, hasMore: false, nextCursor: null },
  }),
  getRunEmployee: jest.fn().mockResolvedValue({
    id: 1,
    userId: "u1",
    workerType: "EMPLOYEE",
    currency: "INR",
    gross: "0.00",
    totalDeductions: "0.00",
    net: "0.00",
    status: "PENDING",
    holdReason: null,
    calculationSnapshot: null,
    userName: "Test User",
    userEmail: "test@example.com",
  }),
  getVariance: jest.fn().mockResolvedValue({
    currentRun: { id: 1, month: "2026-07", grossTotal: "0.00", netTotal: "0.00" },
    previousRun: null,
    topMovers: [],
    lockedInputBaselinesUsed: false,
  }),
};

const mockGenerateService = {
  generateRun: jest.fn().mockResolvedValue({ ok: true }),
};

const mockGeneratePipelineService = {
  runCalcAndDetect: jest.fn().mockResolvedValue({ ok: true }),
};

const mockException = {
  id: 1,
  code: "MISSING_ATTENDANCE",
  severity: "BLOCKER" as const,
  status: "OPEN" as const,
  message: "Attendance not imported",
  metadata: null,
  userId: "u1",
  resolvedBy: null,
  resolvedAt: null,
  overrideReason: null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  userName: "Test User",
  userEmail: "test@example.com",
};

const mockExceptionsService = {
  listExceptions: jest.fn().mockResolvedValue({
    data: [mockException],
    pagination: { limit: 20, hasMore: false, nextCursor: null },
  }),
  resolveException: jest.fn().mockResolvedValue({ ok: true }),
  overrideException: jest.fn().mockResolvedValue({ ok: true }),
};

const mockInputsService = {
  listInputs: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  patchInput: jest.fn().mockResolvedValue({ ok: true }),
  reimportInputs: jest.fn().mockResolvedValue({ ok: true, count: 0 }),
};

const mockCommandCenterService = {
  getCommandCenter: jest.fn().mockResolvedValue({
    header: {
      runId: 1,
      month: "2026-07",
      status: "DRAFT",
      grossTotal: "0.00",
      deductionTotal: "0.00",
      netTotal: "0.00",
      employerCostTotal: "0.00",
      employeeCount: 0,
      exceptionCounts: { BLOCKER: 0, WARNING: 0, INFO: 0 },
    },
    checklist: [],
    panels: {
      runStatus: "DRAFT",
      topExceptions: [],
      varianceSummary: null,
      pendingApprovals: [],
      payoutReadiness: false,
      statutoryReadiness: {
        taxDeclarationsLocked: false,
        packComplianceChecklist: [],
      },
    },
    upcomingCalendarEvents: [],
  }),
};

const mockLoanAdjustmentsService = {
  createAdjustment: jest.fn().mockResolvedValue({ ok: true, id: 1 }),
};

const mockProfilesService = {
  listProfiles: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  getProfile: jest.fn().mockResolvedValue({ id: 1, userId: "u1" }),
  createProfile: jest.fn().mockResolvedValue({ id: 1 }),
  patchProfile: jest.fn().mockResolvedValue({ ok: true }),
  listHistory: jest.fn().mockResolvedValue([]),
};

const alwaysOnEntitlements = {
  isModuleEnabled: async (): Promise<boolean> => true,
  getModuleMap: async (): Promise<Record<string, boolean>> => ({}),
  getEffectiveModuleMap: async (): Promise<Record<string, boolean>> => ({}),
};

type Method = "get" | "post" | "patch" | "delete";

const allProtectedRoutes: ReadonlyArray<[Method, string]> = [
  ["post", "/payroll/runs"],
  ["get", "/payroll/runs"],
  ["get", "/payroll/runs/1"],
  ["post", "/payroll/runs/1/generate"],
  ["post", "/payroll/runs/1/recalculate"],
  ["get", "/payroll/runs/1/employees"],
  ["get", "/payroll/runs/1/employees/1"],
  ["get", "/payroll/runs/1/variance"],
  ["get", "/payroll/runs/1/exceptions"],
  ["patch", "/payroll/runs/1/exceptions/1/resolve"],
  ["patch", "/payroll/runs/1/exceptions/1/override"],
  ["get", "/payroll/runs/1/inputs"],
  ["patch", "/payroll/runs/1/inputs/1"],
  ["post", "/payroll/runs/1/inputs/reimport"],
  ["post", "/payroll/runs/1/loan-adjustments"],
  ["get", "/payroll/command-center"],
  ["get", "/payroll/employees"],
  ["get", "/payroll/employees/u1"],
  ["post", "/payroll/employees/u1/profiles"],
  ["patch", "/payroll/employees/u1/profiles/1"],
  ["get", "/payroll/employees/u1/history"],
];

async function buildApp(accessMock: typeof permittedAccess): Promise<INestApplication> {
  return createE2eApp({
    overrides: [
      { provide: AccessService, useValue: accessMock },
      { provide: EntitlementsService, useValue: alwaysOnEntitlements },
      { provide: RunsService, useValue: mockRunsService },
      { provide: GenerateService, useValue: mockGenerateService },
      { provide: GeneratePipelineService, useValue: mockGeneratePipelineService },
      { provide: ExceptionsService, useValue: mockExceptionsService },
      { provide: InputsService, useValue: mockInputsService },
      { provide: CommandCenterService, useValue: mockCommandCenterService },
      { provide: LoanAdjustmentsService, useValue: mockLoanAdjustmentsService },
      { provide: ProfilesService, useValue: mockProfilesService },
      { provide: PayrollCommandReceiptsService, useValue: mockCommandReceiptsService },
    ],
  });
}

describe("payroll-runs auth/RBAC — 401 (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it.each(allProtectedRoutes)("401 on %s %s without token", async (method, path) => {
    const res = await request(app.getHttpServer())[method](path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});

describe("payroll-runs RBAC — 403 when no permissions (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(forbiddenAccess); });
  afterAll(async () => app.close());

  const rbacProtectedRoutes: ReadonlyArray<[Method, string]> = [
    ["post", "/payroll/runs"],
    ["get", "/payroll/runs"],
    ["get", "/payroll/runs/1"],
    ["post", "/payroll/runs/1/generate"],
    ["post", "/payroll/runs/1/recalculate"],
    ["get", "/payroll/runs/1/employees"],
    ["get", "/payroll/runs/1/employees/1"],
    ["get", "/payroll/runs/1/variance"],
    ["get", "/payroll/runs/1/exceptions"],
    ["patch", "/payroll/runs/1/exceptions/1/resolve"],
    ["patch", "/payroll/runs/1/exceptions/1/override"],
    ["get", "/payroll/runs/1/inputs"],
    ["patch", "/payroll/runs/1/inputs/1"],
    ["post", "/payroll/runs/1/inputs/reimport"],
    ["post", "/payroll/runs/1/loan-adjustments"],
    ["get", "/payroll/command-center"],
    ["get", "/payroll/employees"],
    ["get", "/payroll/employees/u1"],
    ["post", "/payroll/employees/u1/profiles"],
    ["patch", "/payroll/employees/u1/profiles/1"],
    ["get", "/payroll/employees/u1/history"],
  ];

  it.each(rbacProtectedRoutes)("403 on %s %s with empty permission map", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())[method](path)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});

describe("payroll-runs RBAC — manage routes blocked for view-only (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(viewOnlyAccess); });
  afterAll(async () => app.close());

  it("POST /payroll/runs → 403 for view-only (requires payroll:runs:update)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ month: "2026-07" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("POST /payroll/runs/1/generate → 403 for view-only (requires payroll:runs:manage)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs/1/generate")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("POST /payroll/runs/1/recalculate → 403 for view-only (requires payroll:runs:manage)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs/1/recalculate")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("PATCH /payroll/runs/1/exceptions/1/override → 403 for view-only (requires payroll:runs:manage)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .patch("/payroll/runs/1/exceptions/1/override")
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "overriding" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});

describe("payroll-runs RBAC — 200 for permitted caller (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/runs → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/runs")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/runs/1 → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/runs/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/runs/1/employees → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/runs/1/employees")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/runs/1/exceptions → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/runs/1/exceptions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/command-center → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/command-center")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("POST /payroll/runs → 201 with valid month and mocked service returning ok", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ month: "2026-08" });
    expect(res.status).toBe(201);
  });
});
