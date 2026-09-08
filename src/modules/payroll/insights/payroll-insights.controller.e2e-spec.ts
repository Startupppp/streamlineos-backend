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
import { EssSelfServiceService } from "./ess-self-service.service";
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
const mockFnfRow = {
  id: 1,
  orgId: "org1",
  userId: "u1",
  resignationId: null,
  basicDues: "0.00",
  leaveEncashment: "0.00",
  bonusDue: "0.00",
  deductions: "0.00",
  loanRecovery: "0.00",
  netPayable: "0.00",
  status: "DRAFT",
  userMembershipId: null,
  approvedBy: null,
  notes: null,
  reimbursementsDue: "0.00",
  assetRecovery: "0.00",
  noticeRecovery: "0.00",
  otherDeductions: "0.00",
  statementPublishedAt: null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  user: { name: "Test User", email: "test@example.com" },
};
const mockFnfList = { items: [mockFnfRow], total: 1, page: 1, totalPages: 1 };
const mockFnfItem = {
  id: 1,
  orgId: "org1",
  userId: "u1",
  basicDues: "0.00",
  leaveEncashment: "0.00",
  bonusDue: "0.00",
  deductions: "0.00",
  loanRecovery: "0.00",
  netPayable: "0.00",
  status: "DRAFT",
  approvedBy: null,
  notes: null,
  reimbursementsDue: "0.00",
  assetRecovery: "0.00",
  noticeRecovery: "0.00",
  otherDeductions: "0.00",
  statementPublishedAt: null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  userName: "Test User",
  userEmail: "test@example.com",
};
const mockFnfStatement = {
  settlementId: 1,
  employee: { id: "u1", name: "Test User", email: "test@example.com" },
  components: [],
  netPayable: "0.00",
  status: "DRAFT",
};
const mockWindow = {
  id: 1,
  orgId: "org1",
  financialYear: "2026-27",
  opensAt: new Date("2026-04-01T00:00:00.000Z"),
  closesAt: new Date("2027-03-31T00:00:00.000Z"),
  proofDeadline: null,
  lockDate: null,
  status: "UPCOMING",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const mockMappingList = [{ id: 1, ledgerName: "Salary" }];
const mockCalendarEvents = [{ id: 1, orgId: "org1", month: "2026-07", type: "PREVIEW", date: "2026-07-28", title: "Preview run", status: "SCHEDULED" }];

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

const mockEssOverview = {
  toggles: {},
  capabilities: {
    mode: "employee_self_service" as const,
    honestyNote: "Illustrative only.",
    canViewSalaryStructure: true,
    canUpdateBank: true,
    canRequestLoans: true,
    canDeclareTax: true,
    canClaimReimbursements: true,
  },
  latestPayslip: null,
  nextPayDate: null,
  ytd: { gross: "0.00", net: "0.00" },
  activeLoanBalance: "0.00",
  pendingReimbursementsCount: 0,
  taxWindow: null,
  declarationStatus: null,
  actionRequired: [],
};

const mockEssService = {
  getOverview: jest.fn().mockResolvedValue(mockEssOverview),
  getPayslips: jest.fn().mockResolvedValue([]),
  getSalaryStructure: jest.fn().mockResolvedValue({ components: [] }),
  getOwnFnf: jest.fn().mockResolvedValue(null),
  getActiveToggles: jest.fn().mockResolvedValue({
    essAllowLoanRequests: true,
    essAllowTaxDeclarations: true,
    essAllowBankUpdate: true,
    essAllowReimbursements: true,
    essShowSalaryStructure: true,
  }),
  getActiveWindow: jest.fn().mockResolvedValue(null),
};

const mockEssSelfServiceService = {
  listReimbursements: jest.fn().mockResolvedValue([]),
  createReimbursement: jest.fn().mockResolvedValue({ id: 1 }),
  listLoans: jest.fn().mockResolvedValue([]),
  createLoan: jest.fn().mockResolvedValue({ id: 1 }),
  getTaxDeclaration: jest.fn().mockResolvedValue({ windowStatus: null, declaration: null, proofs: [] }),
  submitTaxDeclaration: jest.fn().mockResolvedValue({ id: 1 }),
  addTaxProof: jest.fn().mockResolvedValue({ id: 1 }),
  getBankDetails: jest.fn().mockResolvedValue({ hasBank: false, masked: null }),
  updateBankDetails: jest.fn().mockResolvedValue({ ok: true }),
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

const QUERY_CHAIN_METHODS = [
  "from", "leftJoin", "innerJoin", "rightJoin", "fullJoin", "where",
  "orderBy", "limit", "offset", "groupBy", "having", "for",
] as const;

function queryChain(rows: unknown[] = []): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const method of QUERY_CHAIN_METHODS) node[method] = jest.fn(() => node);
  node["then"] = (resolve: (value: unknown) => unknown) => resolve(rows);
  return node;
}

