import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { createE2eApp } from "test/helpers/e2e-app";
import { AccessService } from "../../access/access.service";
import { EntitlementsService } from "../../access/entitlements.service";
import { ReportsService } from "./reports.service";
import { JournalService } from "./journal.service";
import { FnfInsightsService } from "./fnf.service";
import { TaxWindowsService } from "./tax-windows.service";
import { EssService } from "./ess.service";
import { AccountingMappingsService } from "./accounting-mappings.service";
import { CalendarService } from "./calendar.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { withAccessResolution } from "../../../../test/helpers/access-stub";

const ALL_INSIGHTS_PERMS = new Map([
  ["payroll:reports:view", "all"],
  ["payroll:reports:export", "all"],
  ["payroll:fnf:view", "all"],
  ["payroll:fnf:manage", "all"],
  ["payroll:tax:view", "all"],
  ["payroll:tax:manage", "all"],
  ["payroll:runs:view", "all"],
  ["payroll:settings:manage", "all"],
  ["self:payroll", "all"],
  ["self:payslips", "all"],
]);

const permittedAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(ALL_INSIGHTS_PERMS),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const forbiddenAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const mockSummary = {
  run: { month: "2026-07", status: "DRAFT", employeeCount: 0, grossTotal: "0.00", deductionTotal: "0.00", netTotal: "0.00", employerCostTotal: "0.00", exceptionCount: 0 },
};
const mockRegister = { rows: [], columns: [] };
const mockRows = { rows: [] };
const mockVariance = { perEmployee: [] };
const mockJournal = { lines: [], totalDebit: "0.00", totalCredit: "0.00" };
const mockFnfList = [{ id: 1, status: "DRAFT", userId: "u1" }];
const mockFnfItem = { id: 1, status: "DRAFT" };
const mockFnfStatement = { lines: [], total: "0.00" };
const mockWindow = { id: 1, financialYear: "2026-27", status: "UPCOMING" };
const mockMappingList = [{ id: 1, ledgerName: "Salary" }];
const mockCalendarEvents = [{ id: 1, type: "PREVIEW", date: "2026-07-28" }];

const mockReportsService = {
  getSummary: jest.fn().mockResolvedValue(mockSummary),
  getRegister: jest.fn().mockResolvedValue(mockRegister),
  getDepartmentCost: jest.fn().mockResolvedValue(mockRows),
  getCostCenter: jest.fn().mockResolvedValue(mockRows),
  getEarnings: jest.fn().mockResolvedValue({ rows: [], columns: [] }),
  getDeductions: jest.fn().mockResolvedValue({ rows: [], columns: [] }),
  getReimbursements: jest.fn().mockResolvedValue({ rows: [], columns: [] }),
  getTax: jest.fn().mockResolvedValue({ rows: [], columns: [] }),
  getBankPayout: jest.fn().mockResolvedValue({ batches: [] }),
  getVariance: jest.fn().mockResolvedValue(mockVariance),
};

const mockJournalService = {
  buildJournal: jest.fn().mockResolvedValue(mockJournal),
};

const mockFnfService = {
  list: jest.fn().mockResolvedValue(mockFnfList),
  getOne: jest.fn().mockResolvedValue(mockFnfItem),
  approve: jest.fn().mockResolvedValue(mockFnfItem),
  getStatement: jest.fn().mockResolvedValue(mockFnfStatement),
};

const mockTaxWindowsService = {
  list: jest.fn().mockResolvedValue([mockWindow]),
  create: jest.fn().mockResolvedValue(mockWindow),
  update: jest.fn().mockResolvedValue(mockWindow),
};

const mockEssService = {
  getOverview: jest.fn().mockResolvedValue({ balance: "0.00", ytdGross: "0.00" }),
  getPayslips: jest.fn().mockResolvedValue([]),
  getSalaryStructure: jest.fn().mockResolvedValue({ components: [] }),
  listReimbursements: jest.fn().mockResolvedValue([]),
  createReimbursement: jest.fn().mockResolvedValue({ id: 1 }),
  listLoans: jest.fn().mockResolvedValue([]),
  createLoan: jest.fn().mockResolvedValue({ id: 1 }),
  getTaxDeclaration: jest.fn().mockResolvedValue(null),
  submitTaxDeclaration: jest.fn().mockResolvedValue({ id: 1 }),
  addTaxProof: jest.fn().mockResolvedValue({ id: 1 }),
  getBankDetails: jest.fn().mockResolvedValue({ accountNumber: "***1234", ifsc: "SBIN0001" }),
  updateBankDetails: jest.fn().mockResolvedValue({ ok: true }),
  getOwnFnf: jest.fn().mockResolvedValue(null),
};

const mockAccountingMappingsService = {
  list: jest.fn().mockResolvedValue(mockMappingList),
  create: jest.fn().mockResolvedValue({ id: 1 }),
  update: jest.fn().mockResolvedValue({ id: 1 }),
  remove: jest.fn().mockResolvedValue({ ok: true }),
};

const mockCalendarService = {
  list: jest.fn().mockResolvedValue(mockCalendarEvents),
  generateMonth: jest.fn().mockResolvedValue({ generated: 0 }),
  create: jest.fn().mockResolvedValue({ id: 1 }),
  update: jest.fn().mockResolvedValue({ id: 1 }),
  remove: jest.fn().mockResolvedValue({ ok: true }),
};

const mockDrizzle = {
  __client: { end: jest.fn().mockResolvedValue(undefined) },
  execute: jest.fn().mockResolvedValue([]),
  transaction: jest.fn().mockImplementation(
    async (fn: (tx: { execute: jest.Mock }) => Promise<unknown>) =>
      fn({ execute: jest.fn().mockResolvedValue([]) }),
  ),
  select: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      leftJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    }),
  }),
  update: jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1, status: "VERIFIED" }]) }),
    }),
  }),
  query: {
    taxDeclarations: { findFirst: jest.fn().mockResolvedValue(null) },
    organizations: { findFirst: jest.fn().mockResolvedValue({ mfaEnforced: false }) },
    users: { findFirst: jest.fn().mockResolvedValue({ totpEnabled: false }) },
  },
};

const alwaysOnEntitlements = {
  isModuleEnabled: async (): Promise<boolean> => true,
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
  getModuleMap: async (): Promise<Record<string, boolean>> => ({}),
  getEffectiveModuleMap: async (): Promise<Record<string, boolean>> => ({}),
};

type Method = "get" | "post" | "patch" | "delete";

async function buildApp(accessMock: typeof permittedAccess): Promise<INestApplication> {
  return createE2eApp({
    overrides: [
      { provide: AccessService, useValue: accessMock },
      { provide: EntitlementsService, useValue: alwaysOnEntitlements },
      { provide: ReportsService, useValue: mockReportsService },
      { provide: JournalService, useValue: mockJournalService },
      { provide: FnfInsightsService, useValue: mockFnfService },
      { provide: TaxWindowsService, useValue: mockTaxWindowsService },
      { provide: EssService, useValue: mockEssService },
      { provide: AccountingMappingsService, useValue: mockAccountingMappingsService },
      { provide: CalendarService, useValue: mockCalendarService },
      { provide: DRIZZLE, useValue: mockDrizzle },
    ],
  });
}