const mockDrizzle = {
  __client: { end: jest.fn().mockResolvedValue(undefined) },
  execute: jest.fn().mockResolvedValue([]),
  transaction: jest.fn().mockImplementation(
    async (fn: (tx: { execute: jest.Mock }) => Promise<unknown>) =>
      fn({ execute: jest.fn().mockResolvedValue([]) }),
  ),
  select: jest.fn(() => queryChain()),
  selectDistinct: jest.fn(() => queryChain()),
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
      { provide: EssSelfServiceService, useValue: mockEssSelfServiceService },
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

    mockEssService.getPayslips.mockResolvedValueOnce([
      { publicationId: 1, month: "2026-06", net: "5000.00", publishedAt: new Date("2026-07-01T00:00:00.000Z"), downloadHref: "/payroll/me/payslips/1/download" },
    ]);
    const resA = await request(app.getHttpServer())
      .get("/payroll/me/payslips")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(resA.status).toBe(200);
    expect(resA.body).toEqual([
      expect.objectContaining({ publicationId: 1, downloadHref: "/payroll/me/payslips/1/download" }),
    ]);
    expect(mockEssService.getPayslips).toHaveBeenLastCalledWith(expect.any(String), "userA", 1);

    mockEssService.getPayslips.mockResolvedValueOnce([
      { publicationId: 2, month: "2026-06", net: "6000.00", publishedAt: new Date("2026-07-01T00:00:00.000Z"), downloadHref: "/payroll/me/payslips/2/download" },
    ]);
    const resB = await request(app.getHttpServer())
      .get("/payroll/me/payslips")
      .set("Authorization", `Bearer ${tokenB}`);
    expect(resB.status).toBe(200);
    expect(resB.body).toEqual([
      expect.objectContaining({ publicationId: 2, downloadHref: "/payroll/me/payslips/2/download" }),
    ]);
    expect(mockEssService.getPayslips).toHaveBeenLastCalledWith(expect.any(String), "userB", 1);
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

/**
 * Every /payroll/reports/* handler serves the on-screen report and its CSV from
 * the SAME route. The class-level decorator can only declare one key, so it
 * declares the weaker one — `payroll:reports:view` — and each handler raises the
 * bar to `payroll:reports:export` inside the `format === "csv"` branch. A static
 * reader of the decorators therefore sees only `:view` and concludes the CSV is
 * unguarded; it is not, and this table is the proof. Every CSV route is asserted
 * in BOTH directions, because a one-directional assertion would still pass if
 * the in-handler check were deleted.
 */
const CSV_REPORT_ROUTES: readonly string[] = [
  "/payroll/reports/summary",
  "/payroll/reports/register",
  "/payroll/reports/department-cost",
  "/payroll/reports/cost-center",
  "/payroll/reports/earnings",
  "/payroll/reports/deductions",
  "/payroll/reports/reimbursements",
  "/payroll/reports/tax",
  "/payroll/reports/bank-payout",
  "/payroll/reports/variance",
  "/payroll/reports/journal",
];

describe("payroll-insights — CSV export requires payroll:reports:export (e2e)", () => {
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

  it("covers every CSV-capable report route", () => {
    expect(CSV_REPORT_ROUTES).toHaveLength(11);
  });

  it.each(CSV_REPORT_ROUTES)(
    "GET %s?format=csv → 403 for a payroll:reports:view-only holder",
    async (path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .get(`${path}?format=csv&month=2026-07`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
      expect(res.headers["content-type"]).not.toContain("text/csv");
    },
  );

  it.each(CSV_REPORT_ROUTES)(
    "GET %s → 200 JSON for a payroll:reports:view-only holder",
    async (path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .get(`${path}?month=2026-07`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
    },
  );
});

describe("payroll-insights — CSV export succeeds for a payroll:reports:export holder (e2e)", () => {
  let app: INestApplication;

  const exportAllowedAccess = withAccessResolution({
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([
      ["payroll:reports:view", "all"],
      ["payroll:reports:export", "all"],
    ])),
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
  });

  beforeAll(async () => { app = await buildApp(exportAllowedAccess); });
  afterAll(async () => app.close());

  it.each(CSV_REPORT_ROUTES)(
    "GET %s?format=csv → 200 text/csv with the export key",
    async (path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .get(`${path}?format=csv&month=2026-07`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("attachment;");
    },
  );

  it.each(CSV_REPORT_ROUTES)(
    "GET %s → 200 JSON with the export key",
    async (path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .get(`${path}?month=2026-07`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
    },
  );
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