describe("payroll-insights auth/RBAC — 401 (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/payroll/reports/summary"],
    ["get", "/payroll/reports/register"],
    ["get", "/payroll/reports/department-cost"],
    ["get", "/payroll/reports/variance"],
    ["get", "/payroll/reports/journal"],
    ["get", "/payroll/fnf"],
    ["get", "/payroll/fnf/1"],
    ["post", "/payroll/fnf/1/approve"],
    ["get", "/payroll/tax-windows"],
    ["post", "/payroll/tax-windows"],
    ["patch", "/payroll/tax-windows/1"],
    ["get", "/payroll/tax/declarations"],
    ["patch", "/payroll/tax/declarations/1/approve"],
    ["get", "/payroll/accounting-mappings"],
    ["get", "/payroll/calendar"],
    ["get", "/payroll/me/overview"],
    ["get", "/payroll/me/payslips"],
    ["get", "/payroll/me/loans"],
    ["get", "/payroll/me/tax-declaration"],
    ["get", "/payroll/me/bank"],
  ];

  it.each(protectedRoutes)("401 on %s %s without token", async (method, path) => {
    const res = await request(app.getHttpServer())[method](path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});

describe("payroll-insights RBAC — 403 when no permissions (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(forbiddenAccess); });
  afterAll(async () => app.close());

  const rbacRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/payroll/reports/summary"],
    ["get", "/payroll/reports/register"],
    ["get", "/payroll/reports/department-cost"],
    ["get", "/payroll/reports/variance"],
    ["get", "/payroll/reports/journal"],
    ["get", "/payroll/fnf"],
    ["get", "/payroll/fnf/1"],
    ["post", "/payroll/fnf/1/approve"],
    ["get", "/payroll/tax-windows"],
    ["post", "/payroll/tax-windows"],
    ["patch", "/payroll/tax-windows/1"],
    ["get", "/payroll/tax/declarations"],
    ["patch", "/payroll/tax/declarations/1/approve"],
    ["get", "/payroll/accounting-mappings"],
    ["get", "/payroll/calendar"],
  ];

  it.each(rbacRoutes)("403 on %s %s with empty permission map", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())[method](path)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});

describe("payroll-insights ESS — auth-only routes (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/me/overview → 200 with valid JWT (no RBAC needed)", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/me/overview")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/me/payslips → 200 with valid JWT", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/me/payslips")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/me/loans → 200 with valid JWT", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/me/loans")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/me/tax-declaration → 200 with valid JWT", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/me/tax-declaration")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/me/bank → 200 with valid JWT", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/me/bank")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("ESS data isolation: /payroll/me/* returns only caller data (same service, different user contexts)", async () => {
    const tokenA = await signToken({ sub: "userA", userId: "userA" } as Parameters<typeof signToken>[0]);
    const tokenB = await signToken({ sub: "userB", userId: "userB" } as Parameters<typeof signToken>[0]);

    mockEssService.getPayslips.mockResolvedValueOnce([{ id: 1, userId: "userA" }]);
    const resA = await request(app.getHttpServer())
      .get("/payroll/me/payslips")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(resA.status).toBe(200);
    expect(mockEssService.getPayslips).toHaveBeenLastCalledWith(expect.any(String), "userA");

    mockEssService.getPayslips.mockResolvedValueOnce([{ id: 2, userId: "userB" }]);
    const resB = await request(app.getHttpServer())
      .get("/payroll/me/payslips")
      .set("Authorization", `Bearer ${tokenB}`);
    expect(resB.status).toBe(200);
    expect(mockEssService.getPayslips).toHaveBeenLastCalledWith(expect.any(String), "userB");
  });
});

describe("payroll-insights RBAC — 200 for permitted caller (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/reports/summary → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/reports/summary?month=2026-07")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/reports/journal → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/reports/journal?month=2026-07")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/fnf → 200 with payroll:fnf:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/fnf")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/tax-windows → 200 with payroll:tax:manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/tax-windows")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/tax/declarations → 200 with payroll:tax:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/tax/declarations")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/calendar → 200 with payroll:runs:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/calendar")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("payroll-insights — export requires payroll:reports:export (e2e)", () => {
  let app: INestApplication;

  const exportBlockedAccess = withAccessResolution({
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([
      ["payroll:reports:view", "all"],
    ])),
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
  });

  beforeAll(async () => { app = await buildApp(exportBlockedAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/reports/summary?format=csv → 403 without payroll:reports:export", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/payroll/reports/summary?format=csv&month=2026-07")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("GET /payroll/reports/register → 200 (view access is enough for json format)", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/reports/register?month=2026-07")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("payroll-insights — FnF requires payroll:fnf:view (e2e)", () => {
  let app: INestApplication;

  const noFnfAccess = withAccessResolution({
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([
      ["payroll:reports:view", "all"],
    ])),
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
  });

  beforeAll(async () => { app = await buildApp(noFnfAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/fnf → 403 for caller without payroll:fnf:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/payroll/fnf")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});
